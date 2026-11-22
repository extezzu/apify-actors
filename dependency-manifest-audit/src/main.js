import { Actor, log } from 'apify';

const UA = 'dependency-manifest-audit-apify-actor/1.0 (public registry metadata lookup)';
const EVENT = 'dependency-checked';

// ---------- helpers ----------
async function getJson(url, { method = 'GET', body, retries = 2 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                method,
                headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(30000),
            });
            if (res.status === 404) return { notFound: true };
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { data: await res.json() };
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw lastErr;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.internal|metadata\.google\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i;
function assertPublicHttpUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are allowed');
    if (PRIVATE_HOST.test(u.hostname)) throw new Error('private/local hosts are not allowed');
}

async function getText(url) {
    assertPublicHttpUrl(url);
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('Manifest too large');
    return text;
}

export function firstVersion(spec) {
    const m = String(spec || '').match(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][0-9A-Za-z.-]+)?/);
    if (!m) return null;
    const num = (v) => (v && /^\d+$/.test(v) ? v : '0');
    return `${m[1]}.${num(m[2])}.${num(m[3])}`;
}

function parts(v) {
    return String(v).split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
}

export function outdatedLevel(base, latest) {
    if (!base || !latest) return 'unknown';
    const a = parts(base);
    const b = parts(latest);
    if (b[0] > a[0]) return 'major';
    if (b[0] === a[0] && b[1] > a[1]) return 'minor';
    if (b[0] === a[0] && b[1] === a[1] && b[2] > a[2]) return 'patch';
    return 'none';
}

const COPYLEFT = /(^|[^L])GPL|AGPL|SSPL|EUPL|CC-BY-(NC|SA)/i;

// ---------- manifest parsing ----------
export function parsePackageJson(text, includeDev) {
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error(`package.json is not valid JSON: ${e.message}`);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('package.json must be a JSON object.');
    }
    const sections = ['dependencies', 'peerDependencies'];
    if (includeDev) sections.push('devDependencies', 'optionalDependencies');
    const out = [];
    for (const s of sections) {
        const block = json[s];
        if (block == null) continue;
        if (typeof block !== 'object' || Array.isArray(block)) {
            log.warning(`Ignoring "${s}": expected an object of name -> version.`);
            continue;
        }
        for (const [name, spec] of Object.entries(block)) {
            out.push({ ecosystem: 'npm', name, requested: String(spec), section: s });
        }
    }
    return out;
}

export function parseRequirements(text) {
    const out = [];
    for (let line of text.split(/\r?\n/)) {
        line = line.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#') || line.startsWith('-') || /^(git\+|https?:|file:|\.|\/)/i.test(line)) continue;
        line = line.split(';')[0].split(' --hash')[0].trim();
        const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/);
        if (!m) continue;
        out.push({ ecosystem: 'pypi', name: m[1], requested: m[2].replace(/\s+/g, '') || '*', section: 'requirements' });
    }
    return out;
}

function parseExtra(entry) {
    const m = String(entry).trim().match(/^(npm|pypi):(@?[^@=\s]+)(?:[@=]{1,2}(.+))?$/i);
    if (!m) return null;
    return { ecosystem: m[1].toLowerCase(), name: m[2], requested: m[3] || '*', section: 'extra' };
}

// ---------- registry lookups ----------
async function lookupNpm(dep) {
    const enc = dep.name.startsWith('@') ? `@${encodeURIComponent(dep.name.slice(1))}` : encodeURIComponent(dep.name);
    const { data, notFound } = await getJson(`https://registry.npmjs.org/${enc.replace('%40', '@')}`);
    if (notFound) return { error: 'not-found-on-registry' };
    const latest = data['dist-tags']?.latest;
    const lv = data.versions?.[latest] || {};
    let license = lv.license ?? data.license ?? null;
    if (license && typeof license === 'object') license = license.type || JSON.stringify(license);
    const repo = typeof lv.repository === 'string' ? lv.repository : lv.repository?.url || data.repository?.url || null;
    let weeklyDownloads = null;
    try {
        const dl = await getJson(`https://api.npmjs.org/downloads/point/last-week/${dep.name}`);
        weeklyDownloads = dl.data?.downloads ?? null;
    } catch {
        /* optional */
    }
    return {
        latestVersion: latest,
        license: license || null,
        deprecated: Boolean(lv.deprecated),
        deprecationMessage: lv.deprecated || null,
        lastPublish: data.time?.[latest] || null,
        weeklyDownloads,
        repository: repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null,
        registryUrl: `https://www.npmjs.com/package/${dep.name}`,
    };
}

