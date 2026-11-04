import type { D1Database } from '@cloudflare/workers-types';
import type { Player, Hand } from './types';
import { CARD_SUITS } from './types';
import { effectiveTelegramId, type BridgeCompletion } from './bridge-completion';

function handToCards(hand: Hand): string[] {
  return CARD_SUITS.flatMap((suit) => hand[suit].map((v) => `${v} ${suit}`));
}

/**
 * Writes (or, after an all-pass redeal, rewrites) each seat's dealt hand.
 * The original played_at is kept so the participation index stays stable.
 */
export async function insertGameHands(
  db: D1Database,
  gameId: string,
  players: Player[],
  hands: Hand[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stmts = players.map((p) =>
    db.prepare(
      `INSERT INTO game_hands (game_id, seat, player_name, telegram_id, initial_hand, played_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, seat) DO UPDATE SET
         player_name = excluded.player_name,
         telegram_id = excluded.telegram_id,
         initial_hand = excluded.initial_hand`,
    ).bind(gameId, p.seat, p.name, effectiveTelegramId(p), JSON.stringify(handToCards(hands[p.seat])), now),
  );
  await db.batch(stmts);
}

/**
 * Writes the replay log for a finished hand (practice included) in one transaction:
 * every seat's dealt and final hand, each card played and the hand's metadata.
 * Safe to repeat: hands are upserted from the room's authoritative record, and
 * tricks/metadata are insert-once.
 */
export async function persistGameLog(db: D1Database, c: BridgeCompletion): Promise<void> {
  const playedAt = Math.floor(c.completedAt / 1000);
  const hands = c.players.map((p) =>
    db.prepare(
      `INSERT INTO game_hands (game_id, seat, player_name, telegram_id, initial_hand, final_hand, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, seat) DO UPDATE SET
         player_name = excluded.player_name,
         telegram_id = excluded.telegram_id,
         initial_hand = excluded.initial_hand,
         final_hand = excluded.final_hand`,
    ).bind(
      c.gameId, p.seat, p.name, effectiveTelegramId(p),
      JSON.stringify(handToCards(c.initialHands[p.seat])),
      JSON.stringify(handToCards(c.finalHands[p.seat])),
      playedAt,
    ),
  );
  const tricks = c.trickLog.map((e) =>
    db.prepare(
      `INSERT OR IGNORE INTO game_tricks (game_id, trick_num, play_order, seat, card)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(c.gameId, e.trickNum, e.playOrder, e.seat, e.card),
  );
  const metadata = db
    .prepare(
      `INSERT OR IGNORE INTO game_metadata
         (game_id, bidder_seat, bid_num, trump_suit, partner_card,
          bid_history, seat_map, tricks_won, winning_team, played_at, is_practice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      c.gameId,
      c.bidder,
      c.bid,
      c.trumpSuit,
      c.partnerCard ?? '',
      JSON.stringify(c.bidHistory),
      JSON.stringify(c.players.map((p) => ({ seat: p.seat, name: p.name }))),
      JSON.stringify(c.sets),
      c.bidderWon ? 'bidder' : 'opponents',
      playedAt,
      c.isPractice ? 1 : 0,
    );
  await db.batch([...hands, ...tricks, metadata]);
}
