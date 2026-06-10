import { type Card, SUIT_SYMBOL } from '../engine/cards'
import { SEATS, type Seat as SeatN, type Team, teamOf } from '../engine/whist'
import type { SeatMedia } from '../net/kibitz'
import type { LocalView } from '../net/session'
import { CardView } from './Card'
import { Hand } from './Hand'
import { Seat } from './Seat'

const PLACES = ['bottom', 'left', 'top', 'right'] as const
type Place = (typeof PLACES)[number]
const isRed = (s: string): boolean => s === 'H' || s === 'D'

export function Table({
  view,
  media,
  onPlay,
  onNewGame,
  spectate = false,
  watchSeat,
}: {
  view: LocalView
  media: Map<string, SeatMedia>
  onPlay: (c: Card) => void
  onNewGame: () => void
  /** Kibitzer mode: render read-only, centred on the watched seat. */
  spectate?: boolean
  watchSeat?: number
}) {
  const { pub } = view
  // A kibitzer has no seat of its own — centre the table on the seat it's watching.
  const ref: SeatN = (spectate && watchSeat != null ? (watchSeat as SeatN) : view.mySeat) ?? 0
  const placeOf = (s: SeatN): Place => PLACES[((s - ref + 4) % 4) as 0 | 1 | 2 | 3]
  const legal = view.legal
  const myTurn = view.mySeat != null && pub.turn === view.mySeat && pub.phase === 'playing'
  const myTeam: Team | null = view.mySeat != null ? teamOf(view.mySeat) : null

  const mediaFor = (s: SeatN): SeatMedia | null => {
    const uid = pub.seatUid[s]
    return uid ? media.get(uid) ?? null : null
  }
  // The host tells us which seats are AI-controlled. A seat with a human uid that's
  // bot-controlled = that player is AWAY (AI covering, seat reserved). No uid = an
  // empty seat played by a pure bot.
  const isAway = (s: SeatN): boolean => (pub.seatBot[s] ?? false) && pub.seatUid[s] != null
  const isPureBot = (s: SeatN): boolean => (pub.seatBot[s] ?? false) && pub.seatUid[s] == null

  let debug = false
  try {
    debug = new URLSearchParams(location.search).has('debug')
  } catch {
    /* ignore */
  }

  const winner = pub.trick.plays.length === 4 ? trickWinnerSeat(pub) : null

  return (
    <div className="table-wrap">
      {/* Seats */}
      {SEATS.map((s) => (
        <Seat
          key={s}
          place={placeOf(s)}
          name={pub.seatName[s] || '—'}
          media={mediaFor(s)}
          active={pub.phase === 'playing' && pub.turn === s}
          dealer={pub.dealer === s}
          isBot={isPureBot(s)}
          away={isAway(s)}
          handCount={s === view.mySeat ? undefined : pub.handCounts[s]}
        />
      ))}

      {/* Trick in progress, each card by its player's screen side */}
      <div className="trick-area">
        {pub.trick.plays.map((p) => (
          <div key={p.seat} className={`trick-slot at-${placeOf(p.seat)} ${winner === p.seat ? 'winner' : ''}`}>
            <CardView card={p.card} />
          </div>
        ))}
        {pub.trick.plays.length === 0 && pub.trump && (
          <div className="trump-tag">
            <div className={`glyph ${isRed(pub.trump) ? 'red' : ''}`}>{SUIT_SYMBOL[pub.trump]}</div>
            <div className="lbl">trump</div>
          </div>
        )}
      </div>

      {/* Scoreboard */}
      <div className="scoreboard">
        <Score label="N·S" mine={myTeam === 0} score={pub.scores[0]} tricks={pub.tricksWon[0]} />
        <Score label="E·W" mine={myTeam === 1} score={pub.scores[1]} tricks={pub.tricksWon[1]} />
      </div>

      {/* Banners */}
      {pub.phase === 'gameOver' && pub.winner != null && (
        <div className="banner">
          <div className="big">{pub.winner === myTeam ? 'Your team wins! 🎉' : `${teamName(pub.winner)} wins`}</div>
          <button type="button" className="primary" onClick={onNewGame}>
            New game
          </button>
        </div>
      )}
      {pub.phase === 'handOver' && (
        <div className="banner subtle">
          <div>
            Hand {pub.handNumber}: {pub.tricksWon[0]}–{pub.tricksWon[1]} tricks
          </div>
          <div className="dim">next hand dealing…</div>
        </div>
      )}

      {/* Your hand (or, for a kibitzer, the watched seat's hand — read-only) */}
      <div className="hand-zone">
        {spectate ? (
          view.myHand.length ? (
            <>
              <Hand cards={view.myHand} legal={[]} myTurn={false} onPlay={() => {}} />
              <div className="prompt dim">👁 {pub.seatName[ref] || `seat ${ref}`}’s hand</div>
            </>
          ) : (
            <div className="spectating">Watching — waiting for the deal…</div>
          )
        ) : view.mySeat == null ? (
          <div className="spectating">Spectating — you'll be dealt in.</div>
        ) : (
          <>
            <Hand cards={view.myHand} legal={legal} myTurn={myTurn} onPlay={onPlay} />
            {myTurn && <div className="prompt">Your turn</div>}
          </>
        )}
      </div>

      {debug && (
        <div className="debug">
          {SEATS.map((s) => {
            const uid = pub.seatUid[s]
            const m = uid ? media.get(uid) : null
            const vt = m?.stream ? m.stream.getVideoTracks().length : 0
            const live = m?.stream?.getVideoTracks()[0]?.readyState ?? '-'
            return (
              <div key={s}>
                s{s} {pub.seatName[s] || '—'} · {uid ? `uid:${uid.slice(0, 5)}` : 'bot'} · cam:{m?.camOn ? 'Y' : 'n'} · str:
                {m?.stream ? 'Y' : 'n'} · vt:{vt}/{live}
                {m?.isSelf ? ' (you)' : ''}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Score({ label, score, tricks, mine }: { label: string; score: number; tricks: number; mine: boolean }) {
  return (
    <div className={`score ${mine ? 'mine' : ''}`}>
      <div className="score-num numeric">{score}</div>
      <div className="score-label">
        {label}
        {mine ? ' · you' : ''}
      </div>
      <div className="score-tricks numeric">{tricks} tricks</div>
    </div>
  )
}

const teamName = (t: Team): string => (t === 0 ? 'North·South' : 'East·West')

/** Winner of a full (4-card) trick, for the brief highlight before it clears. */
function trickWinnerSeat(pub: LocalView['pub']): SeatN | null {
  const plays = pub.trick.plays
  if (plays.length !== 4 || !pub.trump) return null
  const led = plays[0].card.suit
  const val = (c: Card): number => (c.suit === pub.trump ? 100 + c.rank : c.suit === led ? c.rank : -1)
  let best = plays[0]
  for (const p of plays) if (val(p.card) > val(best.card)) best = p
  return best.seat
}
