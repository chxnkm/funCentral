-- Bridge rating trial: read-only evaluation and audit queries.
-- Each block starts with a "-- name:" line and holds exactly one statement.
-- tests/bridge-rating-queries.test.ts runs every block against the local schema.
-- Run against production only through the controlled D1 workflow in
-- docs/deployment.md. Every query here is read-only. The Season 1 archive
-- statements live separately in docs/bridge-season-close.sql.

-- name: trial-summary
-- How many hands the shadow rating applied, and why the rest were only recorded.
SELECT status, is_practice, skill_applied, COALESCE(skill_reason, 'applied') AS reason, COUNT(*) AS hands
FROM bridge_game_ledger
GROUP BY status, is_practice, skill_applied, reason
ORDER BY hands DESC;

-- name: prediction-accuracy
-- Brier score (lower is better) of each system's bidder-side expectation on the
-- same hands, plus the bidder side's actual and expected win rate. A gap between
-- bidder_win_rate and the expectations is a structural bidder (or defender) edge.
SELECT COUNT(*) AS hands,
       AVG((legacy_expected - bidder_won) * (legacy_expected - bidder_won)) AS legacy_brier,
       AVG((skill_expected - bidder_won) * (skill_expected - bidder_won)) AS skill_brier,
       AVG(bidder_won) AS bidder_win_rate,
       AVG(legacy_expected) AS legacy_expected,
       AVG(skill_expected) AS skill_expected
FROM bridge_game_ledger
WHERE status = 'completed' AND is_practice = 0 AND is_solo = 0
  AND legacy_expected IS NOT NULL AND skill_expected IS NOT NULL;

-- name: calibration
-- Does a predicted 70% bidder-side chance win about 70% of the time?
SELECT ROUND(skill_expected, 1) AS predicted, COUNT(*) AS hands, AVG(bidder_won) AS actual
FROM bridge_game_ledger
WHERE status = 'completed' AND is_practice = 0 AND skill_expected IS NOT NULL
GROUP BY predicted
ORDER BY predicted;

-- name: partner-gap
-- Is the team average right when bidder and partner ratings are far apart?
SELECT CASE
         WHEN ABS(b.rating_before - p.rating_before) >= 200 THEN '200+'
         WHEN ABS(b.rating_before - p.rating_before) >= 100 THEN '100-199'
         ELSE '<100'
       END AS partner_gap,
       COUNT(*) AS hands, AVG(l.bidder_won) AS actual, AVG(l.skill_expected) AS expected
FROM bridge_game_ledger l
JOIN bridge_rating_events b ON b.game_id = l.game_id AND b.system = 'skill-v1' AND b.role = 'bidder'
JOIN bridge_rating_events p ON p.game_id = l.game_id AND p.system = 'skill-v1' AND p.role = 'partner'
WHERE l.status = 'completed'
GROUP BY partner_gap
ORDER BY partner_gap;

-- name: role-and-deal-strength
-- Win rate by role and by the bidder side's high-card points (40 in the deck).
SELECT f.role,
       CASE WHEN l.bidder_side_hcp >= 24 THEN 'strong 24+'
            WHEN l.bidder_side_hcp >= 18 THEN 'average 18-23'
            ELSE 'weak <18' END AS bidder_side_cards,
       COUNT(*) AS seats, AVG(f.won) AS win_rate, AVG(f.hcp) AS own_hcp
FROM bridge_deal_features f
JOIN bridge_game_ledger l ON l.game_id = f.game_id
WHERE l.status = 'completed' AND l.is_practice = 0 AND l.is_solo = 0 AND f.role IS NOT NULL
GROUP BY f.role, bidder_side_cards
ORDER BY f.role, bidder_side_cards;

-- name: contract-level
-- Underbidding check: success rate and card strength by contract level.
SELECT bid_num / 5 + 1 AS level, COUNT(*) AS hands, AVG(bidder_won) AS made,
       AVG(bidder_side_hcp) AS bidder_side_hcp, AVG(skill_expected) AS skill_expected
