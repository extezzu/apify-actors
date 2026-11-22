# Dependency Manifest Audit: package.json & requirements.txt Health Check

Paste a `package.json` or `requirements.txt` and get a **per-dependency health report in seconds**: outdated versions, deprecated packages, stale projects, license info, known vulnerabilities and a 0-100 risk score. No login, no API key, no GitHub token needed.

Data comes only from official public registries: the **npm registry**, the **PyPI JSON API** and the open **OSV.dev** vulnerability database.

## What you get for every dependency

| Field | Meaning |
|---|---|
| `outdated` | `major`, `minor`, `patch`, `none` or `unknown` compared with the latest release |
| `deprecated` | npm deprecation flag, or PyPI "Inactive" classifier, with the message |
| `license` | License declared by the latest release, with a copyleft review flag |
| `daysSinceLastPublish`, `isStale` | Maintenance signal based on the latest release date |
| `vulnerabilityCount`, `vulnerabilityIds` | Known advisories (OSV.dev) for your requested version |
| `riskScore`, `riskLevel`, `riskFlags` | Combined 0-100 score, sorted so the riskiest packages come first |
| `repository`, `registryUrl` | Where to look next |

A run summary (counts of high/medium/low risk, deprecated, vulnerable, stale) is saved to the key-value store record `OUTPUT`.

## Use cases

- **Pre-acquisition and client due diligence**: quickly judge the health of a codebase's dependency tree.
- **Freelancers and agencies**: add a dependency report to a project hand-over or audit.
- **CI and scheduled monitoring**: run on a schedule through the Apify API or webhooks and alert when risk grows.
- **License reviews**: surface missing or copyleft licenses early.
- **AI agents**: call the Actor through the Apify API/MCP to check a manifest before suggesting upgrades.

## Input example

```json
{
  "packageJson": "{\"dependencies\":{\"express\":\"^4.17.1\",\"request\":\"^2.88.0\"}}",
  "requirementsTxt": "requests==2.25.0\nflask>=1.0",
  "packages": ["npm:chalk@4.1.2"],
  "checkVulnerabilities": true,
  "staleAfterDays": 730
}
```

You can also pass `manifestUrls` pointing to raw files (for example `raw.githubusercontent.com` links).

## Output example

```json
{
  "ecosystem": "npm",
  "name": "request",
  "requested": "^2.88.0",
  "latestVersion": "2.88.2",
  "outdated": "patch",
  "deprecated": true,
  "deprecationMessage": "request has been deprecated, see https://github.com/request/request/issues/3142",
  "license": "Apache-2.0",
  "daysSinceLastPublish": 2475,
  "isStale": true,
  "vulnerabilityCount": 0,
  "riskScore": 60,
  "riskLevel": "high",
  "riskFlags": ["deprecated", "stale-no-recent-release"]
}
```

## Pricing (pay per event)

You pay only for dependencies that were actually audited:

- **$3.00 per 1,000 dependencies audited** (event `dependency-checked`, $0.003 each)
- Skipped entries (git/file/workspace specifiers), packages that are not found and failed lookups are **free**.
- Set a maximum cost per run in the Apify Console; the Actor stops cleanly when the limit is reached (highest-risk dependencies are delivered and charged first; `OUTPUT` then shows `stoppedByMaxChargeLimit: true`).

## Notes and limits

- Version comparison uses the lowest version allowed by your range as the baseline, so results describe the "floor" of your range.
- `dependencies` and `peerDependencies` are always read; `devDependencies` and `optionalDependencies` only when `includeDevDependencies` is on. At most 2,000 dependencies and 20 manifest URLs per run (public http(s) hosts only).
- npm and PyPI are supported. Lock files and transitive dependencies are not resolved in this version.
- Vulnerability counts are `null` (not 0) when OSV.dev could not be reached or no concrete version is known; check `vulnerabilityLookup` in `OUTPUT`.
- Vulnerability lookups need a concrete baseline version; if OSV.dev is unavailable the run continues without them and says so in the summary.
- Only public registry metadata is accessed. No personal data is collected.
