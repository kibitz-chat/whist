import { describe, expect, it } from 'vitest'
import { type Card, type Suit, cardId, sameCard, seededRng } from './cards'
import {
  GAME_TARGET,
  type Seat,
  type WhistState,
  deal,
  isLegal,
  legalMoves,
  nextHand,
  nextSeat,
  partnerOf,
  playCard,
  resolveTrick,
  teamOf,
  trickWinner,
} from './whist'

const c = (suit: Suit, rank: number): Card => ({ suit, rank })

describe('seating', () => {
  it('partners sit opposite', () => {
    expect(partnerOf(0)).toBe(2)
    expect(partnerOf(1)).toBe(3)
    expect(partnerOf(2)).toBe(0)
    expect(partnerOf(3)).toBe(1)
  })
  it('teams are N+S vs E+W', () => {
    expect(teamOf(0)).toBe(0)
    expect(teamOf(2)).toBe(0)
    expect(teamOf(1)).toBe(1)
    expect(teamOf(3)).toBe(1)
  })
  it('turn order is clockwise', () => {
    expect(nextSeat(0)).toBe(1)
    expect(nextSeat(3)).toBe(0)
  })
})

describe('deal', () => {
  it('gives every seat 13 distinct cards (52 total, no dupes)', () => {
    const s = deal(0, seededRng(42))
    expect(s.hands.map((h) => h.length)).toEqual([13, 13, 13, 13])
    const all = s.hands.flat().map(cardId)
    expect(new Set(all).size).toBe(52)
  })
  it('sets trump from the dealer\'s turned-up last card', () => {
    const s = deal(0, seededRng(42))
    expect(s.trump).toBe(s.trumpCard.suit)
    // The trump card belongs to the dealer's hand (it was the 52nd dealt to seat 0).
    expect(s.hands[0].some((card) => sameCard(card, s.trumpCard))).toBe(true)
  })
  it('eldest hand (left of dealer) leads', () => {
    const s = deal(0, seededRng(1))
    expect(s.turn).toBe(1)
    expect(s.trick.leader).toBe(1)
    expect(s.phase).toBe('playing')
  })
  it('is deterministic for a given seed', () => {
    const a = deal(2, seededRng(99))
    const b = deal(2, seededRng(99))
    expect(a.hands.map((h) => h.map(cardId))).toEqual(b.hands.map((h) => h.map(cardId)))
    expect(a.trumpCard).toEqual(b.trumpCard)
  })
})

describe('legalMoves', () => {
  it('must follow the led suit when able', () => {
    let s = deal(0, seededRng(7))
    const leader = s.turn
    // Lead any card; partner/opponents must follow if they hold the suit.
    const lead = s.hands[leader][0]
    s = playCard(s, leader, lead)
    const next = s.turn
    const hasLed = s.hands[next].some((card) => card.suit === lead.suit)
    const moves = legalMoves(s, next)
    if (hasLed) {
      expect(moves.every((m) => m.suit === lead.suit)).toBe(true)
    } else {
      expect(moves.length).toBe(s.hands[next].length)
    }
  })
  it('any card is legal when leading', () => {
    const s = deal(0, seededRng(7))
    const moves = legalMoves(s, s.turn)
    expect(moves.length).toBe(13)
  })
  it('returns nothing out of turn or when not playing', () => {
    const s = deal(0, seededRng(7))
    const notTurn = nextSeat(s.turn)
    expect(legalMoves(s, notTurn)).toEqual([])
  })
})

describe('trickWinner', () => {
  const trump: Suit = 'S'
  it('highest card of the led suit wins when no trump played', () => {
    const w = trickWinner(
      {
        leader: 0,
        plays: [
          { seat: 0, card: c('H', 10) },
          { seat: 1, card: c('H', 14) },
          { seat: 2, card: c('H', 2) },
          { seat: 3, card: c('C', 14) }, // off-suit, not trump — cannot win
        ],
      },
      trump,
    )
    expect(w).toBe(1)
  })
  it('a trump beats the led suit', () => {
    const w = trickWinner(
      {
        leader: 0,
        plays: [
          { seat: 0, card: c('H', 14) },
          { seat: 1, card: c('S', 2) }, // low trump
          { seat: 2, card: c('H', 13) },
          { seat: 3, card: c('D', 14) },
        ],
      },
      trump,
    )
    expect(w).toBe(1)
  })
  it('highest trump wins when several are played', () => {
    const w = trickWinner(
      {
        leader: 0,
        plays: [
          { seat: 0, card: c('S', 5) },
          { seat: 1, card: c('S', 13) },
          { seat: 2, card: c('S', 9) },
          { seat: 3, card: c('S', 11) },
        ],
      },
      trump,
    )
    expect(w).toBe(1)
  })
})

