# Dependency audit — 2026-11-03

Branch: `chore/dependency-audit`, based on upstream `origin/master`.

## Changes

- Updated GitNexus to 1.6.12, Vitest to 4.1.12, Wrangler to 4.157.0,
  and matching Workers types to 5.20261103.1; refreshed transitive dependencies.
- Scoped GitNexus's glob override to 14.0.3+, bringing patched minimatch 11.x.
  Rationale and removal criteria are in [development.md](development.md).
- Adapted the three local Miniflare harnesses using its provided v4-options
  adapter and the new isolated persistence-root setting. No game logic changed.
- Added Node security floors to `package.json` and `.nvmrc` (22.23.4).

## Node2Shell / CVE-2026-111497

This is a native Brotli decoder vulnerability, not something an npm override
can fix. Node's October security release includes fixes in 22.23.4, 24.22.1,
and 26.12.1. The initial system Node 22.13.0 predated the fix; by final
verification the system reported 26.13.0. The Brotli error constant added by
the fix was present (`BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH = -17`).

Sources:
- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- https://cveawg.mitre.org/api/cve/CVE-2026-111497

Build/CI Node versions must also meet these floors. Production uses managed
Cloudflare Workers/workerd; provider patch status was not established by this
local audit. No deployment or production exploit probing was performed.

## Verification

- `npm ci --include=dev`: passed using temporary Node 22.23.4 / npm 10.
- `npm audit`: **35 findings before → 0 after**, including dev dependencies.
- `npm run typecheck`: passed.
- `PLAYWRIGHT_CHANNEL=chrome node tests/run-pr-checks.cjs`: passed on
  Node 26.13.0, exercising the same runner as `npm run test:pr`:
  - Vitest: 21 files, **255 passed, 0 failed, 0 skipped**.
  - Complete Classic browser suite: **202 passed, 0 failed, 6 skipped**.
  - Repeated 2.5D hand-layout suite: **57 passed, 0 failed, 3 skipped**.
  - Skips are optional capture/recording cases, not executed checks.
- Browser: installed Chrome **156.0.8078.80**, headless Chromium engine.
- Responsive coverage includes 320×740, 360×640, 390×620, 390×844,
  844×390, 820×1180, 1280×900 and 1366×900; hand-layout sweeps widths
  320/390/768/1024/1366/1920 at height 1000, plus resize cases.
  Touch coverage uses Chromium CDP and Playwright touch/mobile emulation.
- GitNexus analysis/impact completed; harness risk low/medium. Full-text
  search was unavailable due to a missing native FTS dependency. Change
  analysis reported low risk, confined to documentation and test harnesses.
- `git diff --check`: passed. Test-generated historical screenshots restored.

The first verification exposed the Miniflare constructor incompatibility and
was fixed; a later 300-second run was interrupted before completion. The final
complete runner above passed. These results include local live Worker/SQLite/
WebSocket journeys and browser fixtures; fixtures are not live E2E evidence.
No physical devices, Safari, Telegram WebView, production networking or
assistive technologies were tested. No deployment was performed.
