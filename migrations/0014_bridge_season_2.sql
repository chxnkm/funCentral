-- Bridge Season 2: schedule row and per-group season statistics.
-- Additive only. Season 2 starts fresh on 1 December 2026, 00:00 Singapore
-- time (2026-11-30 16:00 UTC), rated by the 'season-2' skill rating. The code
-- schedule in src/seasons.ts decides which season a hand belongs to (by when it
-- was dealt) and tests check that this row matches it. Season 1 stays the
-- active row until the season-close runbook archives it (docs/bridge-rating.md).

INSERT OR IGNORE INTO bridge_seasons (season_id, name, rating_system, status, started_at)
VALUES (2, 'Season 2', 'season-2', 'planned', 1796054400);

-- Verified group members' rated hands per season, for group boards from
-- Season 2 on. Season 1 group boards keep using group_stats.
CREATE TABLE IF NOT EXISTS bridge_season_group_stats (
  season_id    INTEGER NOT NULL,
  group_id     TEXT    NOT NULL,
  telegram_id  INTEGER NOT NULL,
  wins         INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, group_id, telegram_id)
);
