/**
 * GameSession — the multiplayer brain that rides any broadcast transport (the
 * Kibitz controller in production; an in-memory bus in tests).
 *
 * Model: host-authoritative. The peer with the lowest stable `uid` is the HOST. It
 * owns the one true WhistState, fills empty seats with bots, validates every move,
 * and broadcasts authoritative snapshots. Everyone else renders snapshots and sends
 * play intents. The host is itself a seated player, so its own moves are applied
 * locally rather than sent over the wire (you never receive your own broadcast).
 *
 * The transport is broadcast-only (no per-recipient send) and the channel is shared
 * among peers, so per-hand cards are addressed-in-payload, not cryptographically
 * private — a friendly-table trust model. See README.
 */
import type { Card } from '../engine/cards'
import { seededRng } from '../engine/cards'
import {
  SEATS,
  type Seat,
  type WhistState,
  deal,
  isLegal,
  nextHand,
  playCard,
  resolveTrick,
} from '../engine/whist'
import { botMove } from '../ai/bot'
import { type ChatLine, type GameMsg, NS, type PublicState, asGameMsg, emptyPublic } from './protocol'

/** One peer as the transport sees it. `uid` is stable across reconnects. */
export interface Peer {
  uid: string
  name: string
  isSelf: boolean
  /** Per-participant metadata carried on the call roster (Kibitz `meta`). A kibitzer
   *  joins with `{ role: 'kibitzer', watch: <seat> }` so the host can recognise it —
   *  skip seating it AND feed it the watched seat's hand. */
  meta?: Record<string, unknown>
}

/** The seam GameSession needs — satisfied by the Kibitz controller and by tests. */
export interface Transport {
  readonly self: string
  readonly selfName: string
  broadcast(data: unknown): void
  onMessage(cb: (data: unknown) => void): void
  roster(): Peer[]
  onRoster(cb: () => void): () => void
}

/** What the UI renders for the local player. */
export interface LocalView {
  amHost: boolean
  /** Our seat, or null when we're a spectator (table already full). */
  mySeat: Seat | null
  /** Our own cards (empty for spectators). */
  myHand: Card[]
  /** The cards we may legally play right now ([] when it isn't our turn). */
  legal: Card[]
  pub: PublicState
  /** Table chat, oldest-first (shared by seats and spectating kibitzers). */
  chat: ChatLine[]
}

/** A spectator that watches one seat's hand and comments — see [[kibitz]] product. */
const KIBITZER_ROLE = 'kibitzer'
const isKibitzer = (p: Peer): boolean => p.meta?.role === KIBITZER_ROLE

export interface SessionOptions {
  /** Base seed for deals (host only). Fixed for reproducible tests; Date-derived live. */
  seed?: number
  /** ms a bot waits before playing (0 in tests for instant resolution). */
  botDelayMs?: number
  /** ms to linger on a finished hand before auto-dealing the next. */
  handDelayMs?: number
  /** ms to hold a completed (4-card) trick on the table before awarding it, so
   *  everyone can see what was played (0 in tests for instant resolution). */
  trickHoldMs?: number
  /** ms after the roster settles before the host deals the opening hand. */
  startDelayMs?: number
  /** ms a RECONNECTING peer (one that was recently in a game here) waits before
   *  dealing a fresh hand — long, so the existing host re-syncs first and it adopts
   *  that game rather than restarting it. */
  reconnectDelayMs?: number
  /** Injectable timer (tests pass a controllable queue). Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => void
  /** Room id — namespaces the host's saved game so leaving & returning RESUMES the
   *  same game instead of redealing (and dropping the other players). */
  room?: string
  /** Where the host persists its game. Default: window.localStorage (omitted in Node,
   *  so tests don't persist unless they pass a mock). */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }
}

const BOT_NAMES = ['Robin', 'Sandy', 'Alex', 'Pat']

/** The legal moves for a hand given only public info — identical to the engine's
 *  rule, so host and client always agree on what's playable. */
