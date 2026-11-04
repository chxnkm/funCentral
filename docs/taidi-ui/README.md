# Tai Di UI revamp

Captures of the Tai Di client before (master `e823a43`, the same Tai Di client
as `9aee2e9`) and after this change, using the same seeded rooms, dev-only
state patches, Chrome, viewports and taps. They come from a local Worker with
synthetic test players, not production. Phone captures use Chrome mobile
emulation (touch, 2× pixels); this is not iPhone/Safari or Telegram WebView
evidence.

Regenerate with `PLAYWRIGHT_CHANNEL=chrome node tests/ui/taidi-capture.cjs docs/taidi-ui/after --clips`
(the "before" set was taken by running the same script in a checkout of master).
Stills are JPEG (quality 82). Clips are animated PNGs recorded with Chrome's
DevTools screencast at ~9 fps, 5 bits per colour channel (`tests/ui/capture-kit.cjs`,
now shared with the Regicide capture). While recording, the looping ambient
glows (turn ring, ready button, opening-card hint) are paused to keep the files
small; event animations are unchanged.

## What changed

- **Table:** a wood-rimmed felt with every opponent seated around it in turn
  order (the next player sits on your right). Seats show an avatar with a
  spinning turn ring, a card-count badge (amber at 2–3, pulsing red on the last
  card), a fan of card backs, the host crown, and a status bubble — *Thinking*,
  *To lead*, *Pass*, *On top* or *Out first*. Spectators see all four seats.
- **Middle of the table:** the play to beat, fanned, with a tag naming who
  played what; earlier plays of the same trick lie askew underneath; the opening
  3♦ is shown as a ghost card; a free lead says so. Face-up (3 players) and
  out-of-play (2 players) cards are chips.
- **Hand:** larger cards with corner indices, a mirrored corner, centre pips and
  framed court cards. 17–18-card hands on narrow phones use two flat rows so
  every index stays readable and tappable; short landscape screens lay one flat
  row beside the buttons. **Slide** a finger across cards to pick (or drop)
  several at once, and **line up** your next play while others take their turn.
  **Sort** switches rank/suit order and is remembered.
- **Help while playing:** **💡 Hint** cycles every legal play weakest first
  (five-card hands first on a lead); the line above the hand names your combo
  and what it beats, says why a selection can't be played, or — when nothing in
  your hand beats the table — tells you to pass and highlights Pass. The Play
  button names the combination ("Play straight").
- **Log:** a seat-coloured play-by-play with card chips and trick dividers — a
  bottom sheet on phones/tablets (top-bar button, Esc or tap outside to close),
  a column on desktop. Screen readers get a separate polite play-by-play.
- **Results:** medal/podium header, finishing order with avatars, the cards each
  other player was left holding, and rating changes with bars.
- **Lobby and home:** a felt seat grid with host, *you*, offline and
  not-in-group badges; a gold room-code card; the deal for the current player
  count; a home card with real card faces, feature chips and a styled code box;
  on wide screens the leaderboard sits beside it. The rules sheet shows the rank
  and suit ladders and an example for every five-card hand.
- **Animation:** unchanged contract — every state renders at once and new log
  entries replay on a separate layer that never takes input. Opponents' cards now
  flip face up on their way to the felt, the deal sends backs to every seat, 2s
  get a "Big 2!" pop, and combo names pop over the cards. Reduced motion turns
  animations off.
- **Mobile:** the game fills the screen (`100dvh`, safe areas), holds a screen
  wake lock during play, blocks pull-to-refresh and double-tap zoom on the
  table, and keeps Play/Pass on screen at 360×640, 390×844, 844×390 landscape,
  820×1180 and desktop sizes.
- **Server:** once a game is over, the per-player view adds `revealed` (every
  hand), so the results can show what was left. During play it is `null`; no
  rule or protocol changes otherwise.

## Phone, 390 × 844 (and others)

| Screen | Before | After |
| --- | --- | --- |
| Home | ![Before](before/home-390.jpg) | ![After](after/home-390.jpg) |
| Home, signed out | ![Before](before/home-signed-out-390.jpg) | ![After](after/home-signed-out-390.jpg) |
| Lobby (host, 4 players) | ![Before](before/lobby-390.jpg) | ![After](after/lobby-390.jpg) |
| Deal, 0.45 s in | ![Before](before/deal-mid-390.jpg) | ![After](after/deal-mid-390.jpg) |
| Opening lead (must include 3♦) | ![Before](before/open-390.jpg) | ![After](after/open-390.jpg) |
| Straight selected | ![Before](before/combo-390.jpg) | ![After](after/combo-390.jpg) |
| Invalid selection | ![Before](before/invalid-390.jpg) | ![After](after/invalid-390.jpg) |
| Straight in flight | ![Before](before/play-mid-390.jpg) | ![After](after/play-mid-390.jpg) |
| Waiting after four of a kind | ![Before](before/waiting-390.jpg) | ![After](after/waiting-390.jpg) |
| A pair to answer | ![Before](before/pair-390.jpg) | ![After](after/pair-390.jpg) |
| Single selected, someone else on top | ![Before](before/turn-390.jpg) | ![After](after/turn-390.jpg) |
| Last cards | ![Before](before/last-card-390.jpg) | ![After](after/last-card-390.jpg) |
| You win | ![Before](before/win-390.jpg) | ![After](after/win-390.jpg) |
| Someone else wins | ![Before](before/lose-390.jpg) | ![After](after/lose-390.jpg) |
| Two players (17 cards) | ![Before](before/two-players-390.jpg) | ![After](after/two-players-390.jpg) |
| Three players (18 cards, face-up card) | ![Before](before/three-players-390.jpg) | ![After](after/three-players-390.jpg) |
| Watching, 360 × 740 | ![Before](before/watching-360.jpg) | ![After](after/watching-360.jpg) |
| Landscape phone, 844 × 390 | ![Before](before/turn-844x390.jpg) | ![After](after/turn-844x390.jpg) |
| Rules | ![Before](before/rules-390.jpg) | ![After](after/rules-390.jpg) |
| Stats | ![Before](before/stats-390.jpg) | ![After](after/stats-390.jpg) |

## Tablet and desktop

| Screen | Before | After |
| --- | --- | --- |
| Tablet 820 × 1180, your turn | ![Before](before/turn-820.jpg) | ![After](after/turn-820.jpg) |
| Home | ![Before](before/home-1366.jpg) | ![After](after/home-1366.jpg) |
| Lobby | ![Before](before/lobby-1366.jpg) | ![After](after/lobby-1366.jpg) |
| Flush selected to beat a straight | ![Before](before/answer-1366.jpg) | ![After](after/answer-1366.jpg) |
| Four of a kind, 0.5 s after playing | ![Before](before/quads-mid-1366.jpg) | ![After](after/quads-mid-1366.jpg) |
| Taking the table | ![Before](before/lead-1366.jpg) | ![After](after/lead-1366.jpg) |
| Spectator | ![Before](before/watching-1366.jpg) | ![After](after/watching-1366.jpg) |
| Three players | ![Before](before/three-players-1366.jpg) | ![After](after/three-players-1366.jpg) |
| Results | ![Before](before/over-1366.jpg) | ![After](after/over-1366.jpg) |

## Animation clips (after)

| Deal | Opening straight | Four of a kind flips in |
| --- | --- | --- |
| ![Deal](after/clip-deal-390.png) | ![Straight](after/clip-straight-390.png) | ![Quads](after/clip-quads-390.png) |

| Passes and the table sweep | Going out |
| --- | --- |
| ![Trick](after/clip-trick-390.png) | ![Win](after/clip-win-390.png) |
