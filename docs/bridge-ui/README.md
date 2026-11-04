# Bridge and hub UI refresh

Captures of the funCentral hub and the Floating Bridge client before (master
`9a0dd49`) and after this change. Bridge screens are set up by injecting exact
views through the page's own globals (as the fixture tests do), so both sets show
identical states; history and stats use stubbed API data, the hub leaderboard
uses seeded local players. Phone captures are Chrome mobile emulation (touch,
2× pixels) against a local Worker — not real iPhone/Safari or Telegram WebView
evidence.

Regenerate with `PLAYWRIGHT_CHANNEL=chrome node tests/ui/bridge-capture.cjs docs/bridge-ui/after`
(the "before" set was taken by running the same script in a checkout of master).

## What changed

**Hub (`/`)**
- A sticky brand bar with the signed-in player (verified profile name when a token
  is present), a hero with a fanned hand, and an **Add to a Telegram group** link
  built from the bot name `/api/config` already serves (hidden when none).
- Each game tile carries its own theme and real card faces: Bridge indigo,
  Regicide castle navy and crimson, Tai Di felt green and gold. Tiles lift and
  fan out on hover/focus. Exactly one link per game, as the hub tests require.
- A how-it-works strip with the `/newgame` and `/leaderboard` tip, and the shared
  leaderboard beside it on wide screens.

**Bridge**
- **Table (Classic):** a wood-rimmed felt with a stitched line; seat plates with
  an avatar, bidder/partner stars and a trick counter; the turn plate glows. Trick
  cards land slightly askew with depth. Phones stack the side plates so they clear
  the trick cards; short landscape phones get a compact strip and smaller plates.
- **Contract strip:** Contract (bid and bidder), Partner (the called card, and the
  partner's name once revealed, otherwise "secret") and Trump chips, plus trick
  progress toward the contract — the bidder's side against its target, and the
  defenders' count once the partner is known.
- **Bidding / partner:** the panel and status highlight on your turn; the bid
  history has equal columns; the bid grid is chunkier with clear disabled states;
  partner choices are small card faces, with cards you hold greyed out.
- **Lobby:** room-code card, invite buttons side by side, seat numbers as
  badges, open seats shown as dashed placeholders, bot buttons grouped under
  "Fill a seat with a bot".
- **Home / role choice / results / history / stats:** card-fan hero with feature
  chips, a monospaced code box, role cards, a trophy or card badge on results,
  side screens aligned to the top.
- **Feedback:** server errors, kicks, create/join and bet failures appear as
  styled toasts instead of browser `alert()` dialogs; the private "you are the
  partner" notice and the abandon vote are styled dialogs. Safe-area insets for
  notched phones.
- **Unchanged on purpose:** the hand renderer (fan geometry, typography, drag,
  swipe and keyboard play), the 2.5D scene, the room protocol and every rule. The
  Classic table is still rendered by `style.css` + `app.js` only, so the Classic
  pixel baseline in `tests/ui/table-view.pw.js` keeps matching.

## Hub

| Screen | Before | After |
| --- | --- | --- |
| Phone, signed in | ![Before](before/hub-390.jpg) | ![After](after/hub-390.jpg) |
| Phone, lower half | ![Before](before/hub-lower-390.jpg) | ![After](after/hub-lower-390.jpg) |
| Phone, signed out | ![Before](before/hub-signed-out-390.jpg) | ![After](after/hub-signed-out-390.jpg) |
| Desktop | ![Before](before/hub-1366.jpg) | ![After](after/hub-1366.jpg) |
| Desktop, lower half | ![Before](before/hub-lower-1366.jpg) | ![After](after/hub-lower-1366.jpg) |

## Bridge, phone 390 × 844 (Classic)

| Screen | Before | After |
| --- | --- | --- |
| Home | ![Before](before/home-390.jpg) | ![After](after/home-390.jpg) |
| Home, signed out | ![Before](before/home-signed-out-390.jpg) | ![After](after/home-signed-out-390.jpg) |
| Join as player or spectator | ![Before](before/role-choice-390.jpg) | ![After](after/role-choice-390.jpg) |
| Lobby (host, open seat) | ![Before](before/lobby-classic-390.jpg) | ![After](after/lobby-classic-390.jpg) |
| Bidding, your turn | ![Before](before/bidding-classic-390.jpg) | ![After](after/bidding-classic-390.jpg) |
| Bidding, your hand | ![Before](before/bidding-hand-classic-390.jpg) | ![After](after/bidding-hand-classic-390.jpg) |
| Calling a partner | ![Before](before/partner-classic-390.jpg) | ![After](after/partner-classic-390.jpg) |
| Play, your turn | ![Before](before/play-classic-390.jpg) | ![After](after/play-classic-390.jpg) |
| Play, your hand | ![Before](before/play-hand-classic-390.jpg) | ![After](after/play-hand-classic-390.jpg) |
| You won | ![Before](before/gameover-classic-390.jpg) | ![After](after/gameover-classic-390.jpg) |
| Someone else won | ![Before](before/gameover-loss-390.jpg) | ![After](after/gameover-loss-390.jpg) |
| Spectator: pick a seat | ![Before](before/spectator-choose-390.jpg) | ![After](after/spectator-choose-390.jpg) |
| Match history | ![Before](before/history-390.jpg) | ![After](after/history-390.jpg) |
| Stats | ![Before](before/stats-390.jpg) | ![After](after/stats-390.jpg) |

## Bridge, other sizes and the 2.5D view

| Screen | Before | After |
| --- | --- | --- |
| Play, 360 × 740 | ![Before](before/play-classic-360.jpg) | ![After](after/play-classic-360.jpg) |
| Play, landscape 844 × 390 | ![Before](before/play-classic-844x390.jpg) | ![After](after/play-classic-844x390.jpg) |
| Play, tablet 820 × 1180 | ![Before](before/play-classic-820.jpg) | ![After](after/play-classic-820.jpg) |
| 2.5D lobby, phone | ![Before](before/lobby-25d-390.jpg) | ![After](after/lobby-25d-390.jpg) |
| 2.5D bidding, phone | ![Before](before/bidding-25d-390.jpg) | ![After](after/bidding-25d-390.jpg) |
| 2.5D play, phone | ![Before](before/play-25d-390.jpg) | ![After](after/play-25d-390.jpg) |
| 2.5D results, phone | ![Before](before/gameover-25d-390.jpg) | ![After](after/gameover-25d-390.jpg) |

## Bridge, desktop 1366 × 900

| Screen | Before | After |
| --- | --- | --- |
| Home | ![Before](before/home-1366.jpg) | ![After](after/home-1366.jpg) |
| Lobby | ![Before](before/lobby-classic-1366.jpg) | ![After](after/lobby-classic-1366.jpg) |
| Bidding | ![Before](before/bidding-classic-1366.jpg) | ![After](after/bidding-classic-1366.jpg) |
| Calling a partner | ![Before](before/partner-classic-1366.jpg) | ![After](after/partner-classic-1366.jpg) |
| Play | ![Before](before/play-classic-1366.jpg) | ![After](after/play-classic-1366.jpg) |
| Results | ![Before](before/gameover-classic-1366.jpg) | ![After](after/gameover-classic-1366.jpg) |
| 2.5D play | ![Before](before/play-25d-1366.jpg) | ![After](after/play-25d-1366.jpg) |
| Match history | ![Before](before/history-1366.jpg) | ![After](after/history-1366.jpg) |
| Stats | ![Before](before/stats-1366.jpg) | ![After](after/stats-1366.jpg) |