export function legalFor(hand: Card[], pub: PublicState, seat: Seat | null): Card[] {
  if (seat == null || pub.phase !== 'playing' || pub.turn !== seat) return []
  const led = pub.trick.plays.length ? pub.trick.plays[0].card.suit : null
  if (led) {
    const follow = hand.filter((c) => c.suit === led)
    if (follow.length) return follow
  }
  return hand.slice()
}

export class GameSession {
  private readonly tx: Transport
  private readonly self: string
  private readonly seed: number
  private readonly botDelayMs: number
  private readonly handDelayMs: number
  private readonly trickHoldMs: number
  private readonly startDelayMs: number
  private readonly reconnectDelayMs: number
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly room?: string
  private readonly storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }
  /** True if this room shows a recent game in storage — i.e. we're RECONNECTING, so
   *  don't deal eagerly (wait for the existing host to re-sync). */
  private readonly wasInGame: boolean

  // Host-only authoritative state.
  private auth: WhistState | null = null
  private readonly seatByUid = new Map<string, Seat>()
  /** Last-seen display name per uid (so a seat keeps its label while its player is
   *  briefly away — multiplayer resume — instead of flipping to a bot name). */
  private readonly nameByUid = new Map<string, string>()
  /** Table chat, oldest-first. Everyone (host, clients, kibitzers) keeps a copy; a
   *  `chat` broadcast is relayed to all peers by the call authority. */
  private chatLog: ChatLine[] = []
  private ver = 0
  /** Debounce token for the opening deal — bumped on each MEMBERSHIP change so only
   *  the latest scheduled deal fires (peers connect over WebRTC across a second or
   *  two; a one-shot timer would seat only whoever arrived first). */
  private dealGen = 0
  /** The roster's human-uid set at the last deal (re)schedule. Used to ignore the
   *  steady stream of 'participants' events that are really just media/speaking
   *  noise — only an actual membership change should push the deal back. */
  private lastDealKey = ''

  // Latest snapshot every peer keeps (host fills it from `auth`).
  private pub: PublicState = emptyPublic()
  private hands: Record<string, Card[]> = {}

  private view: LocalView
  private viewCbs = new Set<(v: LocalView) => void>()

  constructor(tx: Transport, opts: SessionOptions = {}) {
    this.tx = tx
    this.self = tx.self
    this.seed = opts.seed ?? 1
    this.botDelayMs = opts.botDelayMs ?? 700
    this.handDelayMs = opts.handDelayMs ?? 2200
    this.trickHoldMs = opts.trickHoldMs ?? 1200
    this.startDelayMs = opts.startDelayMs ?? 1500
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 5000
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.room = opts.room
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    this.wasInGame = (() => {
      try {
        return this.room ? !!this.storage?.getItem(`whist.seen.${this.room}`) : false
      } catch {
        return false
      }
    })()
    this.view = { amHost: false, mySeat: null, myHand: [], legal: [], pub: this.pub, chat: [] }

    tx.onMessage((d) => this.onMessage(d))
    tx.onRoster(() => this.onRoster())
    this.onRoster()
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  onView(cb: (v: LocalView) => void): () => void {
    this.viewCbs.add(cb)
    cb(this.view)
    return () => {
      this.viewCbs.delete(cb)
    }
  }

  getView(): LocalView {
    return this.view
  }

  // ── Player actions ───────────────────────────────────────────────────────────

  play(card: Card): void {
    if (this.amHost()) this.hostApplyPlay(this.self, card)
    else this.send({ ns: NS, t: 'play', by: this.self, card })
  }

  /** Start a brand-new game with the current seats (resets scores). */
  newGame(): void {
    if (this.amHost()) this.hostDeal(true)
    else this.send({ ns: NS, t: 'newgame', by: this.self })
  }

  /** Deal the next hand immediately (skip the auto-advance pause). */
  next(): void {
    if (this.amHost()) this.hostNextHand()
    else this.send({ ns: NS, t: 'next', by: this.self })
  }

  /** Post a chat line to the table. Appended locally (we never receive our own
   *  broadcast) and sent to everyone else — seats and kibitzers alike. */
  sendChat(text: string): void {
    const t = text.trim()
    if (!t) return
    const line: ChatLine = { by: this.self, name: this.tx.selfName || 'Player', text: t.slice(0, 280) }
    this.appendChat(line)
    this.send({ ns: NS, t: 'chat', by: line.by, name: line.name, text: line.text })
  }

  /** Append a chat line (capped) and re-render. */
  private appendChat(line: ChatLine): void {
    this.chatLog = [...this.chatLog.slice(-99), line]
    this.refreshView()
  }

  // ── Host election (STICKY) ─────────────────────────────────────────────────────

  /** I'm the host if I'm actively running a game (have `auth`), or — when no live
   *  host exists — I'm the lowest uid present. Crucially, while a live host is around
   *  (it stamps every snapshot with its uid), everyone else DEFERS to it, so a later
   *  joiner with a lower uid can't usurp the game, and a host only changes when the
   *  current one has actually left. */
  private amHost(): boolean {
    if (this.auth) return true
    const present = this.tx.roster().map((p) => p.uid)
    if (!present.length) return false
    const liveHost = this.pub.host
    if (liveHost && liveHost !== this.self && present.includes(liveHost)) return false
    return present.slice().sort()[0] === this.self
  }

  // ── Incoming ─────────────────────────────────────────────────────────────────

  private onMessage(data: unknown): void {
    const m = asGameMsg(data)
    if (!m) return
    if (m.t === 'state') {
      // We're the authority and have a game — ignore anyone else's snapshot (a brief
      // split-brain during reconnect would otherwise clobber the real game).
      if (this.amHost() && this.auth) return
      if (m.v <= this.ver && this.ver !== 0) return // stale snapshot
      this.ver = m.v
      this.pub = m.pub
      this.hands = m.hands
      // We've adopted a host's game, so any earlier "I might deal" debounce is moot —
      // clear it, so that if THIS host later leaves and we take over, the fresh-deal
      // isn't wrongly short-circuited by a matching roster key from before.
      this.lastDealKey = ''
      this.refreshView()
      this.markSeen()
      return
    }
    // Chat is for EVERYONE (seats + spectating kibitzers), not just the host.
    if (m.t === 'chat') {
      this.appendChat({ by: m.by, name: m.name, text: m.text })
      return
    }
    // Host-only intents.
    if (!this.amHost()) return
    if (m.t === 'play') this.hostApplyPlay(m.by, m.card)
    else if (m.t === 'newgame') this.hostDeal(true)
    else if (m.t === 'next') this.hostNextHand()
    else if (m.t === 'hello') this.broadcastState()
  }

  private onRoster(): void {
    this.noteNames()
    // ALWAYS ask the table for the current game. If a host already exists it answers
    // with a 'state' and we adopt it — so a reconnecting peer that momentarily sees
    // only itself (before others re-sync) doesn't wrongly believe it's the host and
    // deal a fresh game, dropping everyone else.
    this.send({ ns: NS, t: 'hello', by: this.self })
    if (this.amHost()) {
      // Reconnecting host with no in-memory game? RESUME the saved one instead of
      // redealing (which would drop the other players). Only deal fresh if there's
      // nothing to resume.
      if (!this.auth && this.tryRestore()) {
        this.publish()
        this.drive()
      } else if (!this.auth) {
        this.scheduleOpeningDeal()
      } else {
        // Seat any present newcomer into a free (bot) chair — immediately, at any
        // time, with NO redeal: they just take over a bot's seat, so the deal, the
        // scores and the teams stay intact. This is what makes a friend who opens the
        // link late (or whose roster sync lagged) actually join the table.
        this.seatNewcomers()
        // ALWAYS republish on a roster change: presence-derived fields (seatBot,
        // seatUid, seatName) must be recomputed for BOTH a newcomer taking a bot's
        // chair AND a player LEAVING (their seat goes bot-driven). publish() is a
        // superset of broadcastState(), so it also catches any newcomer up.
        this.publish()
        // A human may have just left (their seat is now bot-driven) — nudge the
        // driver in case it's that seat's turn and the table is waiting.
        if (this.auth.phase === 'playing' || this.auth.phase === 'trickComplete') this.drive()
      }
    }
    this.refreshView()
  }

  private noteNames(): void {
    for (const p of this.tx.roster()) this.nameByUid.set(p.uid, p.name)
  }

  // ── Host: seating ────────────────────────────────────────────────────────────

  /** Reseat from scratch: present humans take seats 0..3 in uid order. Called only
   *  when a NEW game is dealt, so seats stay stable across hands and a brief absence
   *  doesn't lose anyone's seat mid-game. */
  private hostReseat(): void {
    this.seatByUid.clear()
    for (const uid of this.tx
      .roster()
      .filter((p) => !isKibitzer(p)) // spectators never take a seat
      .map((p) => p.uid)
      .sort()) {
      const used = new Set(this.seatByUid.values())
      const free = SEATS.find((s) => !used.has(s))
      if (free != null) this.seatByUid.set(uid, free)
    }
  }

  private uidAt(seat: Seat): string | null {
    for (const [uid, s] of this.seatByUid) if (s === seat) return uid
    return null
  }

  /** Which seat a kibitzer watches: an explicit 0-3 from its meta, or — for 'auto' /
   *  unspecified — the first seat actually held by a human, so a single-human demo
   *  always watches that player without anyone picking a seat number. Null if no human
   *  is seated yet. (Bot seats have no uid in seatByUid, so uidAt skips them.) */
  private resolveWatchSeat(p: Peer): Seat | null {
    const w = p.meta?.watch
    if (typeof w === 'number' && w >= 0 && w <= 3) return w as Seat
    return SEATS.find((s) => this.uidAt(s) != null) ?? null
  }

  private present(uid: string): boolean {
    return this.tx.roster().some((p) => p.uid === uid)
  }

  /** Seat every present-but-unseated human into a free (bot/empty) seat. Returns
   *  true if anyone was seated. No redeal — they take over a bot's chair, so the
   *  current deal, scores and team structure are preserved. */
  private seatNewcomers(): boolean {
    let seated = false
    for (const p of this.tx.roster()) {
      if (isKibitzer(p)) continue // a kibitzer spectates — never seat it
      if (this.seatByUid.has(p.uid)) continue
      // A returning player whose uid changed (cleared storage / a different browser)
      // reclaims their OWN reserved chair by name, rather than grabbing the next free
      // one — this is what stops a rejoin from landing in the "third slot". Same-uid
      // returns are handled by the `has(uid)` check above and never reach here.
      if (this.reclaimSeatByName(p.uid, p.name)) {
        seated = true
        continue
      }
      const used = new Set(this.seatByUid.values())
      const free = SEATS.find((s) => !used.has(s))
      if (free == null) break // table full
      this.seatByUid.set(p.uid, free)
      seated = true
    }
    return seated
  }

  /** Reassign an ABANDONED seat (its assigned uid is no longer present) to a returning
   *  player matched by name, so a player who lost their stable uid still gets their
   *  original chair back. Friendly-table identity — a name clash with a genuinely new
   *  player is possible but harmless at the table. Returns true on a reclaim. */
  private reclaimSeatByName(newUid: string, name: string): boolean {
    const want = name.trim().toLowerCase()
    if (!want) return false
    for (const [uid, seat] of this.seatByUid) {
      if (this.present(uid)) continue // its owner is here — not abandoned
      const held = (this.nameByUid.get(uid) ?? '').trim().toLowerCase()
      if (held && held === want) {
        this.seatByUid.delete(uid)
        this.seatByUid.set(newUid, seat)
        this.nameByUid.set(newUid, name) // carry the label onto the new uid
        return true
      }
    }
    return false
  }

  /** A seat is bot-driven if no human is assigned, OR its human is currently away
   *  (so the table never stalls; they resume control the instant they return). */
  private isBotSeat(seat: Seat): boolean {
    const uid = this.uidAt(seat)
    return uid == null || !this.present(uid)
  }

  private nameForSeat(seat: Seat): string {
    const uid = this.uidAt(seat)
    if (uid == null) return BOT_NAMES[seat]
    if (uid === this.self) return this.tx.selfName || 'You'
    return this.nameByUid.get(uid) || 'Player'
  }

  // ── Host: dealing & driving ────────────────────────────────────────────────────

  private scheduleOpeningDeal(): void {
    if (this.auth) return // a game is already running
    // Only (re)schedule when the set of present humans actually CHANGED — otherwise
    // the constant 'participants' events (media arriving, speaking toggling) would
    // perpetually push the deal back and it would never fire. Each real arrival
    // within startDelayMs of the last is still dealt in.
    const key = this.tx
      .roster()
      .map((p) => p.uid)
      .sort()
      .join(',')
    if (key === this.lastDealKey) return
    this.lastDealKey = key
    const gen = ++this.dealGen
    this.schedule(() => {
      if (gen !== this.dealGen) return
      // amHost() is false while a LIVE host exists, so this only deals when we're the
      // genuine host with no game — a fresh table, or taking over after the host left
      // (a fresh deal beats a frozen one; the old game can't be resumed off-host).
      if (this.amHost() && !this.auth) this.hostDeal(true)
    }, this.wasInGame ? this.reconnectDelayMs : this.startDelayMs)
  }

  private hostDeal(reset: boolean): void {
    if (!this.amHost()) return
    if (reset || !this.auth) this.hostReseat()
    const scores: [number, number] = reset || !this.auth ? [0, 0] : this.auth.scores
    const handNumber = reset || !this.auth ? 1 : this.auth.handNumber + 1
    // First hand: deal from seat 3 so the ELDEST hand (left of the dealer) is seat 0 —
    // the room opener (host) — and they make the opening lead. Then rotate each hand.
    const dealer: Seat = reset || !this.auth ? 3 : (((this.auth.dealer + 1) % 4) as Seat)
    this.auth = deal(dealer, seededRng(this.seed + handNumber), scores, handNumber)
    this.publish()
    this.drive()
  }

  private hostNextHand(): void {
    if (!this.amHost() || !this.auth) return
    if (this.auth.phase !== 'handOver') return
    this.auth = nextHand(this.auth, seededRng(this.seed + this.auth.handNumber + 1))
    this.publish()
    this.drive()
  }

  private hostApplyPlay(uid: string, card: Card): void {
    if (!this.amHost() || !this.auth) return
    const seat = this.seatByUid.get(uid)
    if (seat == null || this.auth.turn !== seat) return
    if (!isLegal(this.auth, seat, card)) return
    this.auth = playCard(this.auth, seat, card)
    this.publish()
    this.drive()
  }

  /** After any authoritative change: let bots act and auto-advance finished hands. */
  private drive(): void {
    const s = this.auth
    if (!s) return
    if (s.phase === 'playing' && this.isBotSeat(s.turn)) {
      const at = s
      this.schedule(() => {
        if (this.auth !== at) return // a human moved first / game reset
        if (!this.isBotSeat(at.turn)) return // a human took over this seat meanwhile
        this.auth = playCard(at, at.turn, botMove(at, at.turn))
        this.publish()
        this.drive()
      }, this.botDelayMs)
    } else if (s.phase === 'trickComplete') {
      // Hold the finished 4-card trick on the table so everyone sees it, then award.
      const at = s
      this.schedule(() => {
        if (this.auth !== at) return
        this.hostResolveTrick()
      }, this.trickHoldMs)
    } else if (s.phase === 'handOver') {
      const at = s
      this.schedule(() => {
        if (this.auth !== at) return
        this.hostNextHand()
      }, this.handDelayMs)
    }
  }

  private hostResolveTrick(): void {
    if (!this.amHost() || !this.auth || this.auth.phase !== 'trickComplete') return
    this.auth = resolveTrick(this.auth)
    this.publish()
    this.drive()
  }

  // ── Host: publishing ───────────────────────────────────────────────────────────

  private publish(): void {
    if (!this.auth) return
    const a = this.auth
    this.pub = {
      dealer: a.dealer,
      turn: a.turn,
      trump: a.trump,
      trumpCard: a.trumpCard,
      trick: a.trick,
      lastTrick: a.lastTrick,
      handCounts: [a.hands[0].length, a.hands[1].length, a.hands[2].length, a.hands[3].length],
      tricksWon: a.tricksWon,
      scores: a.scores,
      handNumber: a.handNumber,
      phase: a.phase,
      winner: a.winner,
      seatUid: SEATS.map((s) => this.uidAt(s)),
      seatName: SEATS.map((s) => this.nameForSeat(s)),
      seatBot: SEATS.map((s) => this.isBotSeat(s)),
      host: this.self,
    }
    // Only seated HUMAN hands travel, keyed by uid (each client reads its own).
    const hands: Record<string, Card[]> = {}
    for (const [uid, seat] of this.seatByUid) hands[uid] = a.hands[seat]
    // A kibitzer watches one seat: hand it that seat's cards under ITS uid, so it sees
    // the hand exactly like a player would (refreshView reads hands[self]). The watched
    // player isn't told — the host just addresses the spectator. Friendly-table model.
    for (const p of this.tx.roster()) {
      if (!isKibitzer(p)) continue
      const seat = this.resolveWatchSeat(p)
      if (seat != null) hands[p.uid] = a.hands[seat]
    }
    this.hands = hands
    this.ver += 1
    this.refreshView()
    this.broadcastState()
    this.hostPersist()
    this.markSeen()
  }

  private broadcastState(): void {
    this.send({ ns: NS, t: 'state', v: this.ver, pub: this.pub, hands: this.hands })
  }

  // ── Host: resume-after-reconnect (persist the authoritative game) ──────────────

  private persistKey(): string | null {
    return this.room ? `whist.game.${this.room}` : null
  }

  /** Save the full authoritative game so a reconnecting host resumes it (rather than
   *  redealing and dropping the other players). Host only; cards are JSON-able. */
  private hostPersist(): void {
    const key = this.persistKey()
    if (!key || !this.storage || !this.auth) return
    try {
      this.storage.setItem(
        key,
        JSON.stringify({ auth: this.auth, seats: [...this.seatByUid], names: [...this.nameByUid], ver: this.ver }),
      )
    } catch {
      /* storage full / unavailable — resume just won't be available */
    }
  }

  /** Mark that we're in an active game here, so a later reload knows it's a RECONNECT
   *  (and waits for the host instead of dealing fresh). Set by host and clients alike. */
  private markSeen(): void {
    if (!this.room || !this.storage || this.pub.phase === 'lobby') return
    try {
      this.storage.setItem(`whist.seen.${this.room}`, '1')
    } catch {
      /* ignore */
    }
  }

  /** Restore a saved game on (re)becoming host with no in-memory state. Returns true
   *  if a game was loaded; the caller then publishes + drives it. */
  private tryRestore(): boolean {
    const key = this.persistKey()
    if (!key || !this.storage) return false
    try {
      const raw = this.storage.getItem(key)
      if (!raw) return false
      const data = JSON.parse(raw) as {
        auth?: WhistState
        seats?: [string, Seat][]
        names?: [string, string][]
        ver?: number
      }
      if (!data?.auth || !Array.isArray(data.auth.hands) || data.auth.hands.length !== 4) return false
      this.auth = data.auth
      this.seatByUid.clear()
      for (const [uid, seat] of data.seats ?? []) this.seatByUid.set(uid, seat)
      // Restore the away players' names too, so a seat reserved for someone who isn't
      // back yet can still be reclaimed-by-name (the present players' names re-arrive
      // via noteNames() below and overlay these).
      for (const [uid, nm] of data.names ?? []) this.nameByUid.set(uid, nm)
      this.ver = data.ver ?? 0
      this.noteNames()
      return true
    } catch {
      return false
    }
  }

  // ── View assembly (host & client share this) ──────────────────────────────────

  private mySeat(): Seat | null {
    const i = this.pub.seatUid.indexOf(this.self)
    return i < 0 ? null : (i as Seat)
  }

  private refreshView(): void {
    const seat = this.mySeat()
    const myHand = this.hands[this.self] ?? []
    const v: LocalView = {
      amHost: this.amHost(),
      mySeat: seat,
      myHand,
      legal: legalFor(myHand, this.pub, seat),
      pub: this.pub,
      chat: this.chatLog,
    }
    this.view = v
    for (const cb of this.viewCbs) {
      try {
        cb(v)
      } catch {
        /* a subscriber threw — don't break the others */
      }
    }
  }

  private send(m: GameMsg): void {
    this.tx.broadcast(m)
  }
}
