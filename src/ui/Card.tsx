import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import { type Card as CardModel, SUIT_SYMBOL, cardId, rankLabel } from '../engine/cards'

const RED = new Set(['H', 'D'])

/** A face-down card back (opponents' fans, the deck look). */
export function CardBack({ style, className = '' }: { style?: CSSProperties; className?: string }) {
  return (
    <div className={`card ${className}`} style={style} aria-hidden>
      <div className="card-back" />
    </div>
  )
}

export function CardView({
  card,
  onClick,
  disabled,
  dim,
  style,
}: {
  card: CardModel
  onClick?: (c: CardModel) => void
  disabled?: boolean
  dim?: boolean
  style?: CSSProperties
}) {
  const colour = RED.has(card.suit) ? 'is-red' : 'is-black'
  const interactive = !!onClick && !disabled
  const label = rankLabel(card.rank)
  const symbol = SUIT_SYMBOL[card.suit]

  // Track press ourselves so a mis-tap can be cancelled: press, slide the finger
  // off the card, release — only a release still on the card plays it.
  const downRef = useRef(false)
  const [pressed, setPressed] = useState(false)
  const overSelf = (e: ReactPointerEvent<HTMLDivElement>): boolean => {
    const hit = document.elementFromPoint(e.clientX, e.clientY)
    return !!hit && hit.closest('[data-card-id]') === e.currentTarget
  }
  const handlers = interactive
    ? {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          downRef.current = true
          setPressed(true)
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* capture unsupported — slide-off still works via elementFromPoint */
          }
        },
        onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
          if (downRef.current) {
            const over = overSelf(e)
            setPressed((p) => (p === over ? p : over))
          }
        },
        onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
          const play = downRef.current && overSelf(e)
          downRef.current = false
          setPressed(false)
          if (play) onClick!(card)
        },
        onPointerCancel: () => {
          downRef.current = false
          setPressed(false)
        },
      }
    : {}

  const cls = ['card', colour, interactive ? 'playable' : '', dim ? 'dim' : ''].filter(Boolean).join(' ')
  const pressedStyle: CSSProperties | undefined = pressed
    ? { ...style, transform: `${style?.transform ?? ''} translateY(calc(var(--card-h) * -0.06))`, zIndex: 50 }
    : style

  return (
    <div
      className={cls}
      style={pressedStyle}
      data-card-id={interactive ? cardId(card) : undefined}
      role={interactive ? 'button' : undefined}
      aria-label={`${label} of ${card.suit}`}
      {...handlers}
    >
      <div className="card-face">
        <span className="card-index tl">
          <span className="rank">{label}</span>
          <span className="pip">{symbol}</span>
        </span>
        <span className="card-index br">
          <span className="rank">{label}</span>
          <span className="pip">{symbol}</span>
        </span>
        <div className="card-center">
          <span className="big-rank">{label}</span>
          <span className="big-suit">{symbol}</span>
        </div>
      </div>
    </div>
  )
}
