# Bridge skill rating: plan, trial and seasons

Status: **Season 1 (legacy Elo) with the rating trial in shadow mode; Season 2
rated by the skill rating from 1 December 2026, 00:00 SGT.** Until then the
boards and posts use the legacy Elo (`users.elo`), unchanged, and the skill
rating is calculated beside it for comparison only.

## The agreed direction

- **One rating per player** for overall ability (bidding, the called card,
  reading the table, card play). It moves on the final result only.
- **Team expectation from both sides' ratings**, using the existing
  team-average formula as the baseline. A weaker partner lowers your side's
  expectation: a win earns more, a loss costs less. Ratings come from the
  start of the hand.
- **Uncertain ratings move more.** New players are provisional and move
  faster, after a win *or* a loss, so the formula never decides which partner
  caused the result. A per-player confidence value (TrueSkill/Glicko style) can
  come later.
- **Cards are recorded, not rated.** Hand strength feeds insight first and a
  deal model only once it is shown to improve predictions without rewarding
  underbidding or choosing easy games. Any later adjustment would be small and
  capped.
- **Special cases first:** solo contracts tracked separately; bot games
  excluded until bot strength is benchmarked; leaver/replacement crediting
  defined before any formula change.
- **Shadow mode, then a new season.** Season 1 (legacy Elo) is archived and
  stays viewable; the validated rating starts as Season 2.

## Review notes and clarifications

These came out of checking the plan against the code. Items marked *fixed*
are in this release.

1. **All-pass redeal logging (fixed).** After four passes the room dealt new
   cards but kept the first deal as the recorded starting hands, in the room
   (game-over recap) and in `game_hands`. Replays, move ratings and any
   card-strength data for those hands were wrong. The redeal now replaces
   both, and the end-of-hand log rewrites the starting hands from the room's
   record. Older logs are detectable (see the audit query).
