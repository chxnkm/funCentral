-- Bridge rating foundation: seasons, archived standings, a per-hand completion
-- ledger, starting-hand features and the shadow skill rating.
-- Additive only (CREATE ... IF NOT EXISTS and one seed row). No existing Bridge
-- table, rating, counter or history row is changed. Bridge play and the legacy
-- Elo keep working before this migration is applied. Only the shadow data and
-- season tables are missing until then. See docs/bridge-rating.md.

-- One row per season. Season 1 is the current legacy Elo season (users.elo).
-- A later season names the bridge_ratings.system that ranks it.
CREATE TABLE IF NOT EXISTS bridge_seasons (
  season_id     INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  rating_system TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK(status IN ('planned', 'active', 'closed')),
  started_at    INTEGER,
  ended_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_seasons_one_active ON bridge_seasons(status) WHERE status = 'active';

INSERT OR IGNORE INTO bridge_seasons (season_id, name, rating_system, status, started_at)
SELECT 1, 'Season 1', 'elo-v1', 'active', COALESCE(MIN(played_at), CAST(strftime('%s', 'now') AS INTEGER))
FROM game_records;

-- Final standings copied when a season closes. Empty until then.
CREATE TABLE IF NOT EXISTS bridge_season_standings (
  season_id        INTEGER NOT NULL,
  telegram_id      INTEGER NOT NULL,
  display_name     TEXT    NOT NULL,
  rank             INTEGER NOT NULL,
  rating           INTEGER NOT NULL,
  games            INTEGER NOT NULL,
  wins             INTEGER NOT NULL,
  bidder_games     INTEGER NOT NULL DEFAULT 0,
  bidder_wins      INTEGER NOT NULL DEFAULT 0,
  partner_games    INTEGER NOT NULL DEFAULT 0,
  partner_wins     INTEGER NOT NULL DEFAULT 0,
  opposition_games INTEGER NOT NULL DEFAULT 0,
  opposition_wins  INTEGER NOT NULL DEFAULT 0,
  archived_at      INTEGER NOT NULL,
  PRIMARY KEY (season_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS bridge_season_group_standings (
  season_id    INTEGER NOT NULL,
  group_id     TEXT    NOT NULL,
  telegram_id  INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  rating       INTEGER NOT NULL,
  wins         INTEGER NOT NULL,
  games_played INTEGER NOT NULL,
  archived_at  INTEGER NOT NULL,
  PRIMARY KEY (season_id, group_id, telegram_id)
);

-- One row per finished or abandoned hand, practice included. Its presence also
-- marks the shadow rating as applied for that hand.
CREATE TABLE IF NOT EXISTS bridge_game_ledger (
  game_id            TEXT    PRIMARY KEY,
  season_id          INTEGER,
  room_code          TEXT    NOT NULL,
  group_id           TEXT,
  status             TEXT    NOT NULL CHECK(status IN ('completed', 'abandoned')),
  is_practice        INTEGER NOT NULL,
  has_bot            INTEGER NOT NULL,
  has_replacement    INTEGER NOT NULL,
  is_solo            INTEGER,
  redeal_count       INTEGER NOT NULL,
  bidder_seat        INTEGER,
  partner_seat       INTEGER,
  bid_num            INTEGER,
  trump_suit         TEXT,
  bidder_won         INTEGER,
  bidder_tricks      INTEGER,
  tricks_played      INTEGER NOT NULL,
  sets_needed        INTEGER,
  bidder_side_hcp    INTEGER,
  bidder_side_trumps INTEGER,
  legacy_expected    REAL,
  skill_expected     REAL,
  skill_applied      INTEGER NOT NULL,
  skill_reason       TEXT,
  dealt_at           INTEGER,
  completed_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bridge_game_ledger_season ON bridge_game_ledger(season_id, completed_at);

-- Starting-hand strength for every seat (bots too): high-card points
-- (A=4 K=3 Q=2 J=1), points with the wash rule's length bonus, suit lengths
-- and trump length. Recorded for insight and later modelling, not rating.
CREATE TABLE IF NOT EXISTS bridge_deal_features (
  game_id     TEXT    NOT NULL,
  seat        INTEGER NOT NULL,
  telegram_id INTEGER,
  is_bot      INTEGER NOT NULL,
  role        TEXT    CHECK(role IN ('bidder', 'partner', 'opposition')),
  hcp         INTEGER NOT NULL,
  points      INTEGER NOT NULL,
  clubs       INTEGER NOT NULL,
  diamonds    INTEGER NOT NULL,
  hearts      INTEGER NOT NULL,
  spades      INTEGER NOT NULL,
  shape       TEXT    NOT NULL,
  trumps      INTEGER,
  won         INTEGER,
  PRIMARY KEY (game_id, seat)
);

CREATE INDEX IF NOT EXISTS idx_bridge_deal_features_player ON bridge_deal_features(telegram_id);

-- Ratings per rating system ('skill-v1' is the shadow rating). Ratings are
-- stored unrounded and display code rounds.
CREATE TABLE IF NOT EXISTS bridge_ratings (
  system      TEXT    NOT NULL,
  telegram_id INTEGER NOT NULL,
  rating      REAL    NOT NULL,
  games       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (system, telegram_id)
);

-- One row per rated human per hand, with the legacy Elo change alongside for
-- comparison. delta is the proposed change and moved the rating only when
-- applied = 1 (reason says why a hand was recorded without applying it).
CREATE TABLE IF NOT EXISTS bridge_rating_events (
  system        TEXT    NOT NULL,
  game_id       TEXT    NOT NULL,
  telegram_id   INTEGER NOT NULL,
  seat          INTEGER NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('bidder', 'partner', 'opposition')),
  applied       INTEGER NOT NULL,
  reason        TEXT,
  rating_before REAL,
  games_before  INTEGER,
  k             REAL,
  team_rating   REAL,
  opp_rating    REAL,
  expected      REAL,
  score         INTEGER NOT NULL,
  delta         REAL,
  rating_after  REAL,
  legacy_before INTEGER,
  legacy_delta  INTEGER,
  played_at     INTEGER NOT NULL,
  PRIMARY KEY (system, game_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_rating_events_player ON bridge_rating_events(system, telegram_id, played_at);
