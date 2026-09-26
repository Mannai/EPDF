import { useCallback, useEffect, useRef, useState } from 'react'
import type { Quad } from '@shared/features/scan/geometry'
import { addImage, announce } from './pages'
import { SteadyTracker } from './steady'
import { useScan } from './store'
import { Field, Spinner, plural } from './ui'
import { scanWorker } from './worker/client'

/** Source 2: a webcam with a live preview, page outline, manual capture and optional auto-capture. */

type CamState = { kind: 'starting' } | { kind: 'live' } | { kind: 'error'; message: string }

export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Epdf was not allowed to use the camera. Allow camera access for Epdf in your system privacy settings, then choose Try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Connect a webcam (or pick another one in the list), then choose Try again.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera could not be opened. Another program may be using it. Close that program and choose Try again.'
  return `The camera could not be started${err instanceof Error && err.message ? ` (${err.message})` : ''}.`
}

export function WebcamPanel(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [requested, setRequested] = useState('')
  const [activeId, setActiveId] = useState('')
  const [cam, setCam] = useState<CamState>({ kind: 'starting' })
  const [auto, setAuto] = useState(false)
  const [found, setFound] = useState<'none' | 'found' | 'steady'>('none')
  const [flash, setFlash] = useState(false)
  const [retry, setRetry] = useState(0)
  const pageCount = useScan((s) => s.pages.length)
  const [captured, setCaptured] = useState(0)
  const autoRef = useRef(false)
  autoRef.current = auto

  const capture = useCallback((): void => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')?.drawImage(v, 0, 0)
    c.toBlob(
      (blob) => {
        if (!blob) return
        addImage(blob, 'webcam')
        setCaptured((n) => n + 1)
        setFlash(true)
        setTimeout(() => setFlash(false), 250)
        announce('Page captured.')
      },
      'image/jpeg',
      0.92
    )
  }, [])

  // open / re-open the camera
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    setCam({ kind: 'starting' })
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { ...(requested ? { deviceId: { exact: requested } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 } } })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          await v.play().catch(() => undefined)
        }
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
        if (cancelled) return
        setDevices(list)
        const active = stream.getVideoTracks()[0]?.getSettings().deviceId
        if (active) setActiveId(active)
        setCam({ kind: 'live' })
      } catch (err) {
        if (!cancelled) setCam({ kind: 'error', message: cameraErrorMessage(err) })
      }
    })()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [requested, retry])

  // page detection on the live picture
  useEffect(() => {
    if (cam.kind !== 'live') return
    const tracker = new SteadyTracker()
    const small = document.createElement('canvas')
    let busy = false
    let stopped = false
    const draw = (quad: Quad | null, steady: boolean): void => {
      const o = overlayRef.current
      const v = videoRef.current
      if (!o || !v) return
      const w = v.clientWidth
      const h = v.clientHeight
      if (o.width !== w || o.height !== h) {
        o.width = w
        o.height = h
      }
      const g = o.getContext('2d')
      if (!g) return
      g.clearRect(0, 0, w, h)
      if (!quad) return
      g.lineWidth = 3
      g.strokeStyle = steady ? '#16a34a' : '#facc15'
      g.fillStyle = steady ? 'rgba(22,163,74,0.18)' : 'rgba(250,204,21,0.12)'
      g.beginPath()
      quad.forEach((p, i) => (i === 0 ? g.moveTo(p.x * w, p.y * h) : g.lineTo(p.x * w, p.y * h)))
      g.closePath()
      g.fill()
      g.stroke()
    }
    const timer = setInterval(() => {
      const v = videoRef.current
      if (busy || stopped || !v || !v.videoWidth || v.paused) return
      busy = true
      const f = 256 / Math.max(v.videoWidth, v.videoHeight)
      small.width = Math.max(1, Math.round(v.videoWidth * f))
      small.height = Math.max(1, Math.round(v.videoHeight * f))
      small.getContext('2d')?.drawImage(v, 0, 0, small.width, small.height)
      createImageBitmap(small)
        .then((bitmap) => scanWorker.call('detectFrame', { bitmap }, [bitmap]))
        .then((r) => {
          if (stopped) return
          const t = tracker.update(r.quad, Date.now())
          draw(r.quad, t.steady)
          setFound(r.quad ? (t.steady ? 'steady' : 'found') : 'none')
          if (t.fire && autoRef.current) capture()
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false
        })
    }, 250)
    return () => {
      stopped = true
      clearInterval(timer)
      overlayRef.current?.getContext('2d')?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)
    }
  }, [cam.kind, capture])

  return (
    <div data-testid="webcam-panel">
      {cam.kind === 'error' && (
        <div className="mb-3 rounded-md border border-danger-line p-3 text-sm" role="alert" data-testid="webcam-error">
          <p className="text-danger">{cam.message}</p>
          <button type="button" className="btn mt-2" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="relative overflow-hidden rounded-md bg-black">
          <video ref={videoRef} muted playsInline aria-label="Camera preview" className="block w-full" data-testid="webcam-video" />
          <canvas ref={overlayRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-full w-full" />
          {flash && <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-white/70" />}
          {cam.kind === 'starting' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white">
              <Spinner label="Starting the camera…" />
            </div>
          )}
        </div>
        <div>
          <Field label="Camera">
            {(id) => (
              <select id={id} className="field w-full" value={requested || activeId} onChange={(e) => setRequested(e.target.value)} disabled={devices.length === 0}>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <button type="button" className="btn-primary mb-3 w-full" onClick={capture} disabled={cam.kind !== 'live'} data-testid="webcam-capture">
            Capture page
          </button>
          <label className="mb-2 flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-accent" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="webcam-auto" />
            <span>
              Capture automatically when the page is steady
              <span className="block text-xs text-ink-muted">Hold each page still inside the frame. The outline turns green just before it is captured.</span>
            </span>
          </label>
          <p className="text-sm text-ink-muted" data-testid="webcam-detect">
            {cam.kind !== 'live' ? '' : found === 'none' ? 'No page outline found yet.' : found === 'found' ? 'Page found. Hold it steady.' : 'Steady.'}
          </p>
          <p className="mt-2 text-sm text-ink-muted" data-testid="webcam-count">
            {captured > 0 ? `${plural(captured, 'page')} captured with the camera (${plural(pageCount, 'page')} in total).` : 'Capture as many pages as you like; the camera stays on.'}
          </p>
        </div>
      </div>
    </div>
  )
}
