import { gunzipSync } from 'node:zlib';
import { Actor, log } from 'apify';

const UA = 'sitemap-url-validator-apify-actor/1.0 (sitemap health check; respects robots.txt)';
const EVENT = 'url-checked';
const MAX_REDIRECTS = 5;
const MAX_NESTED_SITEMAPS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_DELAY_MS = 300; // per worker, after every request (keeps total rate low even at max concurrency)
const MAX_SITES = 50;
const MAX_REQUEST_ABS = 20000;

// Block non-http(s) and loopback/private/link-local/metadata targets (SSRF + abuse protection).
// SITEMAP_VALIDATOR_ALLOW_PRIVATE is only for local testing and is never set on the platform.
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.internal|.*\.local|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1?\]?$|fc|fd|fe80))/i;
export function assertPublicHttpUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are supported');
    if (!process.env.SITEMAP_VALIDATOR_ALLOW_PRIVATE && PRIVATE_HOST.test(u.hostname)) throw new Error('private/local hosts are not allowed');
    return u;
}
const hostKey = (h) => h.toLowerCase().replace(/^www\./, '');

async function fetchBuf(url, { timeout = 30000, allowStatus = false } = {}) {
    assertPublicHttpUrl(url);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    if (allowStatus) {
        const b = Buffer.from(await res.arrayBuffer());
        return { status: res.status, buf: b.length > 5_000_000 ? b.subarray(0, 5_000_000) : b };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 50_000_000) throw new Error('File too large');
    return buf;
}

async function fetchXml(url) {
    let buf = await fetchBuf(url);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf, { maxOutputLength: 100_000_000 });
    return buf.toString('utf8');
}

function decodeXml(s) {
    return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

export function parseSitemap(xml) {
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const tag = isIndex ? 'sitemap' : 'url';
    const out = [];
    const re = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml))) {
        const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[1]);
        if (!loc) continue;
        const lm = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(m[1]);
        out.push({ loc: decodeXml(loc[1]), lastmod: lm ? decodeXml(lm[1]) : null });
    }
    return { isIndex, entries: out };
}

// --- robots.txt (generic "*" group only) ---
export function parseRobots(text) {
    const rules = [];
    const sitemaps = [];
    let crawlDelay = 0;
    let inStar = false;
    let groupHasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === 'sitemap') sitemaps.push(v);
        else if (k === 'user-agent') {
            if (!groupHasAgent) inStar = false;
            groupHasAgent = true;
            if (v === '*') inStar = true;
        } else {
            groupHasAgent = false;
            if (inStar && k === 'crawl-delay' && Number(v) > 0) crawlDelay = Math.min(10, Number(v));
            if (inStar && (k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', path: v });
        }
    }
    return { rules, sitemaps, crawlDelay };
}

