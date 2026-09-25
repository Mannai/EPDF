import { useRef, useState } from 'react'
import type { ScanPreset } from '@shared/features/scan/enhance'
import { fullQuad, isConvexQuad, type Pt, type Quad } from '@shared/features/scan/geometry'
import type { PaperChoice } from '@shared/features/scan/pipeline'
import { announce, autoDetect, rerenderAll, resetQuad, rotatePage, setQuad } from './pages'
import { useScan } from './store'
import { BitmapCanvas, Field } from './ui'

/** Step 2: adjust the page corners (mouse, touch or keyboard), rotate, and choose how pages are cleaned up. */

const CORNERS = ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const PRESETS: { id: ScanPreset; label: string; hint: string }[] = [
  { id: 'color', label: 'Colour', hint: 'Removes shadows and evens out the paper colour.' },
  { id: 'gray', label: 'Grayscale', hint: 'Removes shadows, no colour.' },
  { id: 'bw', label: 'Black & white document', hint: 'Sharp text, smallest files.' },
  { id: 'original', label: 'Original', hint: 'No changes to the picture.' }
]

function mmLabel(w: number, h: number): string {
  const mm = (pt: number): number => Math.round((pt / 72) * 25.4)
  const a4 = (a: number, b: number): boolean => Math.abs(a - 210) <= 2 && Math.abs(b - 297) <= 2
  const letter = (a: number, b: number): boolean => Math.abs(a - 216) <= 2 && Math.abs(b - 279) <= 2
  const [x, y] = [mm(w), mm(h)]
  const name = a4(x, y) || a4(y, x) ? ' (A4)' : letter(x, y) || letter(y, x) ? ' (Letter)' : ''
  return `${x} × ${y} mm${name}`
}

export function PageEditor(): JSX.Element {
  const pages = useScan((s) => s.pages)
  const selectedId = useScan((s) => s.selectedId)
  const previews = useScan((s) => s.previews)
  const options = useScan((s) => s.options)
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const index = pages.findIndex((p) => p.id === selectedId)
  const page = pages[index]
  const pv = page ? previews[page.id] : undefined

  const setOptions = (patch: Partial<typeof options>): void => {
    useScan.setState((s) => ({ options: { ...s.options, ...patch } }))
    rerenderAll()
  }

  if (!page) return <p className="text-sm text-ink-muted">Choose a page above to adjust it.</p>

  const quad: Quad = page.quad ?? fullQuad(0)

  const moveCorner = (i: number, x: number, y: number): void => {
    const q = quad.map((p) => ({ ...p })) as Quad
    q[i] = { x: clamp01(x), y: clamp01(y) }
    if (!isConvexQuad(q)) return announce('That corner cannot cross the others.')
    setQuad(page.id, q)
  }

  const fromPointer = (e: React.PointerEvent): Pt | null => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return null
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  const onKey = (i: number) => (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 0.03 : e.altKey ? 0.001 : 0.006
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const v = d[e.key]
    if (!v) return
    e.preventDefault()
    moveCorner(i, quad[i].x + v[0], quad[i].y + v[1])
  }

  const info = pv?.resultInfo
  return (
    <div data-testid="page-editor">
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="orig-h">
          <h3 id="orig-h" className="mb-1 text-sm font-medium">
            Page {index + 1}: mark the corners of the page
          </h3>
          <div ref={boxRef} className="relative inline-block max-w-full touch-none select-none align-top" data-testid="editor-box">
            {pv?.view ? <BitmapCanvas bitmap={pv.view} label={`Picture of page ${index + 1} with the page corners marked`} className="block max-h-[42vh] w-auto max-w-full" testId="editor-view" /> : <div className="flex h-48 w-64 items-center justify-center text-sm text-ink-muted">Loading…</div>}
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
              <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(36,87,214,0.14)" stroke="#2457d6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
            {pv?.view &&
              quad.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`${CORNERS[i]} corner, at ${Math.round(p.x * 100)} percent across and ${Math.round(p.y * 100)} percent down. Move with the arrow keys; hold Shift for bigger steps.`}
                  className={`absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white bg-accent shadow outline-none ring-2 ring-accent focus-visible:ring-4 focus-visible:ring-offset-2 ${drag === i ? 'scale-125' : ''}`}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                  data-testid={`corner-${i}`}
                  onKeyDown={onKey(i)}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    setDrag(i)
                  }}
                  onPointerMove={(e) => {
                    if (drag !== i) return
                    const pt = fromPointer(e)
                    if (pt) moveCorner(i, pt.x, pt.y)
                  }}
                  onPointerUp={() => setDrag(null)}
                  onPointerCancel={() => setDrag(null)}
                />
              ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Corner tools">
            <button type="button" className="btn" onClick={() => void autoDetect(page.id)} disabled={page.state !== 'ready'} data-testid="auto-detect">
              Find page edges
            </button>
            <button type="button" className="btn" onClick={() => resetQuad(page.id)} data-testid="reset-corners">
              Use the whole picture
            </button>
            <button type="button" className="btn" onClick={() => rotatePage(page.id, -1)}>
              Rotate left
            </button>
            <button type="button" className="btn" onClick={() => rotatePage(page.id, 1)}>
              Rotate right
            </button>
          </div>
          {page.edgesNotFound && (
            <p role="status" className="mt-2 text-sm text-ink-muted" data-testid="edges-hint">
              The page edges could not be found automatically. Drag the four corners onto the corners of the page.
            </p>
          )}
        </section>
        <section aria-labelledby="res-h">
          <h3 id="res-h" className="mb-1 text-sm font-medium">
            Result
          </h3>
          <div className="inline-block max-w-full rounded-md border border-line bg-white align-top">
            {pv?.result ? <BitmapCanvas bitmap={pv.result} label={`Corrected page ${index + 1}`} className="block max-h-[42vh] w-auto max-w-full" testId="editor-result" /> : <div className="flex h-48 w-64 items-center justify-center text-sm text-ink-muted">Rendering…</div>}
          </div>
          {info && (
            <p className="mt-2 text-sm text-ink-muted" data-testid="result-info">
              Page size {mmLabel(info.pageWidthPt, info.pageHeightPt)}
              {Math.abs(info.skewDegrees) >= 0.3 ? `, text straightened by ${Math.abs(info.skewDegrees).toFixed(1)}°` : ''}
            </p>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-x-6 gap-y-2 border-t border-line pt-3 md:grid-cols-2">
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Clean-up (applies to all pages)</legend>
          {PRESETS.map((p) => (
            <label key={p.id} className="mb-1 flex items-start gap-2">
              <input type="radio" name="scan-preset" className="mt-1 accent-accent" checked={options.preset === p.id} onChange={() => setOptions({ preset: p.id })} data-testid={`preset-${p.id}`} />
              <span>
                {p.label}
                <span className="block text-xs text-ink-muted">{p.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label className="mb-3 flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-accent" checked={options.straighten} onChange={(e) => setOptions({ straighten: e.target.checked })} data-testid="straighten" />
            <span>
              Straighten crooked text
              <span className="block text-xs text-ink-muted">Turns the page slightly when its lines of text are tilted.</span>
            </span>
          </label>
          <Field label="Page size of photographed pages" hint="Scanner pages keep the size they were scanned at.">
            {(id) => (
              <select id={id} className="field w-full" value={options.paper} onChange={(e) => setOptions({ paper: e.target.value as PaperChoice })} data-testid="paper-choice">
                <option value="auto">Automatic (A4 or Letter when it fits)</option>
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
                <option value="none">Keep the proportions of the crop</option>
              </select>
            )}
          </Field>
        </div>
      </div>
    </div>
  )
}
