import tls from 'node:tls';
import { Actor, log } from 'apify';

const UA = 'security-headers-ssl-audit-apify-actor/1.0 (passive security header check)';
const EVENT = 'site-checked';
const MAX_SITES = 500;
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.internal|.*\.local|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1?\]?$|fc|fd|fe80))/i;

export function normalizeTarget(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('empty target');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('only http(s) URLs are supported');
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are supported');
    if (!process.env.SEC_AUDIT_ALLOW_PRIVATE && PRIVATE_HOST.test(u.hostname)) throw new Error('private/local hosts are not allowed');
    return u;
}

export function getCert(host, port = 443, timeout = 15000) {
    return new Promise((resolve) => {
        const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
            const c = sock.getPeerCertificate();
            const out = {
                authorized: sock.authorized,
                authError: sock.authorizationError ? String(sock.authorizationError) : null,
                protocol: sock.getProtocol(),
                issuer: c?.issuer?.O || c?.issuer?.CN || null,
                subject: c?.subject?.CN || null,
                validTo: c?.valid_to ? new Date(c.valid_to).toISOString() : null,
            };
            sock.end();
            resolve(out);
        });
        sock.on('timeout', () => { sock.destroy(); resolve({ error: 'TLS timeout' }); });
        sock.on('error', (e) => resolve({ error: e.code || e.message }));
    });
}

const HEADER_CHECKS = [
    ['strict-transport-security', 'missing-hsts', 'error'],
    ['content-security-policy', 'missing-csp', 'warning'],
    ['x-content-type-options', 'missing-x-content-type-options', 'warning'],
    ['referrer-policy', 'missing-referrer-policy', 'warning'],
    ['permissions-policy', 'missing-permissions-policy', 'info'],
];

export function analyzeHeaders(h) {
    const issues = [];
    for (const [name, code, sev] of HEADER_CHECKS) if (!h[name]) issues.push({ code, sev });
    const hsts = h['strict-transport-security'];
    if (hsts) {
        const m = /max-age=(\d+)/i.exec(hsts);
        if (!m || Number(m[1]) < 15552000) issues.push({ code: 'weak-hsts-max-age', sev: 'warning' });
    }
    const csp = h['content-security-policy'] || '';
    if (!h['x-frame-options'] && !/frame-ancestors/i.test(csp)) issues.push({ code: 'clickjacking-unprotected', sev: 'warning' });
    if (/unsafe-inline/i.test(csp) && !/nonce-|sha256-/i.test(csp)) issues.push({ code: 'csp-unsafe-inline', sev: 'info' });
    if (h['server'] && /\d/.test(h['server'])) issues.push({ code: 'server-version-disclosed', sev: 'info' });
    if (h['x-powered-by']) issues.push({ code: 'x-powered-by-disclosed', sev: 'info' });
    const cookies = h['set-cookie'] || [];
    for (const ck of cookies) {
        if (!/;\s*secure/i.test(ck)) { issues.push({ code: 'cookie-without-secure', sev: 'warning' }); break; }
    }
    for (const ck of cookies) {
        if (!/;\s*samesite=/i.test(ck)) { issues.push({ code: 'cookie-without-samesite', sev: 'info' }); break; }
    }
    return issues;
}

export function grade(issues) {
    const pen = { error: 25, warning: 10, info: 3 };
    const score = Math.max(0, 100 - issues.reduce((s, i) => s + (pen[i.sev] || 0), 0));
    const letter = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
    return { score, letter };
}

function headersObj(res) {
    const o = {};
    res.headers.forEach((v, k) => { o[k] = v; });
    o['set-cookie'] = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return o;
}

