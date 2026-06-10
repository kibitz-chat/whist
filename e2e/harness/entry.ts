/**
 * Browser test harness: wires the real Kibitz widget (loaded via <script>) to a
 * GameSession and exposes a tiny imperative API on window.__whist so a Playwright
 * driver can connect several contexts and play a game over the live data channel.
 * This is the end-to-end proof that Whist's multiplayer rides Kibitz unchanged.
 */
import { type KibitzNet, connectKibitz } from '../../src/net/kibitz'
import { GameSession, type LocalView } from '../../src/net/session'

declare global {
  interface Window {
    __whist?: {
      connect(o: { room: string; uid: string; name: string }): Promise<boolean>
      rosterLen(): number
      snapshot(): Snapshot | null
      playFirstLegal(): boolean
      newGame(): void
    }
  }
}

interface Snapshot {
  mySeat: number | null
  myHandLen: number
  legalLen: number
  phase: string
  turn: number
  handNumber: number
  scores: [number, number]
  tricksWon: [number, number]
  winner: number | null
  counts: number[]
  seatName: string[]
}

let net: KibitzNet | null = null
let session: GameSession | null = null
let view: LocalView | null = null

window.__whist = {
  async connect(o) {
    net = await connectKibitz({ room: o.room, uid: o.uid, name: o.name, mic: false, cam: false })
    session = new GameSession(net.transport, { seed: 12345, botDelayMs: 40, handDelayMs: 40, trickHoldMs: 30, startDelayMs: 150 })
    session.onView((v) => {
      view = v
    })
    return true
  },
  rosterLen() {
    return net ? net.transport.roster().length : 0
  },
  snapshot() {
    if (!view) return null
    const p = view.pub
    return {
      mySeat: view.mySeat,
      myHandLen: view.myHand.length,
      legalLen: view.legal.length,
      phase: p.phase,
      turn: p.turn,
      handNumber: p.handNumber,
      scores: p.scores,
      tricksWon: p.tricksWon,
      winner: p.winner,
      counts: p.handCounts,
      seatName: p.seatName,
    }
  },
  playFirstLegal() {
    if (!view || !session) return false
    if (view.mySeat == null || view.legal.length === 0) return false
    if (view.pub.phase !== 'playing' || view.pub.turn !== view.mySeat) return false
    session.play(view.legal[0])
    return true
  },
  newGame() {
    session?.newGame()
  },
}
