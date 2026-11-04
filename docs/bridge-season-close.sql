-- Season 1 close: archive the final legacy Bridge standings, mark Season 1
-- closed and Season 2 active. WRITES DATA. Run as part of the season-close
-- runbook in docs/bridge-rating.md, after Season 2 has started (1 December
-- 2026, 00:00 SGT), once every hand dealt in Season 1 has finished and its
-- results are persisted, and after noting a D1 Time Travel bookmark.
-- Season 1 data stops changing once its last hand is recorded (Season 2 hands
-- never touch users.elo, users counters, elo_history or group_stats), so this
-- copy is the final Season 1 standing whenever it runs. Nothing is deleted or
-- reset, and the two archive inserts can be rerun safely.
-- Each block starts with a "-- name:" line and holds exactly one statement.
-- tests/bridge-rating-queries.test.ts runs every block against the local schema.

-- name: archive-season-1-standings
-- Copies the final legacy standings (rank by users.elo). Role counts use
-- Season 1 hands only.
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
  AND gr.game_id NOT IN (SELECT game_id FROM bridge_game_ledger WHERE season_id > 1)
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
UPDATE bridge_seasons SET status = 'closed', ended_at = (SELECT started_at FROM bridge_seasons WHERE season_id = 2)
WHERE season_id = 1 AND status = 'active';

-- name: activate-season-2
UPDATE bridge_seasons SET status = 'active'
WHERE season_id = 2 AND status = 'planned' AND NOT EXISTS (SELECT 1 FROM bridge_seasons WHERE status = 'active');
