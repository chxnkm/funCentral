/**
 * Returns the seat numbers of the winning team.
 * When partner === bidder (called their own card), bidder wins/loses alone.
 */
export function getWinnerSeats(bidder: number, partner: number, bidderWon: boolean): number[] {
  const bidderTeam = bidder === partner ? [bidder] : [bidder, partner];
  if (bidderWon) return bidderTeam;
  return [0, 1, 2, 3].filter((s) => !bidderTeam.includes(s));
}
