# Sitemap URL Validator: Find Broken, Redirected & Noindex URLs in Your Sitemap

Your XML sitemap should only list pages that return **200**, are **indexable** and are the **canonical version**. This Actor reads a site's sitemap (including sitemap indexes and `.gz` files), checks each URL and tells you exactly which ones to fix. It is polite by design: low concurrency, a clear user agent and **robots.txt is respected**.

## What it checks for each sitemap URL

- HTTP status (404, 410, 5xx) and **redirect chains** (it follows up to 5 hops and reports the count)
- **`noindex`** in the meta robots tag or the `X-Robots-Tag` header while the URL sits in your sitemap
- **Canonical mismatch**: canonical tag points to a different URL
- Missing `<title>`
- Slow responses (configurable threshold)
- URLs **blocked by robots.txt** (reported, not fetched)
- Non-HTTPS URLs in the sitemap
- `lastmod` from the sitemap is returned alongside, so you can spot stale entries

Each row gets `severity` (`ok`, `warning`, `error`) and an `issues` array of codes. A summary with issue counts per code is saved to the key-value store as `OUTPUT`.

## Use cases

- Technical SEO audits and post-migration QA
- Weekly monitoring: schedule the Actor and alert on new errors
- Agencies: attach a clean sitemap health report to client work
- Finding "zombie" URLs after a CMS or e-commerce catalogue clean-up

Only check websites you own or have permission to test.

## Input example

```json
{
  "sites": ["https://example.com/", "https://example.org/sitemap.xml"],
  "maxUrlsPerSite": 30,
  "maxUrlsTotal": 60,
  "slowThresholdMs": 1500,
  "onlyReportProblems": false
}
```

Give either a home page (the Actor reads `robots.txt` for `Sitemap:` lines, falling back to `/sitemap.xml`) or a direct sitemap URL.

## Output example

```json
{
  "site": "https://example.com",
  "url": "https://example.com/old-page",
  "lastmodInSitemap": "2026-01-15",
  "httpStatus": 404,
  "redirectCount": 0,
  "noindex": true,
  "responseTimeMs": 97,
  "severity": "error",
  "issues": ["http-404", "noindex-in-sitemap"]
}
```

## Pricing (pay per event)

- **$2.00 per 1,000 URLs checked** (event `url-checked`, $0.002 each)
- URLs skipped because robots.txt disallows them, URLs on other hosts, and URLs that could not be fetched at all (DNS error, timeout, connection refused) are **free**. A 404 or 500 answer is a completed check and is charged.
- `maxUrlsPerSite` and `maxUrlsTotal` (plus the Console's max-cost-per-run setting) keep every run predictable.

## Safety limits

- Only URLs on the **same host** as the site you give are checked (sitemap entries pointing elsewhere are skipped), so the Actor cannot be pointed at third-party servers through a crafted sitemap.
- Localhost, private network and cloud-metadata addresses are refused; only http(s) is supported.
- Concurrency is capped at 10 (default 3), every worker waits at least 300 ms between requests, and robots.txt `Crawl-delay` (max 10 s) is honoured by forcing one request at a time. Max 50 sites, 5,000 URLs per site and 20,000 per run.
- If robots.txt answers with a 5xx error the site is treated as disallowed until it recovers.

## Notes

- Pages are fetched with a plain HTTP GET (no JavaScript rendering), reading only the first ~300 KB of HTML.
- Robots.txt handling uses the generic `*` group (`Allow`, `Disallow`, `*`, `$`, `Crawl-delay`). Redirect targets are not re-checked against robots.txt.
- If no sitemap URL can be read the run fails with a clear message and is not charged.
- No logins, no bypassing of protections, no personal data collected.
