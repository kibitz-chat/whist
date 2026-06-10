/**
 * The production transport: a GameSession Transport backed by the real Kibitz
 * widget running headless (`Kibitz.mount({ headless: true })`). This is the whole
 * point of the reference design — the game's multiplayer state rides Kibitz's data
 * channel, and the in-table video comes from the same call's media streams.
 *
 * We mount headless (no Kibitz panel — Whist draws its own table), join the call so
 * we appear in the roster and exchange media, and carry our stable `uid` in `meta`
 * so seats survive reconnects.
 */
import type { Transport } from './session'

/** A participant as the Kibitz controller reports it. */
export interface KParticipant {
  id: string
  isSelf: boolean
  name: string
  avatar: string
  camOn: boolean
  speaking: boolean
  stream: MediaStream | null
  meta: Record<string, unknown>
  mirror?: boolean
}

/** The subset of Kibitz's MountedWidget controller we use. */
export interface KibitzController {
  unmount(): void
  broadcast(data: unknown): void
  onMessage(cb: (data: unknown) => void): void
  getState(): { inCall: boolean; micOn: boolean; camOn: boolean; self: KParticipant | null }
  getParticipants(): KParticipant[]
  join(opts?: { mic?: boolean; cam?: boolean }): Promise<boolean>
  leave(): void
  toggleMic(): void
  toggleCam(): Promise<void>
  setName(name: string): void
  setAvatar(avatar: string): void
  setMeta(meta: Record<string, unknown>): void
  on(event: 'participants', cb: (p: KParticipant[]) => void): () => void
  on(event: 'join' | 'leave', cb: (p: KParticipant) => void): () => void
  on(event: 'speaking', cb: (ids: string[]) => void): () => void
  on(event: 'state', cb: (s: { inCall: boolean; micOn: boolean; camOn: boolean }) => void): () => void
}

interface KibitzGlobal {
  mount(opts: {
    room: string
    name?: string
    headless?: boolean
    identity?: string
    meta?: Record<string, unknown>
    startOpen?: boolean
  }): KibitzController
}

declare global {
  interface Window {
    Kibitz?: KibitzGlobal
  }
}

/** Per-browser, per-room stable identity so a reconnecting player resumes their
 *  seat. Overridable with ?uid= (handy for opening several test tabs). */
export function stableUid(room: string): string {
  try {
    const forced = new URLSearchParams(location.search).get('uid')
    if (forced) return forced
    const key = `whist.uid.${room}`
    let u = localStorage.getItem(key)
    if (!u) {
      u = `u${Math.random().toString(36).slice(2, 10)}`
      localStorage.setItem(key, u)
    }
    return u
  } catch {
    return `u${Math.random().toString(36).slice(2, 10)}`
  }
}

const uidOf = (p: KParticipant): string =>
  typeof p.meta?.uid === 'string' ? (p.meta.uid as string) : p.id

/** Latest-wins dedupe by uid (a reconnecting peer can briefly appear twice). */
function dedupe(parts: KParticipant[]): KParticipant[] {
  const byUid = new Map<string, KParticipant>()
  for (const p of parts) {
    const u = uidOf(p)
    const prev = byUid.get(u)
    // Prefer self, then a participant that actually has a media stream.
    if (!prev || p.isSelf || (!prev.stream && p.stream)) byUid.set(u, p)
  }
  return [...byUid.values()]
}

export interface SeatMedia {
  stream: MediaStream | null
  speaking: boolean
  camOn: boolean
  isSelf: boolean
}

export interface KibitzNet {
  transport: Transport
  controller: KibitzController
  /** Media keyed by uid, for placing a video tile at each seat. */
  mediaByUid(): Map<string, SeatMedia>
  /** Subscribe to roster/media changes (re-render the tiles). */
  onParticipants(cb: () => void): () => void
  destroy(): void
}

async function joinWithRetry(c: KibitzController, opts: { mic?: boolean; cam?: boolean }): Promise<boolean> {
  // The controls aren't live until the Widget's first effect runs; retry briefly.
  for (let i = 0; i < 40; i++) {
    if (await c.join(opts)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export interface ConnectOptions {
  room: string
  name: string
  uid: string
  mic?: boolean
  cam?: boolean
  /** Extra roster metadata merged into the call `meta` (e.g. a kibitzer's
   *  `{ role:'kibitzer', watch:<seat> }`), visible to other peers via the roster. */
  meta?: Record<string, unknown>
}

export async function connectKibitz(opts: ConnectOptions): Promise<KibitzNet> {
  const K = window.Kibitz
  if (!K) throw new Error('Kibitz widget not loaded — add <script src=".../widget.js"> before the app')

  const controller = K.mount({
    room: opts.room,
    headless: true,
    identity: opts.uid,
    name: opts.name,
    meta: { uid: opts.uid, name: opts.name, ...opts.meta },
  })

  await joinWithRetry(controller, { mic: opts.mic ?? true, cam: opts.cam ?? false })

  const transport: Transport = {
    self: opts.uid,
    selfName: opts.name,
    broadcast: (d) => controller.broadcast(d),
    onMessage: (cb) => controller.onMessage(cb),
    roster: () =>
      dedupe(controller.getParticipants()).map((p) => ({
        uid: uidOf(p),
        name: p.name,
        isSelf: p.isSelf,
        meta: p.meta, // carries a kibitzer's { role, watch } so the host can spot it
      })),
    onRoster: (cb) => controller.on('participants', () => cb()),
  }

  return {
    transport,
    controller,
    mediaByUid: () => {
      const m = new Map<string, SeatMedia>()
      for (const p of dedupe(controller.getParticipants())) {
        m.set(uidOf(p), { stream: p.stream, speaking: p.speaking, camOn: p.camOn, isSelf: p.isSelf })
      }
      return m
    },
    onParticipants: (cb) => {
      const offP = controller.on('participants', () => cb())
      const offS = controller.on('speaking', () => cb())
      return () => {
        offP()
        offS()
      }
    },
    destroy: () => controller.unmount(),
  }
}