async function checkSite(target, { warnDays }) {
    const u = normalizeTarget(target);
    const host = u.hostname;
    const row = { target, host, checkedAt: new Date().toISOString() };
    const issues = [];

    // 1) HTTP -> HTTPS redirect
    try {
        const r = await fetch(`http://${host}${u.pathname}`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
        const loc = r.headers.get('location') || '';
        row.httpRedirectsToHttps = r.status >= 300 && r.status < 400 && /^https:/i.test(loc);
        if (!row.httpRedirectsToHttps) issues.push({ code: 'no-http-to-https-redirect', sev: 'error' });
    } catch { row.httpRedirectsToHttps = null; }

    // 2) TLS certificate
    const cert = await getCert(host);
    row.tls = cert;
    if (cert.error) issues.push({ code: 'tls-connect-failed', sev: 'error' });
    else {
        if (!cert.authorized) issues.push({ code: 'certificate-invalid', sev: 'error' });
        if (cert.validTo) {
            row.certDaysLeft = Math.floor((new Date(cert.validTo) - Date.now()) / 86400000);
            if (row.certDaysLeft < 0) issues.push({ code: 'certificate-expired', sev: 'error' });
            else if (row.certDaysLeft < warnDays) issues.push({ code: 'certificate-expires-soon', sev: 'warning' });
        }
        if (cert.protocol && /TLSv1(\.0|\.1)?$/.test(cert.protocol)) issues.push({ code: 'old-tls-protocol', sev: 'warning' });
    }

    // 3) HTTPS response headers
    try {
        const t0 = Date.now();
        const r = await fetch(`https://${host}${u.pathname}${u.search}`, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        row.httpsStatus = r.status;
        row.finalUrl = r.url;
        row.responseTimeMs = Date.now() - t0;
        const h = headersObj(r);
        await r.body?.cancel().catch(() => {});
        row.headers = Object.fromEntries(['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'server', 'x-powered-by'].map((k) => [k, h[k] || null]));
        issues.push(...analyzeHeaders(h));
    } catch (e) {
        row.httpsError = e.cause?.code || e.message;
        if (!issues.some((i) => i.code === 'tls-connect-failed')) issues.push({ code: 'https-request-failed', sev: 'error' });
    }

    if (cert.error && row.httpsError) {
        row.score = null;
        row.grade = 'unreachable';
        row.severity = 'error';
        row.issues = issues.map((i) => i.code);
        return row;
    }
    const g = grade(issues);
    row.score = g.score;
    row.grade = g.letter;
    row.severity = issues.some((i) => i.sev === 'error') ? 'error' : issues.some((i) => i.sev === 'warning') ? 'warning' : 'ok';
    row.issues = issues.map((i) => i.code);
    return row;
}

async function main() {
    await Actor.init();
    const input = (await Actor.getInput()) || {};
    const sites = [...new Set((input.sites || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, MAX_SITES);
    const warnDays = Number(input.certWarnDays ?? 21);
    const onlyProblems = !!input.onlyReportProblems;
    const concurrency = Math.min(Math.max(Number(input.concurrency ?? 5), 1), 10);
    if (!sites.length) throw new Error('Input "sites" must contain at least one domain or URL.');

    const summary = { sites: sites.length, grades: {}, issues: {}, errors: 0 };
    const queue = [...sites];
    const worker = async () => {
        while (queue.length) {
            const s = queue.shift();
            let row;
            try { row = await checkSite(s, { warnDays }); } catch (e) {
                row = { target: s, severity: 'error', issues: ['invalid-target'], error: e.message };
                summary.errors++;
            }
            if (row.grade) summary.grades[row.grade] = (summary.grades[row.grade] || 0) + 1;
            for (const c of row.issues || []) summary.issues[c] = (summary.issues[c] || 0) + 1;
            if (row.error) { log.warning(`${s}: ${row.error}`); continue; } // invalid input: not charged
            if (onlyProblems && row.severity === 'ok') { await Actor.charge({ eventName: EVENT }); continue; }
            await Actor.pushData(row, EVENT);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    await Actor.setValue('OUTPUT', summary);
    log.info(`Done: ${JSON.stringify(summary)}`);
    await Actor.exit();
}

if (!process.env.SEC_AUDIT_NO_MAIN) {
    main().catch(async (e) => { log.error(e.message); await Actor.fail(e.message); });
}
