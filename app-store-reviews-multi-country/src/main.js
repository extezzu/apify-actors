import { Actor, log } from 'apify';

const EVENT = 'review';
const PAGES_PER_COUNTRY = 10; // Apple's public RSS feed serves up to 10 pages x 50 reviews per storefront
const UA = 'app-store-reviews-apify-actor/1.0';

// Apple App Store storefront country codes (ISO 3166-1 alpha-2, lowercase).
export const ALL_COUNTRIES = ('us gb ca au nz ie de at ch fr be nl lu it es pt dk se no fi is pl cz sk hu ro bg gr hr si ee lv lt ua md ge am az kz uz '
    + 'tr il ae sa qa kw bh om jo lb eg ma tn dz ng ke gh za tz ug in pk lk bd np jp kr cn hk tw sg my th vn ph id mx br ar cl co pe ec uy py bo '
    + 'cr pa gt hn sv ni do jm tt ru by mn kh la mo mt cy').split(' ');
export const TOP_COUNTRIES = 'us gb ca au de fr it es nl se br mx in jp kr tr pl ua'.split(' ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
            if (res.status === 404) return null;
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return null;
            const text = await res.text();
            if (!text.trim()) return null;
            return JSON.parse(text);
        } catch (e) {
            if (i === tries - 1) { log.debug(`${url}: ${e.message}`); return null; }
            await sleep(1000 * (i + 1) ** 2);
        }
    }
    return null;
}

/** Accepts a numeric id, an App Store URL (…/id123456) or a search term. */
export async function resolveApp(q, country = 'us') {
    const s = String(q || '').trim();
    if (!s) return null;
    const m = s.match(/(?:^|\/id|[?&]id=)(\d{6,12})(?:\D|$)/);
    const id = /^\d{6,12}$/.test(s) ? s : m?.[1];
    const url = id
        ? `https://itunes.apple.com/lookup?id=${id}&country=${country}`
        : `https://itunes.apple.com/search?term=${encodeURIComponent(s)}&entity=software&country=${country}&limit=1`;
    const j = await getJson(url);
    const r = j?.results?.[0];
    if (!r) return id ? { appId: id, appName: null } : null;
    return {
        appId: String(r.trackId), appName: r.trackName, developer: r.artistName, bundleId: r.bundleId,
        averageRating: r.averageUserRating ?? null, ratingCount: r.userRatingCount ?? null, appUrl: r.trackViewUrl,
    };
}

export function mapEntry(e, app, country) {
    const label = (x) => x?.label ?? null;
    return {
        appId: app.appId,
        appName: app.appName,
        country,
        reviewId: label(e.id),
        rating: Number(label(e['im:rating'])) || null,
        title: label(e.title),
        text: label(e.content),
        appVersion: label(e['im:version']),
        author: label(e.author?.name),
        date: label(e.updated) ? new Date(label(e.updated)).toISOString() : null,
        voteSum: Number(label(e['im:voteSum']) ?? 0),
        voteCount: Number(label(e['im:voteCount']) ?? 0),
    };
}

async function* countryReviews(app, country, sort) {
    for (let page = 1; page <= PAGES_PER_COUNTRY; page++) {
        const j = await getJson(`https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${app.appId}/sortby=${sort}/json`);
        let entries = j?.feed?.entry;
        if (!entries) return;
        if (!Array.isArray(entries)) entries = [entries];
        entries = entries.filter((e) => e['im:rating']); // the first entry on old feeds can be app metadata
        if (!entries.length) return;
        for (const e of entries) yield mapEntry(e, app, country);
        if (entries.length < 50) return;
        await sleep(250);
    }
}

async function main() {
    await Actor.init();
    const input = (await Actor.getInput()) || {};
    const apps = [...new Set((input.apps || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
    if (!apps.length) throw new Error('Input "apps" must contain at least one App Store URL, app id or app name.');
    let countries = (input.countries || ['us']).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    if (countries.includes('all')) countries = ALL_COUNTRIES;
    else if (countries.includes('top')) countries = [...new Set([...countries.filter((c) => c !== 'top'), ...TOP_COUNTRIES])];
    countries = [...new Set(countries)].filter((c) => /^[a-z]{2}$/.test(c));
    const sort = input.sortBy === 'mosthelpful' ? 'mosthelpful' : 'mostrecent';
    const since = input.sinceDate ? new Date(input.sinceDate) : null;
    if (since && Number.isNaN(since.getTime())) throw new Error('sinceDate must be a date like 2026-01-31');
    const minRating = Number(input.minRating || 1);
    const maxRating = Number(input.maxRating || 5);
    const maxPerApp = Number(input.maxReviewsPerApp || 0) || Infinity;
    const keywords = (input.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);

    const summary = { apps: [] };
    for (const q of apps) {
        const app = await resolveApp(q, countries[0] || 'us');
        if (!app) { log.warning(`App not found: ${q}`); summary.apps.push({ query: q, error: 'not found' }); continue; }
        log.info(`${app.appName || app.appId}: fetching ${countries.length} storefront(s)`);
        const s = { query: q, ...app, reviews: 0, byCountry: {}, byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
        const seen = new Set();
        let stop = false;
        for (const country of countries) {
            if (stop) break;
            for await (const r of countryReviews(app, country, sort)) {
                if (since && sort === 'mostrecent' && r.date && new Date(r.date) < since) break;
                if (since && r.date && new Date(r.date) < since) continue;
                if (seen.has(r.reviewId)) continue;
                seen.add(r.reviewId);
                if (r.rating < minRating || r.rating > maxRating) continue;
                if (keywords.length && !keywords.some((k) => `${r.title} ${r.text}`.toLowerCase().includes(k))) continue;
                const res = await Actor.pushData(r, EVENT);
                s.reviews++;
                s.byCountry[country] = (s.byCountry[country] || 0) + 1;
                s.byRating[r.rating] = (s.byRating[r.rating] || 0) + 1;
                if (res?.eventChargeLimitReached) { log.info('Max charge per run reached, stopping.'); stop = true; break; }
                if (s.reviews >= maxPerApp) { stop = true; break; }
            }
        }
        const n = Object.entries(s.byRating).reduce((a, [k, v]) => a + k * v, 0);
        s.averageOfCollected = s.reviews ? Math.round((n / s.reviews) * 100) / 100 : null;
        summary.apps.push(s);
        if (stop && s.reviews < maxPerApp) break;
    }
    await Actor.setValue('OUTPUT', summary);
    log.info(`Done: ${summary.apps.map((a) => `${a.appName || a.query}=${a.reviews ?? 0}`).join(', ')}`);
    await Actor.exit();
}

if (!process.env.ASR_NO_MAIN) {
    main().catch(async (e) => { log.error(e.message); await Actor.fail(e.message); });
}
