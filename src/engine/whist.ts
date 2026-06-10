/**
 * Classic Whist — the pure, immutable game engine (no UI, no networking).
 *
 * 4 players, 2 fixed partnerships sitting opposite. 13 cards each. The dealer's
 * last card is turned up and its suit is trump. Eldest hand (left of the dealer)
 * leads; players must follow the led suit if able. Highest trump wins a trick,
 * else the highest card of the led suit. Each trick over six ("the book") scores
 * a point for the winning side; first side to 5 wins the game. (No honours.)
 *
 * Every function returns a NEW state — never mutates — so the host can apply moves
 * and broadcast the result, and any client can replay deterministically.
 */
import { type Card, type Rng, type Suit, fullDeck, sameCard, shuffle } from './cards'

/** Seats clockwise: N=0, E=1, S=2, W=3. Partners sit opposite. Teams: 0 = N+S, 1 = E+W. */
export type Seat = 0 | 1 | 2 | 3
export type Team = 0 | 1
export const SEATS: readonly Seat[] = [0, 1, 2, 3]
export const partnerOf = (s: Seat): Seat => ((s + 2) % 4) as Seat
export const teamOf = (s: Seat): Team => (s % 2) as Team
export const nextSeat = (s: Seat): Seat => ((s + 1) % 4) as Seat

export interface Play {
  seat: Seat
  card: Card
}
export interface Trick {
  leader: Seat
  plays: Play[]
}

/** Classic English Whist: first side to this many points wins. */
export const GAME_TARGET = 5

export interface WhistState {
  dealer: Seat
  trump: Suit
  /** The dealer's turned-up card whose suit set trump (kept for display). */
  trumpCard: Card
  hands: Card[][] // by seat; cards still in hand
  turn: Seat
  trick: Trick // the trick in progress
  lastTrick: Trick | null // the previous completed trick (for display)
  tricksWon: [number, number] // by team this hand
  scores: [number, number] // by team this game
  handNumber: number
  /** 'trickComplete' = the 4th card is down and the full trick is frozen for display;
   *  resolveTrick() then awards it and returns to 'playing' (or scores the hand). */
  phase: 'playing' | 'trickComplete' | 'handOver' | 'gameOver'
  winner: Team | null
}

const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, C: 2, D: 3 }
function sortHand(h: Card[]): void {
  h.sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || b.rank - a.rank)
}

/** Deal a fresh hand. Dealer's LAST card (the 52nd dealt) turns up for trump. */
export function deal(
  dealer: Seat,
  rng: Rng = Math.random,
  scores: [number, number] = [0, 0],
  handNumber = 1,
): WhistState {
  const cards = shuffle(fullDeck(), rng)
  const hands: Card[][] = [[], [], [], []]
  // One card at a time, clockwise, starting left of the dealer — the dealer is
  // last in each round, so the 52nd card is the dealer's and turns up for trump.
  let seat = nextSeat(dealer)
  for (let i = 0; i < 52; i++) {
    hands[seat].push(cards[i])
    seat = nextSeat(seat)
  }
  const trumpCard = cards[51]
  for (const h of hands) sortHand(h)
  const eldest = nextSeat(dealer)
  return {
    dealer,
    trump: trumpCard.suit,
    trumpCard,
    hands,
    turn: eldest,
    trick: { leader: eldest, plays: [] },
    lastTrick: null,
    tricksWon: [0, 0],
    scores,
    handNumber,
    phase: 'playing',
    winner: null,
  }
}

export const ledSuit = (t: Trick): Suit | null => (t.plays.length ? t.plays[0].card.suit : null)

/** The cards `seat` may legally play right now (follow the led suit if able). */
export function legalMoves(state: WhistState, seat: Seat): Card[] {
  if (state.phase !== 'playing' || state.turn !== seat) return []
  const hand = state.hands[seat]
  const led = ledSuit(state.trick)
  if (led) {
    const follow = hand.filter((c) => c.suit === led)
    if (follow.length) return follow
  }
  return hand.slice()
}

export const isLegal = (state: WhistState, seat: Seat, card: Card): boolean =>
  legalMoves(state, seat).some((c) => sameCard(c, card))

/** Who wins a completed trick. Only trump or the led suit can win. */
export function trickWinner(trick: Trick, trump: Suit): Seat {
  const led = trick.plays[0].card.suit
  const value = (c: Card): number => (c.suit === trump ? 100 + c.rank : c.suit === led ? c.rank : -1)
  let best = trick.plays[0]
  for (const p of trick.plays) if (value(p.card) > value(best.card)) best = p
  return best.seat
}

/**
 * Apply a play. Returns a NEW state (or the same state unchanged if the move is
 * illegal / out of turn). The 4th card FREEZES the trick in a 'trickComplete' phase
 * (so the full trick can be seen) — call resolveTrick() to award it and continue.
 */
export function playCard(state: WhistState, seat: Seat, card: Card): WhistState {
  if (!isLegal(state, seat, card)) return state
  const hands = state.hands.map((h, i) => (i === seat ? h.filter((c) => !sameCard(c, card)) : h))
  const plays = [...state.trick.plays, { seat, card }]

  if (plays.length < 4) {
    return { ...state, hands, trick: { ...state.trick, plays }, turn: nextSeat(seat) }
  }

  // Trick complete — freeze the full 4-card trick for display; nobody plays during
  // 'trickComplete' (legalMoves gates on phase). `turn` points at the winner so the
  // UI can highlight it. resolveTrick() awards it and advances.
  const trick: Trick = { ...state.trick, plays }
  const winner = trickWinner(trick, state.trump)
  return { ...state, hands, trick, phase: 'trickComplete', turn: winner }
}

/**
 * Award the frozen trick and advance: the winner leads the next trick, or — when the
 * hands are empty — score tricks over six and end the hand/game. No-op unless the
 * phase is 'trickComplete'.
 */
export function resolveTrick(state: WhistState): WhistState {
  if (state.phase !== 'trickComplete') return state
  const trick = state.trick
  const winner = trickWinner(trick, state.trump)
  const tricksWon: [number, number] = [state.tricksWon[0], state.tricksWon[1]]
  tricksWon[teamOf(winner)]++

  if (!state.hands.every((h) => h.length === 0)) {
    return { ...state, trick: { leader: winner, plays: [] }, lastTrick: trick, tricksWon, turn: winner, phase: 'playing' }
  }

  // Hand over → score tricks over six.
  const scores: [number, number] = [state.scores[0], state.scores[1]]
  for (const t of [0, 1] as Team[]) {
    const over = tricksWon[t] - 6
    if (over > 0) scores[t] += over
  }
  const gameWinner: Team | null = scores[0] >= GAME_TARGET ? 0 : scores[1] >= GAME_TARGET ? 1 : null
  return {
    ...state,
    lastTrick: trick,
    tricksWon,
    scores,
    phase: gameWinner !== null ? 'gameOver' : 'handOver',
    winner: gameWinner,
  }
}

/** Start the next hand after 'handOver' — the deal rotates one seat clockwise. */
export function nextHand(state: WhistState, rng: Rng = Math.random): WhistState {
  if (state.phase !== 'handOver') return state
  return deal(nextSeat(state.dealer), rng, state.scores, state.handNumber + 1)
}

/** Total tricks played so far this hand. */
export const tricksPlayed = (state: WhistState): number =>
  state.tricksWon[0] + state.tricksWon[1] + (state.trick.plays.length === 4 ? 0 : 0)
