import { describe, expect, it } from 'vitest'
import { cardId } from '../engine/cards'
import { GameSession, type Transport } from './session'

/**
 * An in-memory broadcast bus that mimics the Kibitz controller's contract:
 * `broadcast` reaches everyone ELSE (never yourself), `roster()` lists peers, and
 * joining notifies existing peers. structuredClone matches the real channel's
 * structured-clone semantics (so we can't accidentally share references).
 */
class TestBus {
  private peers: {
    uid: string
    name: string
    meta?: Record<string, unknown>
    msgCb?: (d: unknown) => void
    rosterCbs: Set<() => void>
  }[] = []

  join(uid: string, name: string, meta?: Record<string, unknown>): Transport {
    const self = { uid, name, meta, rosterCbs: new Set<() => void>() } as (typeof this.peers)[number]
    this.peers.push(self)
    for (const p of this.peers) if (p !== self) p.rosterCbs.forEach((cb) => cb())
    return {
      self: uid,
      selfName: name,
      broadcast: (data) => {
        for (const p of this.peers) if (p !== self) p.msgCb?.(structuredClone(data))
      },
      onMessage: (cb) => {
        self.msgCb = cb
      },
      roster: () => this.peers.map((p) => ({ uid: p.uid, name: p.name, isSelf: p === self, meta: p.meta })),
      onRoster: (cb) => {
        self.rosterCbs.add(cb)
        return () => self.rosterCbs.delete(cb)
      },
    }
  }
}

/** A controllable timer: nothing runs until flush(), which drains to quiescence. */
function makeClock() {
  const q: (() => void)[] = []
  return {
    schedule: (fn: () => void) => {
      q.push(fn)
    },
    flush: () => {
      let n = 0
      while (q.length) {
        q.shift()!()
        if (++n > 500_000) throw new Error('flush overflow — game did not converge')
      }
    },
  }
}

function makeGame(uids: string[]) {
  const bus = new TestBus()
  const clock = makeClock()
  const sessions = uids.map(
    (uid) =>
      new GameSession(bus.join(uid, uid.toUpperCase()), {
        seed: 7,
        botDelayMs: 0,
        trickHoldMs: 0,
        handDelayMs: 0,
        startDelayMs: 0,
        reconnectDelayMs: 0,
        schedule: clock.schedule,
      }),
  )
  return { sessions, flush: clock.flush }
}

/** Drive every HUMAN turn (first legal card) until the game ends; bots auto-play. */
function playOut(sessions: GameSession[], flush: () => void): void {
  flush()
  for (let guard = 0; guard < 5000; guard++) {
    if (sessions.some((s) => s.getView().pub.phase === 'gameOver')) return
    let acted = false
    for (const s of sessions) {
      const v = s.getView()
      if (v.mySeat != null && v.legal.length) {
        s.play(v.legal[0])
        flush()
        acted = true
        break
      }
    }
    if (!acted) flush()
  }
  throw new Error('game did not finish')
}

describe('host election', () => {
  it('the lowest uid is host, exactly one host', () => {
    const { sessions } = makeGame(['p3', 'p1', 'p2'])
    const hosts = sessions.filter((s) => s.getView().amHost)
    expect(hosts.length).toBe(1)
    // p1 is lowest → it is the host (it was constructed 2nd, order independent).
    const hostView = hosts[0].getView()
    expect(sessions[1].getView().amHost).toBe(true) // sessions[1] was given uid 'p1'
    expect(hostView.amHost).toBe(true)
  })
})

describe('dealing & seating', () => {
  it('deals 13 disjoint private hands across four humans', () => {
    const { sessions, flush } = makeGame(['a', 'b', 'c', 'd'])
    flush() // opening deal; no bots, so it stops at a fresh deal
    const hands = sessions.map((s) => s.getView().myHand)
    expect(hands.map((h) => h.length)).toEqual([13, 13, 13, 13])
    const all = hands.flat().map(cardId)
    expect(new Set(all).size).toBe(52) // disjoint + complete

    // Everyone agrees on the public snapshot (trump, dealer, whose turn).
    const pubs = sessions.map((s) => s.getView().pub)
    for (const p of pubs) {
      expect(p.trump).toBe(pubs[0].trump)
      expect(p.turn).toBe(pubs[0].turn)
      expect(p.phase).toBe('playing')
      expect(p.seatName.filter(Boolean).length).toBe(4)
    }
  })

  it('fills empty seats with bots for a solo human', () => {
    const { sessions, flush } = makeGame(['solo'])
    flush()
    const pub = sessions[0].getView().pub
    const humans = pub.seatUid.filter((u) => u != null)
    expect(humans).toEqual(['solo'])
    expect(pub.seatName.filter(Boolean).length).toBe(4) // 1 human + 3 bots labelled
  })
})