async function lookupPypi(dep) {
    const { data, notFound } = await getJson(`https://pypi.org/pypi/${encodeURIComponent(dep.name)}/json`);
    if (notFound) return { error: 'not-found-on-registry' };
    const info = data.info || {};
    const files = data.urls || [];
    const lastPublish = files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort().pop() || null;
    let license = info.license_expression || (info.license && info.license.length < 80 ? info.license : null);
    if (!license) {
        const c = (info.classifiers || []).find((x) => x.startsWith('License ::'));
        if (c) license = c.split('::').pop().trim();
    }
    const inactive = (info.classifiers || []).some((c) => c.startsWith('Development Status :: 7'));
    const urls = info.project_urls || {};
    return {
        latestVersion: info.version,
        license: license || null,
        deprecated: inactive,
        deprecationMessage: inactive ? 'Marked "Development Status :: 7 - Inactive"' : null,
        lastPublish,
        weeklyDownloads: null,
        repository: urls.Source || urls.Repository || urls.Homepage || info.home_page || null,
        registryUrl: `https://pypi.org/project/${dep.name}/`,
    };
}

async function lookupVulns(items) {
    // items: [{ecosystem, name, version}]
    const eco = { npm: 'npm', pypi: 'PyPI' };
    const result = new Map();
    const chunk = 100;
    for (let i = 0; i < items.length; i += chunk) {
        const slice = items.slice(i, i + chunk);
        const { data } = await getJson('https://api.osv.dev/v1/querybatch', {
            method: 'POST',
            body: { queries: slice.map((s) => ({ package: { name: s.name, ecosystem: eco[s.ecosystem] }, version: s.version })) },
        });
        slice.forEach((s, idx) => result.set(`${s.ecosystem}:${s.name}`, (data.results?.[idx]?.vulns || []).map((v) => v.id)));
    }
    return result;
}

// ---------- risk ----------
function score(row, staleAfterDays) {
    const flags = [];
    let s = 0;
    if (row.deprecated) { s += 40; flags.push('deprecated'); }
    if (row.vulnerabilityCount > 0) { s += Math.min(50, 25 + row.vulnerabilityCount * 5); flags.push('known-vulnerabilities'); }
    if (row.outdated === 'major') { s += 15; flags.push('major-version-behind'); }
    else if (row.outdated === 'minor') { s += 5; flags.push('minor-version-behind'); }
    if (row.daysSinceLastPublish != null && row.daysSinceLastPublish > staleAfterDays) { s += 20; flags.push('stale-no-recent-release'); }
    if (!row.license) { s += 10; flags.push('license-missing'); }
    else if (COPYLEFT.test(row.license)) { s += 5; flags.push('copyleft-license-review'); }
    row.riskScore = Math.min(100, s);
    row.riskLevel = s >= 40 ? 'high' : s >= 15 ? 'medium' : 'low';
    row.riskFlags = flags;
}

async function pool(items, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: size }, async () => {
        while (i < items.length) {
            const idx = i++;
            await fn(items[idx], idx);
        }
    }));
}

