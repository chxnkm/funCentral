# Connect 4 PR #86 screenshots

Source: PR head `e9d85ae650295226a0e23e0caa7fc917a5275902`.
This evidence-only branch does not change the PR's source code.

| Screen | Desktop | Mobile emulation |
| --- | --- | --- |
| Lobby | [Screenshot](lobby-desktop.png) | [Screenshot](lobby-mobile.png) |
| Game | [Screenshot](game-desktop.png) | [Screenshot](game-mobile.png) |

Captured with Playwright 1.64.1 and Chrome 156.0.8078.80 on Windows, using the
actual local Worker, SQLite Durable Objects, D1, dev-only synthetic sign-ins and
WebSocket clients. Game screenshots show six legal moves, not a patched board.

Desktop viewport: 1366×900 (full-page captures). Mobile: 390×844 viewport captures,
with Chromium's `isMobile` and `hasTouch` flags and Playwright tap input. The
mobile lobby extends below the fold; the screenshot preserves the actual phone
viewport rather than resizing the UI to fit it. Google Fonts were allowed;
unrelated external/Telegram requests were blocked.

No production deployment, real Telegram session, physical phone, Safari or
screen-reader verification is implied. See `capture-metadata.json` for the
capture browser, viewport and synthetic room details.
