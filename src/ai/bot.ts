/**
 * A small, honest heuristic bot — enough to fill empty seats so one or two humans
 * can still play a full table (exactly like iwhist's 1-human-vs-3-AI default). It
 * is intentionally simple: a real opponent AI is a separate concern and not the
 * point of this reference design.
 *
 *   Leading   → lead the highest card of our longest non-trump suit.
 *   Following → if a partner is winning, throw our lowest; else win as cheaply as
 *               possible; if we can't win, duck with our lowest.
 *
 * "Lowest" keeps trumps in reserve by treating them as high-value to discard last.
 */
import type { Card, Suit } from '../engine/cards'
import { type Seat, type WhistState, legalMoves, teamOf, trickWinner } from '../engine/whist'

const discardValue = (c: Card, trump: Suit | null): number => (c.suit === trump ? 100 + c.rank : c.rank)

const lowest = (cards: Card[], trump: Suit | null): Card =>
  cards.reduce((lo, c) => (discardValue(c, trump) < discardValue(lo, trump) ? c : lo))

const trickValue = (c: Card, led: Suit, trump: Suit | null): number =>
  c.suit === trump ? 100 + c.rank : c.suit === led ? c.rank : -1

function leadCard(moves: Card[], trump: Suit | null): Card {
  const bySuit = new Map<Suit, Card[]>()
  for (const c of moves) (bySuit.get(c.suit) ?? bySuit.set(c.suit, []).get(c.suit)!).push(c)
  let best: Card[] | null = null
  for (const [suit, cards] of bySuit) {
    if (best && suit === trump && bySuit.size > 1) continue // avoid opening trumps if we have a choice
    if (!best || cards.length > best.length) best = cards
  }
  const pick = best ?? moves
  return pick.reduce((hi, c) => (c.rank > hi.rank ? c : hi))
}

export function botMove(state: WhistState, seat: Seat): Card {
  const moves = legalMoves(state, seat)
  if (moves.length <= 1) return moves[0]

  const trick = state.trick
  if (trick.plays.length === 0) return leadCard(moves, state.trump)

  const led = trick.plays[0].card.suit
  const winnerSeat = trickWinner(trick, state.trump)
  const bestVal = trickValue(trick.plays.find((p) => p.seat === winnerSeat)!.card, led, state.trump)

  if (teamOf(winnerSeat) === teamOf(seat)) return lowest(moves, state.trump) // partner has it

  const winning = moves.filter((c) => trickValue(c, led, state.trump) > bestVal)
  return winning.length ? lowest(winning, state.trump) : lowest(moves, state.trump)
}