describe('a full multiplayer game', () => {
  it('four humans play to a winner, snapshots stay converged', () => {
    const { sessions, flush } = makeGame(['a', 'b', 'c', 'd'])
    playOut(sessions, flush)
    const views = sessions.map((s) => s.getView())
    const host = views.find((v) => v.amHost)!
    expect(host.pub.phase).toBe('gameOver')
    expect(host.pub.winner).not.toBeNull()
    expect(host.pub.scores[host.pub.winner as 0 | 1]).toBeGreaterThanOrEqual(5)
    // Every peer converged to the identical final snapshot.
    for (const v of views) {
      expect(v.pub.phase).toBe('gameOver')
      expect(v.pub.winner).toBe(host.pub.winner)
      expect(v.pub.scores).toEqual(host.pub.scores)
      expect(v.pub.handNumber).toBe(host.pub.handNumber)
    }
  })

  it('two humans + two bots also reach a winner (intent routing + bots)', () => {
    const { sessions, flush } = makeGame(['x', 'y'])
    playOut(sessions, flush)
    const host = sessions.find((s) => s.getView().amHost)!.getView()
    const other = sessions.find((s) => !s.getView().amHost)!.getView()
    expect(host.pub.phase).toBe('gameOver')
    expect(other.pub.phase).toBe('gameOver')
    expect(other.pub.winner).toBe(host.pub.winner)
    expect(other.pub.scores).toEqual(host.pub.scores)
  })
})

describe('illegal / out-of-turn intents are ignored by the host', () => {
  it('a client cannot play out of turn', () => {
    const { sessions, flush } = makeGame(['a', 'b', 'c', 'd'])
    flush()
    // Find a session whose seat is NOT the one to move, and try to play anyway.
    const turn = sessions[0].getView().pub.turn
    const offTurn = sessions.find((s) => s.getView().mySeat != null && s.getView().mySeat !== turn)!
    const before = offTurn.getView().myHand.length
    offTurn.play(offTurn.getView().myHand[0]) // not our turn → host should drop it
    flush()
    expect(offTurn.getView().myHand.length).toBe(before)
    expect(sessions[0].getView().pub.turn).toBe(turn) // turn unchanged
  })
})

describe('host reconnect resume', () => {
  it('a returning host resumes the saved game (keeps the other player) instead of redealing solo', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }
    const base = { seed: 7, botDelayMs: 0, trickHoldMs: 0, handDelayMs: 0, startDelayMs: 0, reconnectDelayMs: 0, room: 'r1', storage }

    // Original table: host 'a' + client 'b' (+2 bots).
    const bus1 = new TestBus()
    const clk1 = makeClock()
    new GameSession(bus1.join('a', 'A'), { ...base, schedule: clk1.schedule })
    const b1 = new GameSession(bus1.join('b', 'B'), { ...base, schedule: clk1.schedule })
    clk1.flush()
    expect(b1.getView().pub.seatUid.filter(Boolean).sort()).toEqual(['a', 'b'])

    // Host reloads: a brand-new session, SAME uid + storage, initially alone (the old
    // connections are gone). It must RESUME the saved game, not redeal and drop 'b'.
    const bus2 = new TestBus()
    const a2 = new GameSession(bus2.join('a', 'A'), { ...base, schedule: makeClock().schedule })
    const pub = a2.getView().pub
    expect(pub.phase).toBe('playing') // resumed mid-game, not back to lobby/fresh deal
    expect(pub.seatUid).toContain('b') // the other player's seat was NOT dropped
    expect(a2.getView().mySeat).not.toBeNull()
  })
})

