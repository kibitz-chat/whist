import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card } from './engine/cards'
import { type KibitzNet, type SeatMedia, connectKibitz, stableUid } from './net/kibitz'
import { GameSession, type LocalView } from './net/session'
import { ChatPanel } from './ui/Chat'
import { InvitePanel } from './ui/Invite'
import { QrScanner } from './ui/QrScanner'
import { Table } from './ui/Table'
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon, ShareIcon } from './ui/icons'

type Phase = 'gate' | 'connecting' | 'playing' | 'error'

/** Read the room from the URL hash, minting an unguessable one if absent (matches
 *  Kibitz's privacy-by-default — the link IS the invite). */
function useRoom(): string {
  const [room] = useState(() => {
    let h = location.hash.replace(/^#/, '').trim()
    if (!h) {
      h = `${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`
      location.hash = h
    }
    return h
  })
  return room
}

export default function App() {
  const room = useRoom()
  const [phase, setPhase] = useState<Phase>('gate')
  const [error, setError] = useState('')
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('whist.name') ?? ''
    } catch {
      return ''
    }
  })
  const [cam, setCam] = useState(false)
  const [view, setView] = useState<LocalView | null>(null)
  const [media, setMedia] = useState<Map<string, SeatMedia>>(new Map())
  const [mic, setMic] = useState(true)
  const [camOn, setCamOn] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showScan, setShowScan] = useState(false)
  const [selfUid, setSelfUid] = useState<string | null>(null)

  // Kibitzer mode (?role=kibitzer&watch=<seat>&name=…): join as a silent spectator that
  // watches one seat's hand and chats — no gate, auto-connect. This is how the kibitzer
  // agent attaches, and lets a human peek at the same view.
  const params = new URLSearchParams(location.search)
  const isKibitzer = params.get('role') === 'kibitzer'
  // watch = an explicit seat 0-3, or 'auto' (default) → the host picks the human seat.
  const watchParam = params.get('watch') ?? 'auto'
  const watch: number | 'auto' = /^[0-3]$/.test(watchParam) ? Number(watchParam) : 'auto'

  const onScan = useCallback((text: string) => {
    try {
      const u = new URL(text)
      if (u.hash && u.hash.length > 1) {
        // Join the scanned table on THIS origin (don't navigate cross-site).
        location.hash = u.hash
        location.reload()
        return
      }
    } catch {
      /* not a URL — ignore */
    }
    setShowScan(false)
  }, [])

  const netRef = useRef<KibitzNet | null>(null)
  const sessionRef = useRef<GameSession | null>(null)
  const startedRef = useRef(false)

  const start = useCallback(
    async (asKibitzer: boolean) => {
      if (startedRef.current) return // guard StrictMode double-mount / double-tap
      startedRef.current = true
      setPhase('connecting')
      setError('')
      const displayName = asKibitzer ? params.get('name') || 'Kibitzer 👁' : name.trim() || 'Player'
      if (!asKibitzer) {
        try {
          localStorage.setItem('whist.name', displayName)
        } catch {
          /* private mode — ignore */
        }
      }
      try {
        // A kibitzer gets a distinct, kib-prefixed uid so the host shares it the watched
        // hand (never a seat) and the UI can style its remarks.
        const uid = asKibitzer ? `kib-${stableUid(room).slice(1)}` : stableUid(room)
        const net = await connectKibitz({
          room,
          name: displayName,
          uid,
          // A kibitzer still joins WITH a mic transceiver, then mutes below: a
          // data-channel-only peer (mic:false) won't complete the WebRTC connection
          // over the live TURN/ICE path, so it'd never receive the game. Muted = it's
          // connected and silent.
          mic: true,
          cam: asKibitzer ? false : cam,
          meta: asKibitzer ? { role: 'kibitzer', watch } : undefined,
        })
        netRef.current = net
        // Kibitzer: mute immediately so it's a silent spectator (connected, no audio out).
        if (asKibitzer) {
          try {
            await net.controller.toggleMic()
          } catch {
            /* controller not ready — harmless */
          }
        }
        const session = new GameSession(net.transport, { seed: Date.now() & 0x7fffffff, room })
        sessionRef.current = session
        setSelfUid(net.transport.self)
        // In kibitzer mode, expose a small, intentional control surface so the kibitzer
        // AGENT (a headless driver) can read the view it watches and post remarks. Scoped
        // to kibitzer mode only — never present for a normal player.
        if (asKibitzer) {
          ;(window as unknown as { __kibitzer?: unknown }).__kibitzer = {
            watch,
            getView: () => session.getView(),
            onView: (cb: (v: LocalView) => void) => session.onView(cb),
            sendChat: (t: string) => session.sendChat(t),
          }
        }
        session.onView(setView)
        const refreshMedia = () => setMedia(new Map(net.mediaByUid()))
        net.onParticipants(refreshMedia)
        refreshMedia()
        const s = net.controller.getState()
        setMic(s.micOn)
        setCamOn(s.camOn)
        net.controller.on('state', (st) => {
          setMic(st.micOn)
          setCamOn(st.camOn)
        })
        setPhase('playing')
      } catch (e) {
        startedRef.current = false
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    },
    [room, name, cam, watch, params],
  )

  const sit = useCallback(() => start(false), [start])

  // Kibitzer auto-joins (no gate).
  useEffect(() => {
    if (isKibitzer) start(true)
  }, [isKibitzer, start])

  useEffect(() => () => netRef.current?.destroy(), [])

  const onPlay = useCallback((c: Card) => sessionRef.current?.play(c), [])
  const onNewGame = useCallback(() => sessionRef.current?.newGame(), [])
  const onSendChat = useCallback((text: string) => sessionRef.current?.sendChat(text), [])

  // Kibitzer never sees the gate — it auto-joins. Show a slim status while it connects.
  if (isKibitzer && phase !== 'playing') {
    return (
      <div className="gate">
        <div className="card-panel">
          <h1>
            👁 Kibitzer <span className="on">· on Kibitz</span>
          </h1>
          <p className="sub-text">
            {phase === 'error'
              ? `Couldn’t connect: ${error}`
              : `Joining room ${room} ${watch === 'auto' ? 'to watch the table' : `to watch seat ${watch}`}…`}
          </p>
          <p className="room">
            Room <code>{room}</code>
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'gate' || phase === 'connecting' || phase === 'error') {
    return (
      <div className="gate">
        <div className="card-panel">
          <h1>
            Whist <span className="on">· on Kibitz</span>
          </h1>
          <p className="sub-text">A 4-player trick-taking classic with the table call right at your seats. Share the link, sit down, and the empty seats fill with bots.</p>
          <label className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player" maxLength={20} onKeyDown={(e) => e.key === 'Enter' && sit()} />
          </label>
          <label className="check">
            <input type="checkbox" checked={cam} onChange={(e) => setCam(e.target.checked)} /> Join with camera on
          </label>
          <button type="button" className="primary big" onClick={sit} disabled={phase === 'connecting'}>
            {phase === 'connecting' ? 'Connecting…' : 'Sit down'}
          </button>
          <button type="button" className="scan-link" onClick={() => setShowScan(true)}>
            <ShareIcon /> Scan a friend's QR to join their table
          </button>
          {phase === 'error' && <p className="err">Couldn’t connect: {error}</p>}
          <p className="room">
            Room <code>{room}</code> · the link is the invite
          </p>
        </div>
        {showScan && <QrScanner onResult={onScan} onClose={() => setShowScan(false)} />}
      </div>
    )
  }

  // The seat the kibitzer is actually watching: explicit, or (auto) the first human seat.
  const effWatch =
    typeof watch === 'number' ? watch : Math.max(0, view?.pub.seatUid.findIndex((u) => u != null) ?? 0)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">♠</span> Whist <span className="on">· on Kibitz</span>
        </div>
        <div className="spacer" />
        {isKibitzer ? (
          <div className="kib-tag">👁 Kibitzing {view?.pub.seatName[effWatch] || 'the table'}</div>
        ) : (
          <div className="ctrls">
            <button type="button" className={`icon ${mic ? 'on' : ''}`} onClick={() => netRef.current?.controller.toggleMic()} title={mic ? 'Mute microphone' : 'Unmute microphone'} aria-label="Microphone">
              {mic ? <MicIcon /> : <MicOffIcon />}
            </button>
            <button type="button" className={`icon ${camOn ? 'on' : ''}`} onClick={() => netRef.current?.controller.toggleCam()} title={camOn ? 'Turn camera off' : 'Turn camera on'} aria-label="Camera">
              {camOn ? <CamIcon /> : <CamOffIcon />}
            </button>
            <button type="button" className="icon invite" onClick={() => setShowInvite(true)} title="Invite players" aria-label="Invite">
              <ShareIcon />
            </button>
          </div>
        )}
      </header>
      {view && <Table view={view} media={media} onPlay={onPlay} onNewGame={onNewGame} spectate={isKibitzer} watchSeat={isKibitzer ? effWatch : undefined} />}
      {view && <ChatPanel chat={view.chat} selfUid={selfUid} onSend={onSendChat} />}
      {showInvite && <InvitePanel url={location.href} onClose={() => setShowInvite(false)} />}
    </div>
  )
}
