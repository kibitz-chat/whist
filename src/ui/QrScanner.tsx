import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'

/**
 * In-app QR scanner: opens the rear camera and reads a QR with the native
 * BarcodeDetector when available (Android Chrome), falling back to jsQR (iOS Safari,
 * etc.). On a hit it returns the decoded text. Lets a player scan a friend's table
 * QR from INSIDE the app, instead of the phone's camera app bouncing them to a
 * browser tab. (Distinct from the call camera.)
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    // BarcodeDetector isn't in the TS DOM lib and isn't on every browser.
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(s: CanvasImageSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector
    const detector = BD ? new BD({ formats: ['qr_code'] }) : null

    const tick = async () => {
      if (stopped) return
      const v = videoRef.current
      if (v && v.videoWidth) {
        try {
          let text: string | null = null
          if (detector) {
            const codes = await detector.detect(v)
            if (codes[0]) text = codes[0].rawValue
          } else if (ctx) {
            canvas.width = v.videoWidth
            canvas.height = v.videoHeight
            ctx.drawImage(v, 0, 0)
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const r = jsQR(img.data, img.width, img.height)
            if (r) text = r.data
          }
          if (text) {
            stopped = true
            onResult(text)
            return
          }
        } catch {
          /* a transient decode error — keep scanning */
        }
      }
      raf = requestAnimationFrame(tick)
    }

    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
        const v = videoRef.current
        if (!v) return
        v.srcObject = stream
        await v.play()
        setErr('') // clear any earlier (e.g. cancelled-mount) error now that we're live
        tick()
      } catch {
        if (!stopped) setErr('Camera unavailable — allow camera access, or share the link instead.')
      }
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [onResult])

  return (
    <div className="scan-backdrop" onClick={onClose} role="presentation">
      <div className="scan-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Scan a table QR">
        <h3>Scan a table QR</h3>
        <div className="scan-stage">
          <video ref={videoRef} className="scan-video" muted playsInline />
          <div className="scan-reticle" />
        </div>
        {err ? <p className="err">{err}</p> : <p className="dim">Point the camera at a friend's table QR.</p>}
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