describe('table chat', () => {
  const base = { seed: 7, botDelayMs: 0, trickHoldMs: 0, handDelayMs: 0, startDelayMs: 0, reconnectDelayMs: 0 }

  it('a chat line reaches every peer, including the sender', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const a = new GameSession(bus.join('a', 'Alice'), { ...base, schedule: clock.schedule })
    const b = new GameSession(bus.join('b', 'Bob'), { ...base, schedule: clock.schedule })
    clock.flush()

    b.sendChat('nice lead!')
    expect(b.getView().chat).toEqual([{ by: 'b', name: 'Bob', text: 'nice lead!' }]) // sender sees it
    expect(a.getView().chat).toEqual([{ by: 'b', name: 'Bob', text: 'nice lead!' }]) // and so does the peer

    a.sendChat('thanks 😄')
    expect(a.getView().chat.map((c) => c.text)).toEqual(['nice lead!', 'thanks 😄'])
    expect(b.getView().chat.map((c) => c.text)).toEqual(['nice lead!', 'thanks 😄'])
  })

  it('ignores an empty/whitespace line', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const a = new GameSession(bus.join('a', 'Alice'), { ...base, schedule: clock.schedule })
    clock.flush()
    a.sendChat('   ')
    expect(a.getView().chat).toEqual([])
  })
})

describe('kibitzer (spectator that watches a hand)', () => {
  const base = { seed: 7, botDelayMs: 0, trickHoldMs: 0, handDelayMs: 0, startDelayMs: 0, reconnectDelayMs: 0 }

  it('is never seated and sees the watched seat’s hand', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const a = new GameSession(bus.join('a', 'Alice'), { ...base, schedule: clock.schedule })
    const k = new GameSession(bus.join('k', 'Kib', { role: 'kibitzer', watch: 0 }), { ...base, schedule: clock.schedule })
    clock.flush()

    const hp = a.getView().pub
    expect(hp.seatUid.filter(Boolean)).toEqual(['a']) // kibitzer did NOT take a seat
    expect(hp.seatUid).not.toContain('k')

    const kv = k.getView()
    expect(kv.mySeat).toBeNull() // it's a spectator
    expect(kv.legal).toEqual([]) // never asked to play
    // It sees seat 0's hand exactly as that player does.
    expect(kv.myHand.length).toBe(13)
    expect(kv.myHand.map(cardId).sort()).toEqual(a.getView().myHand.map(cardId).sort())
  })

  it('watch:auto follows the seated human', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const a = new GameSession(bus.join('a', 'Alice'), { ...base, schedule: clock.schedule })
    const k = new GameSession(bus.join('k', 'Kib', { role: 'kibitzer' }), { ...base, schedule: clock.schedule }) // no watch → auto
    clock.flush()
    expect(k.getView().mySeat).toBeNull()
    expect(k.getView().myHand.map(cardId).sort()).toEqual(a.getView().myHand.map(cardId).sort())
  })

  it('the watched player is unaffected (still has their own hand)', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const a = new GameSession(bus.join('a', 'Alice'), { ...base, schedule: clock.schedule })
    new GameSession(bus.join('k', 'Kib', { role: 'kibitzer', watch: 0 }), { ...base, schedule: clock.schedule })
    clock.flush()
    expect(a.getView().myHand.length).toBe(13)
    expect(a.getView().pub.seatName.filter(Boolean).length).toBe(4) // 1 human + 3 bots, no kibitzer seat
  })
})

describe('late joiners', () => {
  it('a newcomer takes over a bot seat mid-game, no redeal', () => {
    const bus = new TestBus()
    const clock = makeClock()
    const mk = (uid: string) =>
      new GameSession(bus.join(uid, uid.toUpperCase()), {
        seed: 7,
        botDelayMs: 0,
        trickHoldMs: 0,
        handDelayMs: 0,
        startDelayMs: 0,
        reconnectDelayMs: 0,
        schedule: clock.schedule,
      })

    const host = mk('a') // lowest uid → host
    clock.flush() // opening deal: 'a' + 3 bots
    expect(host.getView().pub.seatUid.filter(Boolean)).toEqual(['a'])
    const scoresBefore = host.getView().pub.scores.slice()
    const handBefore = host.getView().pub.handNumber

    const late = mk('b') // a friend opens the link mid-game
    clock.flush()

    const hp = host.getView().pub
    expect(hp.seatUid.filter(Boolean).sort()).toEqual(['a', 'b']) // b took a bot seat
    expect(hp.handNumber).toBe(handBefore) // no redeal
    expect(hp.scores).toEqual(scoresBefore)
    expect(late.getView().mySeat).not.toBeNull() // b is a player now, not a spectator
    expect(late.getView().myHand.length).toBeGreaterThan(0)
  })
})