describe('playCard', () => {
  it('rejects an illegal / out-of-turn move by returning the same state', () => {
    const s = deal(0, seededRng(7))
    const wrongSeat = nextSeat(s.turn)
    const same = playCard(s, wrongSeat, s.hands[wrongSeat][0])
    expect(same).toBe(s)
  })
  it('advances the turn clockwise within a trick', () => {
    const s = deal(0, seededRng(7))
    const leader = s.turn
    const s2 = playCard(s, leader, legalMoves(s, leader)[0])
    expect(s2.turn).toBe(nextSeat(leader))
    expect(s2.trick.plays.length).toBe(1)
    expect(s2.hands[leader].length).toBe(12)
  })
  it('does not mutate the input state', () => {
    const s = deal(0, seededRng(7))
    const before = s.hands[s.turn].length
    playCard(s, s.turn, legalMoves(s, s.turn)[0])
    expect(s.hands[s.turn].length).toBe(before)
  })
  it('freezes the trick at the 4th card, then resolveTrick awards it and the winner leads', () => {
    let s = deal(0, seededRng(7))
    for (let i = 0; i < 4; i++) s = playCard(s, s.turn, legalMoves(s, s.turn)[0])
    // Frozen for display: full 4-card trick, no tricks awarded yet, no plays allowed.
    expect(s.phase).toBe('trickComplete')
    expect(s.trick.plays.length).toBe(4)
    expect(s.tricksWon[0] + s.tricksWon[1]).toBe(0)
    expect(legalMoves(s, s.turn)).toEqual([])
    // Resolve → one trick awarded, cleared, and the winner is on lead.
    s = resolveTrick(s)
    expect(s.tricksWon[0] + s.tricksWon[1]).toBe(1)
    expect(s.trick.plays.length).toBe(0)
    if (s.phase === 'playing') expect(s.turn).toBe(s.trick.leader)
  })
})

/** Drive a full hand to completion using a simple legal-first policy, resolving each
 *  completed trick (the 4th card now freezes it in 'trickComplete'). */
function playHand(start: WhistState): WhistState {
  let s = start
  let guard = 0
  while (s.phase === 'playing' || s.phase === 'trickComplete') {
    s = s.phase === 'trickComplete' ? resolveTrick(s) : playCard(s, s.turn, legalMoves(s, s.turn)[0])
    if (++guard > 120) throw new Error('hand did not terminate')
  }
  return s
}

describe('a full hand', () => {
  it('plays exactly 13 tricks and scores tricks over six', () => {
    const s = playHand(deal(0, seededRng(123)))
    const total = s.tricksWon[0] + s.tricksWon[1]
    expect(total).toBe(13)
    // Whichever team took more than six gets that many points; the other gets none.
    const over0 = Math.max(0, s.tricksWon[0] - 6)
    const over1 = Math.max(0, s.tricksWon[1] - 6)
    expect(s.scores[0]).toBe(over0)
    expect(s.scores[1]).toBe(over1)
    expect(['handOver', 'gameOver']).toContain(s.phase)
  })
})

describe('a full game', () => {
  it('reaches GAME_TARGET and declares a winner', () => {
    let s = deal(0, seededRng(2024))
    let guard = 0
    while (s.phase !== 'gameOver') {
      s = playHand(s)
      if (s.phase === 'handOver') s = nextHand(s, seededRng(1000 + guard))
      if (++guard > 200) throw new Error('game did not terminate')
    }
    expect(s.winner).not.toBeNull()
    const champ = s.winner as 0 | 1
    expect(s.scores[champ]).toBeGreaterThanOrEqual(GAME_TARGET)
    // nextHand is a no-op once the game is over.
    expect(nextHand(s, seededRng(1))).toBe(s)
  })
})

describe('isLegal', () => {
  it('agrees with legalMoves', () => {
    const s = deal(0, seededRng(55))
    const seat = s.turn as Seat
    for (const card of s.hands[seat]) {
      expect(isLegal(s, seat, card)).toBe(legalMoves(s, seat).some((m) => sameCard(m, card)))
    }
  })
})
