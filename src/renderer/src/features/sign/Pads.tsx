import type { BundledFontName } from '@shared/features/forms'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { canvasOfPixels, finalizeSignature, makeCanvas, pixelsOf, type SignatureImage } from './canvasUtil'
import { DEFAULT_WHITE_THRESHOLD, fitWithin, removeNearWhite } from './imageProcessing'
import { inkBounds, renderStrokes, simplifyStroke, type Pt, type Stroke } from './strokes'
import { SCRIPT_FONTS, ensureScriptFont, renderTypedSignature } from './typed'

/**
 * The three ways to make a signature. Each pad reports its current result (a transparent PNG, already
 * trimmed) through `onChange`, or null while it is empty.
 */
export interface PadProps {
  onChange(img: SignatureImage | null): void
}

const INK = [
  { id: 'black', label: 'Black', color: '#000000' },
  { id: 'blue', label: 'Blue', color: '#0b2a8a' }
]

const PAD_W = 560
const PAD_H = 170
const BASE_WIDTH = 3

/** Draw with mouse, trackpad, touch or pen (pointer events). */
export function DrawPad({ onChange }: PadProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Stroke[]>([])
  const current = useRef<Stroke | null>(null)
  const [count, setCount] = useState(0)
  const [inkId, setInkId] = useState('black')
  const [pressure, setPressure] = useState(true)
  const ink = INK.find((i) => i.id === inkId)!.color
  const seq = useRef(0)

  const paint = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(PAD_W * dpr)) {
      c.width = Math.round(PAD_W * dpr)
      c.height = Math.round(PAD_H * dpr)
    }
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    // A baseline guide (screen only; it is not part of the saved image).
    ctx.strokeStyle = '#c5cbd3'
    ctx.lineWidth = 1 * dpr
    ctx.beginPath()
    ctx.moveTo(24 * dpr, PAD_H * 0.72 * dpr)
    ctx.lineTo((PAD_W - 24) * dpr, PAD_H * 0.72 * dpr)
    ctx.stroke()
    renderStrokes(ctx, [...strokes.current, ...(current.current && !strokes.current.includes(current.current) ? [current.current] : [])], { width: BASE_WIDTH, pressure, color: ink }, dpr)
  }, [ink, pressure])

  const emit = useCallback(async () => {
    const my = ++seq.current
    const all = strokes.current
    if (all.length === 0 || !inkBounds(all, BASE_WIDTH)) return onChange(null)
    const scale = 2
    const c = makeCanvas(PAD_W * scale, PAD_H * scale)
    renderStrokes(c.getContext('2d')!, all, { width: BASE_WIDTH, pressure, color: ink }, scale)
    const img = await finalizeSignature(c)
    if (my === seq.current) onChange(img)
  }, [ink, pressure, onChange])

  useEffect(() => {
    paint()
    void emit()
  }, [paint, emit])

  const point = (e: { clientX: number; clientY: number; pressure: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * PAD_W) / r.width, y: ((e.clientY - r.top) * PAD_H) / r.height, p: e.pressure }
  }

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    current.current = [point(e.nativeEvent)]
    paint()
  }
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const s = current.current
    if (!s) return
    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    for (const ev of events.length ? events : [e.nativeEvent]) s.push(point(ev))
    paint()
  }
  const finish = (): void => {
    const s = current.current
    current.current = null
    if (!s) return
    strokes.current = [...strokes.current, simplifyStroke(s)]
    setCount(strokes.current.length)
    paint()
    void emit()
  }
  const undo = (): void => {
    strokes.current = strokes.current.slice(0, -1)
    setCount(strokes.current.length)
    paint()
    void emit()
  }
  const clear = (): void => {
    strokes.current = []
    setCount(0)
    paint()
    void emit()
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Signature drawing area. Draw with a mouse, trackpad, touch or pen. If you can’t draw, use the Type or Import tabs instead."
        data-testid="signature-pad"
        tabIndex={-1}
        className="block w-full max-w-[560px] cursor-crosshair rounded-md border border-line bg-white"
        style={{ aspectRatio: `${PAD_W} / ${PAD_H}`, touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn" onClick={undo} disabled={count === 0}>
          Undo stroke
        </button>
        <button type="button" className="btn" onClick={clear} disabled={count === 0}>
          Clear
        </button>
        <label className="flex items-center gap-1 text-xs">
          Ink
          <select className="field h-8" value={inkId} onChange={(e) => setInkId(e.target.value)}>
            {INK.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={pressure} onChange={(e) => setPressure(e.target.checked)} />
          Pen pressure
        </label>
      </div>
    </div>
  )
}

/** Type a name and pick one of the bundled script fonts. */
export function TypePad({ onChange, initialText = '' }: PadProps & { initialText?: string }): JSX.Element {
  const [text, setText] = useState(initialText)
  const [fontId, setFontId] = useState<BundledFontName>(SCRIPT_FONTS[0].id)
  const [inkId, setInkId] = useState('black')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ink = INK.find((i) => i.id === inkId)!.color

  useEffect(() => {
    let cancelled = false
    void Promise.all(SCRIPT_FONTS.map((f) => ensureScriptFont(f.id))).then(
      () => !cancelled && setReady(true),
      () => !cancelled && setError('The signature fonts could not be loaded.')
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      renderTypedSignature(text, fontId, ink).then(
        (img) => !cancelled && onChange(img),
        (err) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : String(err))
          onChange(null)
        }
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text, fontId, ink, onChange])

  return (
    <div>
      <label className="block text-xs" htmlFor="typed-signature-text">
        Type your name
      </label>
      <input id="typed-signature-text" className="field mt-1 w-full" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
      <fieldset className="mt-3">
        <legend className="text-xs">Style</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {SCRIPT_FONTS.map((f) => (
            <label key={f.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 ${fontId === f.id ? 'border-accent bg-accent/10' : 'border-line'}`}>
              <input type="radio" name="typed-font" value={f.id} checked={fontId === f.id} onChange={() => setFontId(f.id)} />
              <span className="sr-only">{f.label}</span>
              <span
                aria-hidden="true"
                className="truncate rounded bg-white px-2 text-3xl leading-tight"
                style={{ fontFamily: ready ? `"${f.family}"` : undefined, color: ink }}
              >
                {text.trim() || 'Your name'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 flex items-center gap-1 text-xs">
        Ink
        <select className="field h-8" value={inkId} onChange={(e) => setInkId(e.target.value)}>
          {INK.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

const MAX_IMPORT_BYTES = 12 * 1024 * 1024
const MAX_IMPORT_SIDE = 1400

/** Import a PNG or JPEG (a scan or a photo), optionally turning the white paper transparent. */
export function ImportPad({ onChange }: PadProps): JSX.Element {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [fileName, setFileName] = useState('')
  const [removeBg, setRemoveBg] = useState(true)
  const [threshold, setThreshold] = useState(DEFAULT_WHITE_THRESHOLD)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const onFile = async (file: File | undefined): Promise<void> => {
    setError(null)
    setSource(null)
    onChange(null)
    setPreview(null)
    if (!file) return
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setError('Choose a PNG or JPEG image.')
    if (file.size > MAX_IMPORT_BYTES) return setError('That image is too large (the limit is 12 MB).')
    try {
      const bmp = await createImageBitmap(file)
      setSource(bmp)
      setFileName(file.name)
    } catch {
      setError('This file could not be read as an image.')
    }
  }

  useEffect(() => {
    if (!source) return
    let cancelled = false
    void (async () => {
      try {
        const { width, height } = fitWithin(source.width, source.height, MAX_IMPORT_SIDE)
        let canvas = makeCanvas(width, height)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(source, 0, 0, width, height)
        if (removeBg) canvas = canvasOfPixels(removeNearWhite(pixelsOf(canvas), threshold))
        const img = await finalizeSignature(canvas)
        if (cancelled) return
        if (!img) {
          setError('Nothing was left after removing the background. Lower the background removal or turn it off.')
          setPreview(null)
          return onChange(null)
        }
        setError(null)
        let bin = ''
        for (let i = 0; i < img.png.length; i += 0x8000) bin += String.fromCharCode(...img.png.subarray(i, i + 0x8000))
        setPreview(`data:image/png;base64,${btoa(bin)}`)
        onChange(img)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        onChange(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, removeBg, threshold, onChange])

  return (
    <div>
      <label className="block text-xs" htmlFor="signature-import-file">
        Image of your signature (PNG or JPEG)
      </label>
      <input
        id="signature-import-file"
        data-testid="signature-import-file"
        type="file"
        accept="image/png,image/jpeg"
        className="mt-1 block w-full text-sm"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
          Remove white background
        </label>
        <label className="flex items-center gap-2 text-xs">
          Strength
          <input type="range" min={150} max={250} value={threshold} disabled={!removeBg} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Background removal: lower removes more of the paper" />
        </label>
      </div>
      <div
        className="mt-3 flex h-32 items-center justify-center rounded-md border border-line"
        style={{ backgroundColor: '#fff', backgroundImage: 'conic-gradient(#e5e7eb 25%, transparent 0 50%, #e5e7eb 0 75%, transparent 0)', backgroundSize: '16px 16px' }}
      >
        {preview ? <img src={preview} alt={`Preview of ${fileName || 'the imported signature'}`} className="max-h-28 max-w-full" /> : <span className="rounded bg-white/80 px-2 text-xs text-black">No image yet</span>}
      </div>
    </div>
  )
}
