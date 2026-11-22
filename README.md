# Apify Actors by extezzu

Small, focused, pay-per-result tools that run in the cloud on [Apify](https://apify.com/extezzu). No subscription, no servers: paste your input, click Start, download JSON/CSV/Excel, or call them from the API, Make, Zapier, n8n or any MCP client (Claude, Cursor).

| Actor | What it does | Price | Run it |
|-|-|-|-|
| **Dependency Manifest Audit (npm & PyPI)** | Reads `package.json` / `requirements.txt` (pasted, by URL or as a package list) and reports outdated, deprecated and vulnerable (OSV) packages, licenses and maintenance signals. | $3 / 1,000 dependencies | [apify.com/extezzu/dependency-manifest-audit-npm-pypi](https://apify.com/extezzu/dependency-manifest-audit-npm-pypi) |
| **Sitemap URL Validator** | Crawls `sitemap.xml` (incl. sitemap indexes) and checks every URL: status codes, redirects, noindex, canonical mismatches, slow pages. | $2 / 1,000 URLs | [apify.com/extezzu/sitemap-url-validator](https://apify.com/extezzu/sitemap-url-validator) |
| **Security Headers & SSL Audit** | Bulk-checks domains for certificate expiry, HTTP→HTTPS redirect, HSTS, CSP, clickjacking protection, insecure cookies; grades each site A–F. | $4 / 1,000 sites | [apify.com/extezzu/security-headers-ssl-audit](https://apify.com/extezzu/security-headers-ssl-audit) |
| **App Store Reviews (multi-country)** | Apple App Store reviews for any app across up to ~100 storefronts; star/keyword/date filters; new-only mode for scheduled monitoring. | $0.40 / 1,000 reviews | [apify.com/extezzu/app-store-reviews-multi-country](https://apify.com/extezzu/app-store-reviews-multi-country) |

## Why use the hosted version?
- Scheduled runs (daily/weekly) with email or Slack alerts when something breaks.
- Results stored as datasets with an API, ready for dashboards and spreadsheets.
- Works from AI agents through the Apify MCP server.

## Run locally
Each folder is a standard Apify Actor (Node.js 20):
```bash
cd sitemap-url-validator
npm install
mkdir -p storage/key_value_stores/default
echo '{"sites":["example.com"]}' > storage/key_value_stores/default/INPUT.json
npm start
```

## Feedback
Bug or feature request? Open an issue here or on the Actor's Issues tab in Apify Store.

License: MIT
