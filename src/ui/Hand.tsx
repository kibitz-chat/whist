import type { CSSProperties } from 'react'
import { type Card, cardId } from '../engine/cards'
import { CardView } from './Card'

/** The local player's hand as an overlapping, gently-curved fan. */
export function Hand({
  cards,
  legal,
  myTurn,
  onPlay,
}: {
  cards: Card[]
  legal: Card[]
  myTurn: boolean
  onPlay: (c: Card) => void
}) {
  const legalSet = new Set(legal.map(cardId))
  const n = cards.length
  const mid = (n - 1) / 2
  const anglePer = Math.min(2.3, 26 / Math.max(n, 1))

  return (
    <div className="hand-fan" style={{ '--n': n } as CSSProperties}>
      {cards.map((card, i) => {
        const offset = i - mid
        const rot = offset * anglePer
        const lift = Math.abs(offset) ** 1.35 * 2.0
        const playable = myTurn && legalSet.has(cardId(card))
        const style: CSSProperties = {
          marginLeft: i === 0 ? 0 : 'calc(var(--card-w) * -0.30)',
          transform: `rotate(${rot}deg) translateY(${lift}px)`,
          zIndex: i,
        }
        return (
          <CardView
            key={cardId(card)}
            card={card}
            onClick={playable ? onPlay : undefined}
            disabled={!playable}
            dim={myTurn && !playable && !legalSet.has(cardId(card))}
            style={style}
          />
        )
      })}
    </div>
  )
}
