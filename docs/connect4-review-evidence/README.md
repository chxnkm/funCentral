# PR #86 — expanded review verification

Verified source commit: **`ed86de69494a8ad8d3309f18ba55abf528daea94`**.
This evidence-only commit adds screenshots/logs; the PR's source commit remains
the SHA above. No source edits occurred between that commit and the full gate.

## Actual results

| Check | Result | Raw output |
| --- | --- | --- |
| `PLAYWRIGHT_CHANNEL=chrome NODE_OPTIONS=--max-old-space-size=1024 npm run test:pr` | Exit 0: typecheck passed; 378 unit tests passed (38 files); 241 Classic browser tests passed / 6 optional captures skipped; 57 repeated 2.5D tests passed / 3 optional captures skipped; no failures | [Full gate](full-pr.log) |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:connect4:smoke` | 38 passed, no failures/skips | [Smoke](smoke.log) |
| `npm run test:connect4:chaos` | 15 passed, no failures/skips in EACH of 3 independent runs | [Run 1](chaos-1.log), [run 2](chaos-2.log), [run 3](chaos-3.log) |
| New concurrency tests against unchanged old source `e9d85ae` | All 6 fail as expected; all 6 pass with the fix | [Baseline falsification](baseline-regression.log) |

The smoke/chaos iterations preceded the source commit; the entire full gate was
then run again against the exact committed SHA above. No retry-on-failure masking
was used. GitHub reported no hosted checks for this head at publication: these
are reproducible **local results**, not a claim that hosted CI ran.

For the individual failure models, see the committed
[review verification notes](../connect4-review-2026-11-06.md). Faults include
cross-room old snapshots at game 30, retry exhaustion, late transaction rollback,
duplicate/reordered delivery, lost and delayed acknowledgements, real runtime
restart, expired idle cleanup and malformed/replaced socket sessions. Browser
smoke uses completed legal human and alarm-driven bot games, not patched boards.
It checks both-humans-dismissed and sole-human-bot rematches, leaving after a
completed practice game, all six chosen-colour labels in Chromium's accessibility
tree, no 42 board tab stops, modal isolation and stacked-modal focus restoration.

## Refreshed screenshots

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Main hub | [1366×900](hub-desktop.png) | [390×844 top](hub-mobile.png), [scrolled to Connect 4 tile](hub-games-mobile.png) |
| Lobby | [1366×900](lobby-desktop.png) | [390×844](lobby-mobile.png) |
| Game | [1366×900](game-desktop.png) | [390×844](game-mobile.png) |

Captured after the successful final gate, from the same source SHA. Actual local
Worker/D1/WebSockets; signed-out hub, synthetic signed-in Alice/Bob room. Games
show six legal drops. All captures preserve the viewport; the mobile hub has a
separate genuine scrolled view so the Connect 4 tile is visible. No CSS page
stretching or leaderboard fixtures. Google Fonts were allowed. See
[capture metadata](capture-metadata.json); regenerate with
`node tests/ui/connect4-review-capture.cjs` and `CONNECT4_SHOTS` pointing outside
the working tree.

## Environment, deployment and remaining gaps

Windows, Node 26.13.0, Playwright 1.64.1, Chrome 156.0.8078.80; Chromium touch/mobile
emulation with actual Playwright taps, not a physical phone or Safari.
Accessibility-tree and keyboard checks do not substitute for manual NVDA or
VoiceOver use. Physical phones, Safari, Telegram WebView, manual screen readers,
production network/load and real Telegram integration remain unverified.

D1 requirement: `0015_connect4.sql`; separate DO requirement: `v4`, SQLite
`Connect4Room`, binding `CONNECT4_ROOM`. The review fixes add no new migration.
A read-only remote migration-list attempt was blocked by missing Cloudflare
authentication, so production schema/ledger/pending status is **not confirmed**.
An authorized maintainer must inspect/reconcile it and apply only reviewed
pending migrations in order. Never replay `0006_stats_reset.sql`. Nothing was
deployed and no migration or production data was changed.