2. **Completion was not reliable (fixed).** Results were written as four or
   five separate D1 calls before the final state was saved. A failure part-way
   left counters, Elo and history inconsistent with no retry; a retry could
   double-count; an exception could leave the hand unsaved; room cleanup could
   delete a finished hand. Now the final state and a completion record are
   saved together first, and each step is retried until it succeeds. See
   [completion](#how-a-hand-is-completed).
3. **Concurrent hands could lose Elo (fixed).** Elo was written as an absolute
   value read at the end of the hand, so two hands finishing together for the
   same player kept only one change. Changes are now added to the stored value.
4. **Absent players were rated for hands they never played (fixed).** A bot
   replacing a disconnected player kept crediting that player in every later
   hand of the session. Now only humans seated when a hand is dealt receive its
   result. The player who left mid-hand still takes that hand's result, so
   quitting does not avoid a loss. They can still reclaim their seat.
5. **Bidder-side base rate (to measure).** Elo assumes equal teams win 50%.
   If bidder sides win, say, 60% of contracts, players who win more auctions
   drift upwards in either system. The `prediction-accuracy` query compares
   the actual bidder win rate with both expectations; a consistent gap would
   justify a learned bidder (or defender) offset, which is not card strength.
6. **Solo contracts are not zero-sum today.** The legacy formula gives each of
   the three defenders the full change, so a solo result moves three times the
   points on one side. The trial records solo hands without applying them.
7. **Selective quitting exists in a narrow case.** An abandon needs every
   connected human to agree, but if the others are disconnected the initiator
   alone can void a hand. Abandoned hands are now ledgered with how far they
   got and the score, so this can be measured.
8. **Legacy details kept as they were:** the K-factor threshold counts the
   current hand (K = 32 for a player's first 29 games), deltas are rounded per
   player, and bot seats are skipped from team averages. The shadow rating
   fixes these for itself; the legacy Elo is intentionally untouched.

## How a hand is completed

1. On the last trick (or an abandon), the room saves the final state and a
   completion record in one Durable Object storage write, before any D1 or
   Telegram I/O.
2. It then runs each outstanding step. For a finished hand it waits for them
   before sending the final state, so the game-over screen's Elo lookup finds
   the result:
   - **rated** (non-practice): users wins/games, group stats, pair Elo, Elo
     history and `game_records` in **one D1 transaction**. Every write is
     skipped once the hand's `game_records` rows exist, and those rows are
     inserted last, so a repeat is a no-op.
   - **notify**: the group result post, once, after the rated step.
   - **log** (all hands): starting and final hands, every card and metadata,
     as upserts/insert-once in one transaction.
   - **betting**: spectator bets settled in one transaction, only for bets
     still unsettled.
   - **shadow**: the trial record (below), after the rated step.
3. A failed step stays in the record with a backoff (1 minute doubling to 30
   minutes) and an alarm. The room is not cleaned up while anything is
   pending. Shadow failures stop after ten attempts, and are skipped
   immediately if migration `0013` has not been applied.

Code: `src/bridge-completion.ts` (record and message), `src/stats-db.ts`
(`persistRatedResult`), `src/game-logging.ts`, `src/betting-db.ts`,
`src/rating-db.ts` (snapshot and shadow) and `src/skill-rating.ts` (formula).

## The shadow rating (`skill-v1`)

- Starts every player at **1000**, fresh (not seeded from Elo).
- When a hand is dealt the room snapshots each seat's legacy Elo and skill
  rating, plus the active season. That snapshot, not the value at the end of
  the hand, is used for the hand.
- Bidder-side expectation = `1 / (1 + 10^((avg(opponents) − avg(bidder side)) / 400))`,
  the legacy team-average formula.
- Each player's change = `K × (result − expectation)` with their own
  `K = max(16, 40 − games)`: 40 for a new player, 16 from 24 games.
  **Provisional** below 20 games. Ratings are stored unrounded.
- Recorded but **not applied** (with the reason): practice hands, any bot
  dealt in, a mid-hand bot replacement, solo contracts and hands without a
  snapshot. They keep a prediction where every seat has a rating, so the
  formula can still be judged on them.

## Data recorded (migration `0013`)

| Table | Contents |
| --- | --- |
| `bridge_game_ledger` | One row per finished or abandoned hand: season, flags (practice, bot, replacement, solo, redeals), contract, result, tricks, bidder-side high-card points and trumps, legacy and skill expectations, and whether the trial applied it |
| `bridge_deal_features` | Per seat: high-card points (A4 K3 Q2 J1), points with the wash length bonus, suit lengths, shape, trumps, role and result |
| `bridge_rating_events` | Per human per hand: skill rating before/after, games, K, team and opponent averages, expectation, proposed change and the legacy Elo before/change |
| `bridge_ratings` | Current rating per system and player (`skill-v1` now) |
| `bridge_seasons` | Seasons; Season 1 (`elo-v1`) is seeded active |
| `bridge_season_standings`, `bridge_season_group_standings` | Final standings copied when a season closes |

All are additive (`CREATE … IF NOT EXISTS`). Bridge play, legacy Elo and
history work without them.

## Evaluating the trial

[`bridge-rating-queries.sql`](bridge-rating-queries.sql) holds the read-only
queries, each kept executable by `tests/bridge-rating-queries.test.ts`:

- `prediction-accuracy`: Brier score of both systems on the same hands and the
  bidder-side base rate. `calibration` buckets the skill predictions.
- `partner-gap`: whether the team average holds when partners are 100–200+
  apart (the main V1 question).
- `role-and-deal-strength`, `contract-level`, `player-bidding-profile`:
  outcomes by role and hand strength, and signs of rewarded underbidding.
- `solo-contracts`, `abandoned-hands`, `trial-summary`: the special cases.
- `leaderboard-comparison`: standings side by side.
- `audit-history-coverage`, `audit-mismatched-hand-logs`: what history exists
  for an offline replay, and which old hand logs are unreliable.

Log loss is easier offline (export the ledger); D1 may not provide `ln()`.

### What historical data is usable

- `game_records`, `elo_history` and the users counters cover rated hands
  since the stats reset (`0006`). They are enough to replay both formulas
  offline. Some rated hands may have credited a player covered by a bot (item
  4 above); the database cannot identify them.
- `game_hands`/`game_metadata`/`game_tricks` cover hands since `0008`
  (practice participants since `0010`). Exclude hands flagged by the
  mismatched-log audit from any card analysis.
- Rating snapshots, deal features, replacement and redeal flags and abandoned
  hands exist only from this release.

## Seasons

Season 2 starts **fresh at 1000 on 1 December 2026, 00:00 Singapore time**
(2026-11-30 16:00 UTC), decided 2026-11-04. Season 1 is the legacy Elo; the
shadow trial runs until Season 2 starts.

### How the switch works

- The schedule is in code (`src/seasons.ts`); migration `0014` adds the
  matching `bridge_seasons` row and `bridge_season_group_stats`. No deploy or
  database step is needed at midnight.
- **A hand belongs to the season it was dealt in.** A Season 1 hand that ends
  after midnight still updates the legacy Elo; the first hands dealt after
  midnight are Season 2. So deals need no pause at the boundary.
- **Season 2 hands are rated by the `season-2` system** (the `skill-v1`
  formula, every player starting at 1000, provisional below 20 hands) in the
  completion's rated step, retried until it succeeds. The same transaction
  writes the rating events, `game_records` (for the stats screen), per-group
  season statistics, deal features and the ledger.
- **Season 1 data is frozen by construction.** Season 2 hands never touch
  `users.elo`, the users win/game counters, `elo_history` or `group_stats`,
  so the Season 1 board stays exactly as its last hand left it.
- **Rules that change with Season 2** (from the agreed plan): hands dealt with
  a bot and solo contracts are recorded but not rated; a player who leaves
  mid-hand still takes that hand's result, so leaving cannot avoid a loss;
  a hand without a deal-time snapshot is rated from the ratings at the end
  rather than dropped.
- **Reads follow the current season:** the Bridge and group leaderboards, the
  bot's `/leaderboard`, the stats screen, the game-over rating changes, seat
  ratings and the group result post. `?season=1` (the leaderboard card's
  Season switch and the stats screen's season menu, shown once Season 2 has
  started) keeps Season 1 viewable as the final board.

Known incentive to watch: with solo contracts unrated, a bidder can call
their own card to make a hand unrated. Track it with the `solo-contracts`
query and rate solo hands once a fair 1-v-3 formula is agreed.

### Before 1 December

1. Merge the foundation PR and the Season 2 PR.
2. Apply `0014` through the controlled D1 workflow in
   [deployment](deployment.md) (additive, any time before the start).
3. Review the trial queries; tune `skill-v1` constants before the start if
   needed. Season 2 starts fresh, so nothing has to be migrated.
4. Announce the date in the groups.

### After 1 December: close Season 1

1. Wait until hands dealt before midnight have finished and no room has
   pending completions (rooms keep them until persisted; a day is ample).
2. Note a D1 Time Travel bookmark.
3. Run [`bridge-season-close.sql`](bridge-season-close.sql) with wrangler. It
   copies the final standings and group standings into the archive tables
   (role counts from Season 1 hands only), marks Season 1 closed and Season 2
   active. It deletes and resets nothing and can be rerun.
4. Check `/api/leaderboard?season=1` and the archive row counts.

Never use `0006_stats_reset.sql` for a season change: it deletes history.

## Next steps

1. Apply `0014` before 1 December and close Season 1 afterwards (above).
2. Let the trial run, then review the queries above, especially
   `partner-gap`, `prediction-accuracy` and `solo-contracts`.
3. Post-game deal insight (for example "your side held 24 of 40 high-card
   points") using the recorded features. Display only, not rating.
4. Agree a solo formula and benchmark bot strength so those hands can be rated.
