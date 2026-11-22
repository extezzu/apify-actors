# Security Headers & SSL Certificate Audit: Bulk-Check Domains, Graded A–F

Check hundreds of domains in one run for **SSL/TLS certificate expiry**, **invalid certificates**, a missing **HTTP → HTTPS redirect** and missing **security headers** (HSTS, Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, clickjacking protection). Every site gets a **0–100 score** and an **A–F grade**, so you can sort a whole portfolio by risk in seconds.

The check is **passive**: one plain HTTP request, one HTTPS request and one TLS handshake per site, exactly what a browser does. No scanning, no fuzzing, no login attempts.

## What it checks

| Check | Issue code | Severity |
|---|---|---|
| Certificate expired / expiring within N days | `certificate-expired`, `certificate-expires-soon` | error / warning |
| Certificate not trusted (self-signed, wrong host, chain) | `certificate-invalid` | error |
| Old TLS protocol (1.0/1.1) | `old-tls-protocol` | warning |
| HTTP does not redirect to HTTPS | `no-http-to-https-redirect` | error |
| No HSTS, or HSTS max-age under 180 days | `missing-hsts`, `weak-hsts-max-age` | error / warning |
| No Content-Security-Policy | `missing-csp` | warning |
| No X-Frame-Options and no CSP `frame-ancestors` | `clickjacking-unprotected` | warning |
| No X-Content-Type-Options / Referrer-Policy | `missing-x-content-type-options`, `missing-referrer-policy` | warning |
| No Permissions-Policy | `missing-permissions-policy` | info |
| Cookies without `Secure` / `SameSite` | `cookie-without-secure`, `cookie-without-samesite` | warning / info |
| Server version or `X-Powered-By` leaked | `server-version-disclosed`, `x-powered-by-disclosed` | info |

## Use cases

- **SSL certificate expiry monitoring**: schedule it daily and alert when `certDaysLeft` drops below your threshold.
- **Agencies and freelancers**: audit every client site at once and attach the A–F report to a proposal or maintenance plan.
- **Security questionnaires and compliance prep** (SOC 2, ISO 27001, vendor reviews): prove headers and TLS are in place across all domains.
- **M&A and vendor due diligence**: quick external hygiene check of a list of domains.
- **Lead generation for web/security services**: find sites with weak grades (only contact businesses in line with local law).

Only audit websites you own or have permission to test.

## Input example

```json
{
  "sites": ["example.com", "https://example.org/login"],
  "certWarnDays": 21,
  "concurrency": 5,
  "onlyReportProblems": false
}
```

## Output example (one row per site)

```json
{
  "host": "example.com",
  "grade": "C",
  "score": 62,
  "severity": "warning",
  "certDaysLeft": 17,
  "httpRedirectsToHttps": true,
  "httpsStatus": 200,
  "tls": { "authorized": true, "protocol": "TLSv1.3", "issuer": "Let's Encrypt", "validTo": "2026-12-09T12:00:00.000Z" },
  "headers": { "strict-transport-security": "max-age=31536000", "content-security-policy": null, "x-frame-options": "SAMEORIGIN" },
  "issues": ["certificate-expires-soon", "missing-csp", "missing-referrer-policy", "missing-permissions-policy"]
}
```

A run summary (grade distribution and counts per issue code) is saved to the key-value store as `OUTPUT`. Unreachable sites get `grade: "unreachable"`.

## Pricing

Pay per event: you pay only for **sites checked**, plus a tiny start fee. Invalid inputs (malformed or private/local addresses) are skipped and not charged. No proxies are needed, so runs are cheap and fast.

## Scheduling and integrations

Use Apify **Schedules** for daily monitoring, then send results to Slack, email, Google Sheets, Zapier, Make or a webhook with Apify integrations, or pull them via the API.

## FAQ

**Is this a vulnerability scanner?** No. It reads only what any visitor's browser receives. It does not probe paths, ports or forms.

**Why is my grade low even though the site is fine?** Grades reflect hardening best practice (OWASP Secure Headers). Missing CSP or HSTS lowers the score even if nothing is broken today.

**Can I audit internal hosts?** No. Private, loopback and link-local addresses are blocked.