FROM bridge_game_ledger
WHERE status = 'completed' AND is_practice = 0
GROUP BY level
ORDER BY level;

-- name: player-bidding-profile
-- Per player: how often they win the auction, at what level, and how their two
-- ratings moved. Look for rating gains concentrated in low, safe contracts.
SELECT e.telegram_id, u.display_name, COUNT(*) AS hands,
       SUM(e.role = 'bidder') AS bids, AVG(CASE WHEN e.role = 'bidder' THEN l.bid_num / 5 + 1 END) AS avg_bid_level,
       AVG(CASE WHEN e.role = 'bidder' THEN e.score END) AS bids_made,
       SUM(CASE WHEN e.applied = 1 THEN e.delta ELSE 0 END) AS skill_change, SUM(e.legacy_delta) AS legacy_change
FROM bridge_rating_events e
JOIN bridge_game_ledger l ON l.game_id = e.game_id
JOIN users u ON u.telegram_id = e.telegram_id
WHERE e.system = 'skill-v1'
GROUP BY e.telegram_id
ORDER BY skill_change DESC;

-- name: solo-contracts
-- Solo hands are recorded but not applied. Is the 1-v-3 average fair?
SELECT COUNT(*) AS hands, AVG(bidder_won) AS made, AVG(skill_expected) AS predicted, AVG(bidder_side_hcp) AS bidder_hcp
FROM bridge_game_ledger
WHERE status = 'completed' AND is_practice = 0 AND is_solo = 1;

-- name: abandoned-hands
-- Selective-quitting check: how far abandoned hands got and who was ahead.
SELECT COUNT(*) AS hands,
       SUM(bidder_tricks IS NULL) AS during_bidding,
       SUM(bidder_tricks IS NOT NULL AND bidder_tricks * 13 < sets_needed * tricks_played) AS bidder_behind_pace,
       SUM(bidder_tricks IS NOT NULL AND bidder_tricks * 13 >= sets_needed * tricks_played) AS bidder_on_pace,
       AVG(tricks_played) AS avg_tricks_played,
       SUM(has_replacement) AS with_bot_replacement
FROM bridge_game_ledger
WHERE status = 'abandoned';

-- name: leaderboard-comparison
-- Side-by-side standings; the shadow rating starts fresh at 1000.
SELECT u.display_name, u.elo AS legacy_elo, u.games_played AS legacy_games,
       ROUND(r.rating) AS skill_rating, r.games AS skill_games,
       CASE WHEN r.games < 20 THEN 'provisional' ELSE '' END AS status
FROM bridge_ratings r
JOIN users u ON u.telegram_id = r.telegram_id
WHERE r.system = 'skill-v1'
ORDER BY r.rating DESC;

-- name: audit-mismatched-hand-logs
-- Hands logged before the redeal fix can show the passed-out deal instead of
-- the one played. A played card missing from the seat's logged starting hand
-- identifies them; exclude these from any card-strength analysis.
SELECT COUNT(DISTINCT t.game_id) AS mismatched_hands
FROM game_tricks t
JOIN game_hands h ON h.game_id = t.game_id AND h.seat = t.seat
WHERE NOT EXISTS (SELECT 1 FROM json_each(h.initial_hand) j WHERE j.value = t.card);

-- name: audit-history-coverage
-- What history exists for an offline replay of both formulas.
SELECT (SELECT COUNT(DISTINCT game_id) FROM game_records) AS rated_hands,
       (SELECT MIN(played_at) FROM game_records) AS first_rated_at,
       (SELECT COUNT(*) FROM game_metadata) AS logged_hands,
       (SELECT COUNT(*) FROM game_metadata WHERE is_practice = 1) AS logged_practice_hands,
       (SELECT COUNT(DISTINCT game_id) FROM game_records WHERE game_id NOT IN (SELECT game_id FROM game_metadata)) AS rated_without_log,
       (SELECT COUNT(*) FROM bridge_game_ledger) AS trial_hands;
