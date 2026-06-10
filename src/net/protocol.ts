/**
 * The wire protocol for multiplayer Whist, carried on Kibitz's opaque app channel
 * (controller.broadcast / controller.onMessage). Kibitz never inspects these — it
 * just structured-clones them between peers — so we namespace every message with
 * `ns: 'whist'` to coexist with anything else riding the same channel, and we carry
 * a stable `by`/`uid` in the payload because the channel does NOT tell the receiver
 * who sent a message (and the participant `id` is a per-connection media id that
 * changes on reconnect — only our own `uid` is stable).
 *
 * One peer is the HOST (deterministically elected: lowest `uid` present). The host
 * owns the authoritative game and is the only one that mutates it; everyone else
 * sends intents and renders the host's broadcast snapshots.
 */
import type { Card, Suit } from '../engine/cards'
import type { Seat, Team, Trick } from '../engine/whist'

export const NS = 'whist'

export type Phase = 'lobby' | 'playing' | 'trickComplete' | 'handOver' | 'gameOver'

/** Everything every player is allowed to see (no hidden hands — only counts). */
export interface PublicState {
  dealer: Seat
  turn: Seat
  trump: Suit | null
  trumpCard: Card | null
  trick: Trick
  lastTrick: Trick | null
  /** Cards remaining in each seat's hand (so opponents render face-down fans). */
  handCounts: [number, number, number, number]
  tricksWon: [number, number]
  scores: [number, number]
  handNumber: number
  phase: Phase
  winner: Team | null
  /** Stable uid occupying each seat, or null for a bot/empty seat. */
  seatUid: (string | null)[]
  /** Display label for each seat (human name or bot name). */
  seatName: string[]
  /** Per seat: currently played by AI (empty seat OR the assigned human is away). */
  seatBot: boolean[]
  /** The uid of the peer that authored this snapshot — the live host. Lets everyone
   *  defer to a STICKY host (instead of usurping it by being a lower uid). */
  host: string
}

export const emptyPublic = (): PublicState => ({
  dealer: 0,
  turn: 0,
  trump: null,
  trumpCard: null,
  trick: { leader: 0, plays: [] },
  lastTrick: null,
  handCounts: [0, 0, 0, 0],
  tricksWon: [0, 0],
  scores: [0, 0],
  handNumber: 0,
  phase: 'lobby',
  winner: null,
  seatUid: [null, null, null, null],
  seatName: ['', '', '', ''],
  seatBot: [false, false, false, false],
  host: '',
})

/**
 * Host → everyone: the authoritative snapshot. `hands` carries each seated HUMAN's
 * own cards, keyed by uid; a default client reads only its own entry. (The channel
 * is a shared P2P broadcast, so this is a friendly-table trust model — see README.)
 */
export interface StateMsg {
  ns: typeof NS
  t: 'state'
  v: number
  pub: PublicState
  hands: Record<string, Card[]>
}

/** Client → host: I (uid `by`) want to play this card. */
export interface PlayMsg {
  ns: typeof NS
  t: 'play'
  by: string
  card: Card
}

/** Anyone → host: start a brand-new game with the current seats. */
export interface NewGameMsg {
  ns: typeof NS
  t: 'newgame'
  by: string
}

/** Anyone → host: deal the next hand now (skip the auto-advance pause). */
export interface NextMsg {
  ns: typeof NS
  t: 'next'
  by: string
}

/** Newcomer → host: I just connected, please (re)broadcast the current state. */
export interface HelloMsg {
  ns: typeof NS
  t: 'hello'
  by: string
}

/** Anyone → everyone: a table-chat line. Relayed to all peers by the call authority,
 *  so it reaches every seat AND every spectating kibitzer. `name` is carried so a
 *  receiver can label it without a roster lookup (a kibitzer agent has no UI roster). */
export interface ChatMsg {
  ns: typeof NS
  t: 'chat'
  by: string
  name: string
  text: string
}

export type GameMsg = StateMsg | PlayMsg | NewGameMsg | NextMsg | HelloMsg | ChatMsg

/** One rendered chat line (what the UI and the kibitzer agent consume). */
export interface ChatLine {
  by: string
  name: string
  text: string
}

/** Narrow an opaque app-channel payload to one of ours (ignores foreign traffic). */
export function asGameMsg(data: unknown): GameMsg | null {
  if (!data || typeof data !== 'object') return null
  const m = data as { ns?: unknown; t?: unknown }
  if (m.ns !== NS || typeof m.t !== 'string') return null
  return data as GameMsg
}
