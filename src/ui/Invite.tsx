import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

function useQR(text: string): string {
  const [src, setSrc] = useState('')
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 260, color: { dark: '#0b3d2e', light: '#fbfaf6' } })
      .then(setSrc)
      .catch(() => setSrc(''))
  }, [text])
  return src
}

/** A share sheet: a QR to scan into the same table, plus the link to copy. */
export function InvitePanel({ url, onClose }: { url: string; onClose: () => void }) {
  const qr = useQR(url)
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )

  return (
    <div className="invite-backdrop" onClick={onClose} role="presentation">
      <div className="invite-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite players">
        <h3>Invite players</h3>
        <p className="dim">Scan to join the table — or share the link.</p>
        <div className="qr-frame">{qr ? <img className="qr" src={qr} alt="Scan to join" /> : <div className="qr ph" />}</div>
        <div className="invite-link">
          <code>{url.replace(/^https?:\/\//, '')}</code>
        </div>
        <div className="invite-actions">
          <button type="button" className="primary" onClick={copy}>
            {copied ? '✓ Copied' : 'Copy link'}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
