# App Store Reviews Scraper (Multi-Country, New-Only Mode)

Export **Apple App Store reviews** for any iPhone/iPad app — stars, title, full text, app version, author and date — from **one country or ~100 storefronts at once**. Filter by stars, keywords and date, and schedule it to collect **only new reviews**.

Built on Apple's public review feeds. No login, no browser, no proxies — fast and cheap.

## What you can use it for
- **Product teams:** find bugs and feature requests right after a release (filter `maxRating: 2`, keywords `crash`, `bug`, `login`).
- **Competitor research:** compare what users love and hate in competing apps, country by country.
- **ASO & marketing:** mine review language for keywords and messaging.
- **Support & CX:** daily feed of new 1–2 star reviews into Slack, Google Sheets or your helpdesk (via Apify integrations).
- **AI / LLM pipelines:** clean JSON ready for sentiment analysis and summarisation, or call it from Claude/Cursor via the Apify MCP server.

## Why this one
- **More reviews per app:** Apple serves the latest ~500 reviews per country. This Actor walks every storefront you choose (`top` = 18 big markets, `all` = ~100) and de-duplicates, so you get far more than a single-country scraper.
- **New-only mode:** set `sinceDate` and run it on a schedule — you only pay for reviews you haven't seen.
- **Filters before you pay:** star range and keyword filters are applied before results are saved and charged.
- Accepts App Store URLs, numeric ids or plain app names.

## Input example
```json
{
  "apps": ["https://apps.apple.com/us/app/duolingo-language-lessons/id570060128", "Headspace"],
  "countries": ["top"],
  "maxRating": 2,
  "keywords": ["crash", "subscription", "refund"],
  "sinceDate": "2026-11-01"
}
```

## Output example
```json
{
  "appId": "570060128",
  "appName": "Duolingo - Language Lessons",
  "country": "gb",
  "reviewId": "11223344556",
  "rating": 2,
  "title": "Keeps crashing after update",
  "text": "Since the last version the app crashes when I open a lesson...",
  "appVersion": "7.12.0",
  "author": "someuser",
  "date": "2026-11-20T17:51:01.000Z",
  "voteSum": 0,
  "voteCount": 1
}
```
A per-app summary (reviews by country and by star rating) is saved to the key-value store record `OUTPUT`.

## Pricing
Pay per result: **$0.40 per 1,000 reviews** saved (plus a tiny start fee). Filtered-out reviews are free. Set a maximum cost per run in the run options and the Actor stops at that limit.

## Limits (honest)
- Apple's public feed returns at most ~500 most recent (or most helpful) reviews **per country** per app. For older history, run on a schedule and keep your dataset.
- Ratings without written reviews are not included (Apple doesn't publish them individually); the app's overall rating and count are included in `OUTPUT`.
- Reviews are public user content; use the data in line with Apple's terms and applicable privacy law.

## Related tools by the same author
- [Security Headers & SSL Certificate Audit](https://apify.com/extezzu/security-headers-ssl-audit)
- [Sitemap URL Validator](https://apify.com/extezzu/sitemap-url-validator)
- [Dependency Manifest Audit (npm & PyPI)](https://apify.com/extezzu/dependency-manifest-audit-npm-pypi)

Source code: [github.com/extezzu/apify-actors](https://github.com/extezzu/apify-actors). Questions or ideas — open an issue on the Actor page.