export function isAllowed(rules, urlStr) {
    const u = new URL(urlStr);
    if (rules.disallowAll) return false;
    const target = u.pathname + u.search;
    let best = null;
    for (const r of rules) {
        let pat = r.path;
        const endAnchor = pat.endsWith('$');
        if (endAnchor) pat = pat.slice(0, -1);
        const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}${endAnchor ? '$' : ''}`);
        if (re.test(target)) {
            if (!best || pat.length > best.len || (pat.length === best.len && r.allow)) best = { len: pat.length, allow: r.allow };
        }
    }
    return best ? best.allow : true;
}

// --- page check ---
async function checkUrl(url, slowMs) {
    const t0 = Date.now();
    let current = url;
    let redirects = 0;
    let res;
    assertPublicHttpUrl(url);
    for (;;) {
        res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
            signal: AbortSignal.timeout(30000),
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            await res.body?.cancel();
            redirects++;
            if (redirects > MAX_REDIRECTS) return { error: 'too-many-redirects', redirects, responseTimeMs: Date.now() - t0 };
            current = new URL(res.headers.get('location'), current).toString();
            assertPublicHttpUrl(current);
            continue;
        }
        break;
    }
    const ct = res.headers.get('content-type') || '';
    let html = '';
    if (/html/i.test(ct)) {
        // read at most ~300KB, enough for <head>
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        while (size < 300_000) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
        }
        await reader.cancel().catch(() => {});
        html = Buffer.concat(chunks).toString('utf8');
    } else {
        await res.body?.cancel();
    }
    const elapsed = Date.now() - t0;
    const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : 100000);
    const metaRobots = (head.match(/<meta[^>]+name=["']robots["'][^>]*>/i) || [''])[0];
    const metaContent = (metaRobots.match(/content=["']([^"']*)["']/i) || [, ''])[1];
    const xRobots = res.headers.get('x-robots-tag') || '';
    const noindex = /noindex/i.test(metaContent) || /noindex/i.test(xRobots);
    const canonTag = (head.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [''])[0];
    const canonical = (canonTag.match(/href=["']([^"']*)["']/i) || [, null])[1];
    const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
        httpStatus: res.status,
        finalUrl: current,
        redirectCount: redirects,
        contentType: ct.split(';')[0] || null,
        responseTimeMs: elapsed,
        noindex,
        canonicalUrl: canonical ? new URL(canonical, current).toString() : null,
        hasTitle: html ? Boolean(titleMatch && titleMatch[1].trim()) : null,
        isHtml: Boolean(html),
        slow: elapsed > slowMs,
    };
}

function norm(u) {
    try {
        const x = new URL(u);
        x.hash = '';
        let s = x.toString();
        if (s.endsWith('/')) s = s.slice(0, -1);
        return s;
    } catch {
        return u;
    }
}

function evaluate(check, url) {
    const issues = [];
    let sev = 0; // 0 ok, 1 info/warn, 2 error
    const add = (code, level) => { issues.push(code); sev = Math.max(sev, level); };
    if (check.error) add(check.error, 2);
    else {
        if (check.httpStatus >= 400) add(`http-${check.httpStatus}`, 2);
        else if (check.httpStatus >= 300) add(`http-${check.httpStatus}-unresolved`, 2);
        if (check.redirectCount > 0 && check.httpStatus < 400) add(check.redirectCount > 1 ? 'redirect-chain' : 'redirected', check.redirectCount > 1 ? 2 : 1);
        if (check.noindex) add('noindex-in-sitemap', 2);
        if (check.isHtml && check.httpStatus < 400) {
            if (check.canonicalUrl && norm(check.canonicalUrl) !== norm(check.finalUrl)) add('canonical-points-elsewhere', 1);
            if (check.hasTitle === false) add('missing-title', 1);
        }
        if (check.slow) add('slow-response', 1);
        if (new URL(url).protocol === 'http:') add('non-https-url', 1);
    }
    return { issues, severity: sev === 2 ? 'error' : sev === 1 ? 'warning' : 'ok' };
}

async function discoverSitemaps(input) {
    const u = new URL(input);
    const origin = u.origin;
    let robots = { rules: [], sitemaps: [], crawlDelay: 0 };
    try {
        const { status, buf } = await fetchBuf(`${origin}/robots.txt`, { timeout: 15000, allowStatus: true });
        if (status >= 500) {
            // RFC 9309: server errors on robots.txt mean "assume complete disallow"
            robots.rules.disallowAll = true;
            log.warning(`${origin}/robots.txt returned HTTP ${status}; treating the site as disallowed while it is unavailable.`);
        } else if (status < 400) robots = parseRobots(buf.toString('utf8'));
    } catch {
        /* robots.txt unreachable: no rules */
    }
    let sitemaps;
    if (/\.(xml|gz)(\?|$)/i.test(u.pathname) || /sitemap/i.test(u.pathname)) sitemaps = [input];
    else sitemaps = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
    return { origin, host: u.host, robots, sitemaps };
}

async function collectUrls(sitemapUrls, limit, host) {
    const urls = new Map();
    const queue = [...sitemapUrls];
    const offSite = [];
    const visited = new Set();
    const problems = [];
    while (queue.length && visited.size < MAX_NESTED_SITEMAPS && urls.size < limit) {
        const sm = queue.shift();
        if (visited.has(sm)) continue;
        visited.add(sm);
        try {
            const { isIndex, entries } = parseSitemap(await fetchXml(sm));
            if (isIndex) queue.push(...entries.map((e) => e.loc));
            else {
                for (const e of entries) {
                    if (urls.size >= limit) break;
                    if (urls.has(e.loc)) continue;
                    let eh = null;
                    try { eh = new URL(e.loc).host; } catch { /* invalid */ }
                    // Only URLs on the same host as the site are checked: the Actor must not be usable to hit third-party hosts.
                    if (!eh || hostKey(eh) !== hostKey(host)) { offSite.push(e.loc); continue; }
                    urls.set(e.loc, { lastmod: e.lastmod, sitemap: sm });
                }
            }
        } catch (e) {
            problems.push({ sitemap: sm, error: e.message });
            log.warning(`Could not read sitemap ${sm}: ${e.message}`);
        }
    }
    return { urls, problems, offSite };
}

async function pool(items, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: size }, async () => {
        while (i < items.length) await fn(items[i++]);
    }));
}

// ---------- main ----------
await Actor.init();
try {
    const input = (await Actor.getInput()) || {};
    let {
        sites = [],
        maxUrlsPerSite = 100,
        maxUrlsTotal = 500,
        respectRobotsTxt = true,
        slowThresholdMs = 2000,
        concurrency = 3,
        onlyReportProblems = false,
    } = input;
    if (!Array.isArray(sites) || !sites.length) throw new Error('Provide at least one site or sitemap URL in "sites".');
    if (sites.length > MAX_SITES) {
        log.warning(`Only the first ${MAX_SITES} sites are processed (got ${sites.length}).`);
        sites = sites.slice(0, MAX_SITES);
    }
    const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
    maxUrlsPerSite = clamp(maxUrlsPerSite, 1, 5000, 100);
    maxUrlsTotal = clamp(maxUrlsTotal, 1, MAX_REQUEST_ABS, 500);
    concurrency = clamp(concurrency, 1, 10, 3);
    slowThresholdMs = clamp(slowThresholdMs, 100, 30000, 2000);

    const summary = { sites: [], urlsChecked: 0, skippedOffSite: 0, fetchFailed: 0, stoppedByMaxChargeLimit: false, ok: 0, warning: 0, error: 0, blockedByRobots: 0, chargedEvents: 0, issueCounts: {} };
    let remaining = maxUrlsTotal;
    let limitReached = false;

    for (const raw of sites) {
        if (remaining <= 0 || limitReached) break;
        let site;
        try {
            site = await discoverSitemaps(assertPublicHttpUrl(String(raw).trim()).toString());
        } catch (e) {
            log.warning(`Skipping site "${raw}": ${e.message}`);
            summary.sites.push({ site: String(raw), error: e.message });
            continue;
        }
        const { urls, problems, offSite } = await collectUrls(site.sitemaps, Math.min(maxUrlsPerSite, remaining), site.host);
        if (offSite.length) {
            summary.skippedOffSite += offSite.length;
            log.warning(`${site.origin}: ${offSite.length} sitemap URL(s) on other hosts were skipped (only same-host URLs are checked).`);
        }
        log.info(`${site.origin}: ${urls.size} URLs to check from ${site.sitemaps.length} sitemap(s)`);
        const effConcurrency = site.robots.crawlDelay > 0 && respectRobotsTxt ? 1 : concurrency;
        const delayMs = Math.max(MIN_DELAY_MS, respectRobotsTxt ? site.robots.crawlDelay * 1000 : 0);
        const siteSummary = { site: site.origin, sitemaps: site.sitemaps, sitemapErrors: problems, urlsFound: urls.size, checked: 0 };
        const batch = [...urls.entries()];
        remaining -= batch.length;

        await pool(batch, effConcurrency, async ([url, meta]) => {
          try {
            if (limitReached) return;
            const base = { site: site.origin, url, lastmodInSitemap: meta.lastmod, sitemap: meta.sitemap };
            if (respectRobotsTxt && !isAllowed(site.robots.rules, url)) {
                summary.blockedByRobots++;
                await Actor.pushData({ ...base, httpStatus: null, severity: 'warning', issues: ['blocked-by-robots-txt'], note: 'URL is in the sitemap but disallowed by robots.txt; not fetched.' });
                return;
            }
            let check;
            try {
                check = await checkUrl(url, slowThresholdMs);
            } catch (e) {
                check = { error: `fetch-failed`, errorDetail: e.message, responseTimeMs: null };
            }
            const { issues, severity } = evaluate(check, url);
            if (check.error === 'fetch-failed') summary.fetchFailed++;
            const row = { ...base, ...check, severity, issues };
            summary.urlsChecked++;
            siteSummary.checked++;
            summary[severity]++;
            for (const i of issues) summary.issueCounts[i] = (summary.issueCounts[i] || 0) + 1;
            if (check.error === 'fetch-failed') {
                // The URL could not be checked at all (DNS/timeout/connection/invalid): reported for free.
                if (!onlyReportProblems) await Actor.pushData(row);
            } else if (!onlyReportProblems || severity !== 'ok') {
                // Pay-per-event: one `url-checked` event per fetched URL.
                const res = await Actor.pushData(row, EVENT);
                summary.chargedEvents++;
                if (res && res.eventChargeLimitReached) limitReached = true;
            } else {
                const res = await Actor.charge({ eventName: EVENT });
                summary.chargedEvents++;
                if (res && res.eventChargeLimitReached) limitReached = true;
            }
            await sleep(delayMs);
          } catch (e) {
            // Never let one URL crash the run.
            log.warning(`Unexpected error while checking ${url}: ${e.message}`);
          }
        });
        if (limitReached) summary.stoppedByMaxChargeLimit = true;
        summary.sites.push(siteSummary);
    }

    const totalFound = summary.sites.reduce((n, x) => n + (x.urlsFound || 0), 0);
    if (!totalFound) {
        const why = summary.sites.flatMap((x) => (x.sitemapErrors || []).map((p) => `${p.sitemap}: ${p.error}`).concat(x.error ? [`${x.site}: ${x.error}`] : [])).slice(0, 5).join('; ');
        await Actor.setValue('OUTPUT', summary);
        throw new Error(`No sitemap URLs could be read. ${why || 'No sitemap found or it is empty.'}`);
    }
    await Actor.setValue('OUTPUT', summary);
    log.info('Summary', summary);
    if (summary.stoppedByMaxChargeLimit) log.warning('Stopped early: max charge limit reached. Raise the max cost per run to check more URLs.');
    await Actor.setStatusMessage(`${summary.stoppedByMaxChargeLimit ? 'Stopped at max charge limit. ' : ''}Checked ${summary.urlsChecked} URLs: ${summary.error} errors, ${summary.warning} warnings, ${summary.ok} OK.`);
} catch (e) {
    log.error(e.message);
    await Actor.fail(e.message);
}
await Actor.exit();
