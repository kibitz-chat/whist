/** A standard 52-card deck and helpers. Ranks 2..14 (J=11, Q=12, K=13, A=14). */

export type Suit = 'C' | 'D' | 'H' | 'S'
export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S']
export const SUIT_SYMBOL: Record<Suit, string> = { C: '♣', D: '♦', H: '♥', S: '♠' }
export const RANKS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

export interface Card {
  suit: Suit
  rank: number
}

export const cardId = (c: Card): string => `${c.suit}${c.rank}`
export const sameCard = (a: Card, b: Card): boolean => a.suit === b.suit && a.rank === b.rank

const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
export const rankLabel = (r: number): string => RANK_LABEL[r] ?? String(r)
export const cardLabel = (c: Card): string => `${rankLabel(c.rank)}${SUIT_SYMBOL[c.suit]}`

export function fullDeck(): Card[] {
  const d: Card[] = []
  for (const suit of SUITS) for (const rank of RANKS) d.push({ suit, rank })
  return d
}

export type Rng = () => number

/** Fisher–Yates with an injectable RNG (seeded for deterministic tests/deals). */
export function shuffle<T>(arr: readonly T[], rng: Rng = Math.random): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** mulberry32 — a tiny deterministic PRNG for reproducible deals (host-authoritative
 *  shuffles are seeded so every client can verify, and tests are repeatable). */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