// ---------- main ----------
await Actor.init();
try {
    const input = (await Actor.getInput()) || {};
    const {
        packageJson,
        requirementsTxt,
        manifestUrls = [],
        packages = [],
        includeDevDependencies = true,
        checkVulnerabilities = true,
        staleAfterDays = 730,
        maxDependencies = 200,
    } = input;

    let deps = [];
    if (packageJson?.trim()) deps.push(...parsePackageJson(packageJson, includeDevDependencies));
    if (requirementsTxt?.trim()) deps.push(...parseRequirements(requirementsTxt));
    if (manifestUrls.length > 20) log.warning(`Only the first 20 manifestUrls are read (got ${manifestUrls.length}).`);
    for (const url of manifestUrls.slice(0, 20)) {
        try {
            const text = await getText(url);
            const file = url.split('?')[0].split('/').pop().toLowerCase();
            if (file.endsWith('.json')) deps.push(...parsePackageJson(text, includeDevDependencies));
            else if (file.endsWith('.txt')) deps.push(...parseRequirements(text));
            else log.warning(`Unsupported manifest file name (need package.json or *.txt): ${url}`);
        } catch (e) {
            log.warning(`Could not load manifest ${url}: ${e.message}`);
        }
    }
    for (const e of packages) {
        const d = parseExtra(e);
        if (d) deps.push(d);
        else log.warning(`Ignoring invalid extra package "${e}"`);
    }
    if (!deps.length) {
        throw new Error('No dependencies found. Provide packageJson, requirementsTxt, manifestUrls or packages.');
    }

    // de-duplicate
    const seen = new Set();
    deps = deps.filter((d) => {
        const k = `${d.ecosystem}:${d.name.toLowerCase()}:${d.requested}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    if (deps.length > maxDependencies) {
        log.warning(`Found ${deps.length} dependencies, analysing the first ${maxDependencies} (maxDependencies).`);
        deps = deps.slice(0, maxDependencies);
    }
    log.info(`Analysing ${deps.length} dependencies...`);

    const rows = new Array(deps.length);
    await pool(deps, 5, async (dep, idx) => {
        const base = { ecosystem: dep.ecosystem, name: dep.name, requested: dep.requested, section: dep.section };
        const validName = dep.ecosystem === 'npm'
            ? /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(dep.name) && dep.name.length <= 214
            : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dep.name) && dep.name.length <= 214;
        if (!validName) {
            rows[idx] = { ...base, status: 'error', note: 'invalid-package-name' };
            return;
        }
        const nonRegistry = /^(git|github:|file:|link:|workspace:|https?:|npm:|\.|\/)/i.test(dep.requested);
        if (nonRegistry) {
            rows[idx] = { ...base, status: 'skipped', note: 'Non-registry specifier (git/file/url/alias/workspace), not audited.' };
            return;
        }
        try {
            const meta = dep.ecosystem === 'npm' ? await lookupNpm(dep) : await lookupPypi(dep);
            if (meta.error) {
                rows[idx] = { ...base, status: 'error', note: meta.error };
                return;
            }
            const exact = dep.ecosystem === 'pypi' ? (dep.requested.match(/^={2,3}(\d[^,]*)$/) || [])[1] : null;
            const baseline = exact || (dep.requested === '*' || dep.requested === 'latest' ? null : firstVersion(dep.requested));
            const days = meta.lastPublish ? Math.floor((Date.now() - Date.parse(meta.lastPublish)) / 86400000) : null;
            rows[idx] = {
                ...base,
                status: 'ok',
                baselineVersion: baseline,
                latestVersion: meta.latestVersion,
                outdated: outdatedLevel(baseline, meta.latestVersion),
                deprecated: meta.deprecated,
                deprecationMessage: meta.deprecationMessage,
                license: meta.license,
                lastPublish: meta.lastPublish,
                daysSinceLastPublish: days,
                isStale: days != null ? days > staleAfterDays : null,
                weeklyDownloads: meta.weeklyDownloads,
                repository: meta.repository,
                registryUrl: meta.registryUrl,
                vulnerabilityCount: null,
                vulnerabilityIds: [],
            };
        } catch (e) {
            rows[idx] = { ...base, status: 'error', note: `Lookup failed: ${e.message}` };
        }
    });

    // vulnerabilities
    let vulnStatus = 'disabled';
    if (checkVulnerabilities) {
        const targets = rows.filter((r) => r.status === 'ok' && r.baselineVersion).map((r) => ({ ecosystem: r.ecosystem, name: r.name, version: r.baselineVersion }));
        try {
            const map = await lookupVulns(targets);
            for (const r of rows) {
                if (r.status === 'ok' && map.has(`${r.ecosystem}:${r.name}`)) {
                    r.vulnerabilityIds = map.get(`${r.ecosystem}:${r.name}`);
                    r.vulnerabilityCount = r.vulnerabilityIds.length;
                }
            }
            vulnStatus = 'ok';
        } catch (e) {
            vulnStatus = `unavailable: ${e.message}`;
            log.warning(`OSV.dev vulnerability lookup failed, continuing without it: ${e.message}`);
        }
    }

    let charged = 0;
    let limitReached = false;
    const summary = { total: rows.length, ok: 0, skipped: 0, errors: 0, high: 0, medium: 0, low: 0, deprecated: 0, vulnerable: 0, outdatedMajor: 0, stale: 0, vulnerabilityLookup: vulnStatus };
    for (const r of rows) {
        if (r.status === 'ok') {
            score(r, staleAfterDays);
            summary.ok++;
            summary[r.riskLevel]++;
            if (r.deprecated) summary.deprecated++;
            if (r.vulnerabilityCount > 0) summary.vulnerable++;
            if (r.outdated === 'major') summary.outdatedMajor++;
            if (r.isStale) summary.stale++;
        } else if (r.status === 'skipped') summary.skipped++;
        else summary.errors++;
    }
    rows.sort((a, b) => (b.riskScore ?? -1) - (a.riskScore ?? -1));

    let delivered = 0;
    for (const r of rows) {
        if (r.status === 'ok') {
            if (limitReached) continue; // paid rows beyond the user's max charge are not delivered
            // Pay-per-event: one `dependency-checked` event per successfully audited dependency.
            const res = await Actor.pushData(r, EVENT);
            charged++;
            delivered++;
            if (res && res.eventChargeLimitReached) {
                limitReached = true;
                log.warning('Max charge limit reached, stopping.');
            }
        } else {
            await Actor.pushData(r); // skipped/error rows are free
        }
    }
    summary.chargedEvents = charged;
    summary.deliveredRows = delivered;
    summary.stoppedByMaxChargeLimit = limitReached;
    await Actor.setValue('OUTPUT', summary);
    log.info('Summary', summary);
    await Actor.setStatusMessage(limitReached
        ? `Stopped at the max charge limit after ${charged} dependencies (of ${summary.ok} analysed). Raise the max cost per run to get the rest.`
        : `Audited ${summary.ok} dependencies: ${summary.high} high, ${summary.medium} medium, ${summary.low} low risk.`);
} catch (e) {
    log.error(e.message);
    await Actor.fail(e.message);
}
await Actor.exit();
