-- Season 1 close: archive the final legacy Bridge standings and mark the season
-- closed. WRITES DATA. Run only as part of the season-close runbook in
-- docs/bridge-rating.md, after new deals are paused, every room's pending
-- completions are persisted and a D1 backup or Time Travel bookmark is noted.
-- Nothing is deleted or reset: users.elo, counters, history and group_stats are
-- copied, not changed. The two archive inserts can be rerun safely.
-- Each block starts with a "-- name:" line and holds exactly one statement.
-- tests/bridge-rating-queries.test.ts runs every block against the local schema.

-- name: archive-season-1-standings
-- Copies the final legacy standings (rank by users.elo).
INSERT OR IGNORE INTO bridge_season_standings
  (season_id, telegram_id, display_name, rank, rating, games, wins,
   bidder_games, bidder_wins, partner_games, partner_wins, opposition_games, opposition_wins, archived_at)
SELECT 1, u.telegram_id, u.display_name, RANK() OVER (ORDER BY u.elo DESC), u.elo, u.games_played, u.wins,
       COALESCE(SUM(gr.role = 'bidder'), 0), COALESCE(SUM(gr.role = 'bidder' AND gr.won = 1), 0),
       COALESCE(SUM(gr.role = 'partner'), 0), COALESCE(SUM(gr.role = 'partner' AND gr.won = 1), 0),
       COALESCE(SUM(gr.role = 'opposition'), 0), COALESCE(SUM(gr.role = 'opposition' AND gr.won = 1), 0),
       CAST(strftime('%s', 'now') AS INTEGER)
FROM users u
LEFT JOIN game_records gr ON gr.telegram_id = u.telegram_id
WHERE u.games_played > 0
GROUP BY u.telegram_id;

-- name: archive-season-1-group-standings
INSERT OR IGNORE INTO bridge_season_group_standings
  (season_id, group_id, telegram_id, display_name, rating, wins, games_played, archived_at)
SELECT 1, gs.group_id, gs.telegram_id, u.display_name, u.elo, gs.wins, gs.games_played, CAST(strftime('%s', 'now') AS INTEGER)
FROM group_stats gs
JOIN users u ON u.telegram_id = gs.telegram_id
WHERE gs.games_played > 0;

-- name: close-season-1
UPDATE bridge_seasons SET status = 'closed', ended_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE season_id = 1 AND status = 'active';
