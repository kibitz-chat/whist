import { useEffect, useRef, useState } from 'react'
import type { ChatLine } from '../net/protocol'

/**
 * The table chat. Shows the running log and an input; the kibitzer agent posts here
 * too (it's just another participant on the same `sendChat` channel). Collapsible so
 * it stays out of the way of the cards, with an unread badge when closed.
 */
export function ChatPanel({
  chat,
  selfUid,
  onSend,
}: {
  chat: ChatLine[]
  selfUid: string | null
  onSend: (text: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [draft, setDraft] = useState('')
  const [seen, setSeen] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the newest line whenever the log grows (and we're open).
  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    if (open) setSeen(chat.length)
  }, [chat.length, open])

  const unread = Math.max(0, chat.length - seen)
  const send = () => {
    const t = draft.trim()
    if (!t) return
    onSend(t)
    setDraft('')
  }

  if (!open) {
    return (
      <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Open chat">
        💬{unread > 0 && <span className="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span>💬 Table chat</span>
        <button type="button" className="chat-x" onClick={() => setOpen(false)} aria-label="Hide chat">
          ▾
        </button>
      </div>
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 ? (
          <div className="chat-empty">No messages yet.</div>
        ) : (
          chat.map((c, i) => (
            <div key={i} className={`chat-line ${c.by === selfUid ? 'mine' : ''} ${c.by.startsWith('kib') ? 'kib' : ''}`}>
              <span className="chat-who">{c.name}</span>
              <span className="chat-text">{c.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="chat-input">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Say something…"
          maxLength={280}
        />
        <button type="button" onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
