import { useCallback } from 'react'
import type { SeatMedia } from '../net/kibitz'

type Place = 'bottom' | 'left' | 'top' | 'right'

/**
 * One seat at the table: a pill with the player's LIVE video (or a gold avatar
 * disc / 🤖 for a bot) in the avatar slot, their name, turn glow, and dealer/trick
 * badges. Opponents also get a small fan of face-down cards. The video is muted —
 * Kibitz plays the call audio via its hidden sinks, so camera-off players are heard.
 */
export function Seat({
  place,
  name,
  media,
  active,
  dealer,
  isBot,
  away,
  tricks,
  handCount,
}: {
  place: Place
  name: string
  media: SeatMedia | null
  active: boolean
  dealer: boolean
  isBot: boolean
  away: boolean
  tricks?: number
  handCount?: number
}) {
  const stream = media?.stream ?? null
  // Callback ref (not an effect): the camera track is swapped INTO the same stream
  // object, so attach on mount/stream-change so the fresh <video> always paints.
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) {
        el.srcObject = stream
        el.play?.().catch(() => {})
      }
    },
    [stream],
  )
  const showVideo = !!stream && (media?.camOn ?? false)
  const initials = name.trim().slice(0, 2).toUpperCase() || '··'

  const fan =
    place !== 'bottom' && handCount != null ? (
      <div className="mini-fan">
        {Array.from({ length: handCount }).map((_, i) => (
          <div key={i} className="mini-card" />
        ))}
      </div>
    ) : null

  const pill = (
    <div className="seat-info">
      <div className={`seat-av ${isBot ? 'bot' : ''} ${away ? 'away' : ''}`}>
        {showVideo ? (
          <video ref={attach} className={media?.isSelf ? 'mirror' : ''} autoPlay playsInline muted />
        ) : isBot ? (
          '🤖'
        ) : (
          initials
        )}
      </div>
      <div className="seat-text">
        <span className="name">{name}</span>
        <span className="sub">{away ? <span className="ai-tag">away · AI</span> : isBot ? 'bot' : 'online'}</span>
      </div>
      <div className="seat-badges">
        {dealer && (
          <span className="badge dealer" title="Dealer">
            D
          </span>
        )}
        {tricks != null && tricks > 0 && (
          <span className="badge tricks" title="Tricks won this hand">
            {tricks}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className={`seat seat-${place} ${active ? 'is-turn' : ''} ${media?.speaking ? 'speaking' : ''}`}>
      {place === 'top' && fan}
      {pill}
      {place !== 'top' && fan}
    </div>
  )
}
