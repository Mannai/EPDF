import { useEffect, useMemo, useRef, useState } from 'react'
import { isVisualDifference, type Region } from './diff/pixel'
import type { Session } from './session'
import { useCompare, type Entry } from './store'
import { PixelClient, renderPair, type PairImages } from './visual'

const VIEW_SCALE = 1.5

type Show = 'overlay' | 'old' | 'new'

const fmt = (n: number): string => n.toLocaleString('en-US')

interface Props {
  docId: string
  session: Session
  entry: Entry
}

/**
 * The visual (pixel) comparison of one aligned page pair: both pages are rendered at the same scale and compared in a
 * worker. Differences are painted magenta on a faded copy of the new page and framed with dashed outlines, so the
 * result never depends on colour alone. A slider sets how small a colour change still counts.
 */
export function VisualDiff({ docId, session, entry }: Props): JSX.Element {
  const { result, oldSide, newSide } = session
  const patch = useCompare((s) => s.patch)
  const startScan = useCompare((s) => s.startScan)
  const stopScan = useCompare((s) => s.stopScan)
  const { visual, sensitivity } = entry

  const both = useMemo(() => result.pairs.map((p, i) => [p, i] as const).filter(([p]) => p.old !== null && p.new !== null).map(([, i]) => i), [result])
  const pair = both.includes(entry.visualPair) ? entry.visualPair : (both[0] ?? -1)
  const at = both.indexOf(pair)

  const [show, setShow] = useState<Show>('overlay')
  const [images, setImages] = useState<PairImages | null>(null)
  const [diff, setDiff] = useState<{ count: number; ratio: number; regions: Region[]; mask: Uint8Array } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const client = useRef<PixelClient | null>(null)

  useEffect(() => {
    client.current = new PixelClient()
    return () => {
      client.current?.dispose()
      client.current = null
    }
  }, [])

  // Render both pages of the selected pair.
  useEffect(() => {
    if (pair < 0) return
    let cancelled = false
    setBusy(true)
    setError(null)
    setDiff(null)
    const p = result.pairs[pair]
    renderPair(oldSide.loaded, p.old, newSide.loaded, p.new, VIEW_SCALE)
      .then((img) => {
        if (!cancelled) setImages(img)
      })
      .catch((err) => {
        if (!cancelled) setError(`This page pair could not be rendered: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [pair, result, oldSide, newSide])

  // Compare them whenever the images or the sensitivity change (debounced while the slider moves).
  useEffect(() => {
    if (!images || !client.current) return
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(() => {
      void client.current
        ?.diff(images.a, images.b, images.w, images.h, sensitivity, true)
        .then((r) => {
          if (cancelled) return
          setDiff({ count: r.count, ratio: r.ratio, regions: r.regions ?? [], mask: r.mask ?? new Uint8Array(0) })
          setBusy(false)
        })
        .catch(() => {
          if (!cancelled) setBusy(false)
        })
    }, 90)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [images, sensitivity])

  // Paint the chosen view.
  useEffect(() => {
    const c = canvas.current
    if (!c || !images) return
    c.width = images.w
    c.height = images.h
    const ctx = c.getContext('2d')
    if (!ctx) return
    const src = show === 'old' ? images.a : images.b
    const out = new Uint8ClampedArray(images.w * images.h * 4)
    if (show === 'overlay') {
      for (let i = 0; i < images.w * images.h; i++) {
        // the new page faded towards white, so the difference stands out
        out[i * 4] = 255 - (255 - src[i * 4]) * 0.45
        out[i * 4 + 1] = 255 - (255 - src[i * 4 + 1]) * 0.45
        out[i * 4 + 2] = 255 - (255 - src[i * 4 + 2]) * 0.45
        out[i * 4 + 3] = 255
        if (diff?.mask.length && diff.mask[i]) {
          out[i * 4] = 230
          out[i * 4 + 1] = 0
          out[i * 4 + 2] = 190
        }
      }
    } else out.set(src)
    ctx.putImageData(new ImageData(out, images.w, images.h), 0, 0)
    if (show === 'overlay' && diff) {
      ctx.lineWidth = 3
      for (const r of diff.regions) {
        ctx.setLineDash([8, 6])
        ctx.strokeStyle = '#000'
        ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6)
        ctx.setLineDash([8, 6])
        ctx.lineDashOffset = 7
        ctx.strokeStyle = '#fff'
        ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6)
        ctx.lineDashOffset = 0
      }
      ctx.setLineDash([])
    }
  }, [images, diff, show])

  const scanned = visual.counts[pair]
  const differing = visual.differing
  const p = pair >= 0 ? result.pairs[pair] : null
  const label = p ? `Page ${p.old}${p.old !== p.new ? ` / ${p.new}` : ''}` : ''
  const stale = visual.status === 'done' && visual.sensitivity !== sensitivity

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-visual">
      <div role="toolbar" aria-label="Visual comparison" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <button className="btn" disabled={at <= 0} onClick={() => patch(docId, { visualPair: both[at - 1] })}>
          Previous page pair
        </button>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-ink-muted">Page pair</span>
          <select className="field" value={pair} onChange={(e) => patch(docId, { visualPair: Number(e.target.value) })} disabled={both.length === 0} data-testid="visual-pair">
            {both.map((i) => {
              const q = result.pairs[i]
              const differs = differing.includes(i)
              return (
                <option key={i} value={i}>
                  {`Old ${q.old} / New ${q.new}${differs ? ' (differs)' : ''}`}
                </option>
              )
            })}
          </select>
        </label>
        <button className="btn" disabled={at < 0 || at >= both.length - 1} onClick={() => patch(docId, { visualPair: both[at + 1] })}>
          Next page pair
        </button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <label className="flex items-center gap-1.5 text-sm">
          <span>Sensitivity</span>
          <input type="range" min={0} max={100} step={5} value={sensitivity} aria-label="Sensitivity" data-testid="visual-sensitivity" onChange={(e) => patch(docId, { sensitivity: Number(e.target.value) })} />
          <output className="w-8 text-right tabular-nums" aria-hidden="true">
            {sensitivity}
          </output>
        </label>
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Show</legend>
          {(['overlay', 'old', 'new'] as const).map((s) => (
            <label key={s} className="flex items-center gap-1 text-sm">
              <input type="radio" name={`show-${docId}`} checked={show === s} onChange={() => setShow(s)} />
              {s === 'overlay' ? 'Differences' : s === 'old' ? 'Old page' : 'New page'}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-3 py-2 text-sm">
        {visual.status === 'running' ? (
          <>
            <span role="status" data-testid="visual-scan-status">
              Scanning page {visual.done} of {visual.total} for visual differences…
            </span>
            <button className="btn" onClick={() => stopScan(docId)}>
              Stop scan
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => void startScan(docId)} data-testid="visual-scan">
              {visual.status === 'done' || visual.status === 'cancelled' ? 'Scan all pages again' : 'Scan all pages for visual differences'}
            </button>
            {visual.status === 'done' && (
              <span data-testid="visual-scan-result">
                {differing.length === 0 ? 'No page pair differs visually.' : `${differing.length} page pair${differing.length === 1 ? ' differs' : 's differ'} visually.`}
                {stale && ' The sensitivity changed since this scan.'}
              </span>
            )}
            {visual.status === 'cancelled' && <span>Scan stopped.</span>}
            {visual.status === 'failed' && <span role="alert">The scan could not be completed.</span>}
          </>
        )}
        {differing.length > 0 && visual.status !== 'running' && (
          <span className="flex flex-wrap items-center gap-1" aria-label="Page pairs that differ visually">
            {differing.slice(0, 12).map((i) => (
              <button key={i} className="btn h-7 px-2 text-xs" onClick={() => patch(docId, { visualPair: i })} aria-label={`Show page pair ${result.pairs[i].old}${result.pairs[i].old !== result.pairs[i].new ? ` and ${result.pairs[i].new}` : ''}`}>
                {result.pairs[i].new}
              </button>
            ))}
            {differing.length > 12 && <span className="text-xs text-ink-muted">and {differing.length - 12} more</span>}
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-canvas p-4" data-testid="visual-canvas-host" tabIndex={0} aria-label="Visual comparison of the selected page pair" role="region">
        {pair < 0 ? (
          <p className="text-sm text-ink-muted">There is no page that exists in both versions, so there is nothing to compare visually.</p>
        ) : (
          <>
            <p role="status" className="mb-2 text-sm font-medium" data-testid="visual-summary">
              {error
                ? error
                : busy || !diff
                  ? `${label}: comparing…`
                  : isVisualDifference(diff)
                    ? `${label}: ${fmt(diff.count)} pixels differ (${(diff.ratio * 100).toFixed(2)}% of the page) in ${diff.regions.length} ${diff.regions.length === 1 ? 'area' : 'areas'}.`
                    : `${label}: no visual difference at this sensitivity.`}
              {scanned !== undefined && !busy && diff && ` (scan: ${fmt(scanned)} pixels)`}
            </p>
            <canvas ref={canvas} role="img" aria-label={`${label}: ${show === 'overlay' ? 'differences between the old and new page' : show === 'old' ? 'old page' : 'new page'}`} data-testid="visual-canvas" style={{ maxWidth: '100%', height: 'auto', background: '#fff', boxShadow: '0 1px 3px rgb(0 0 0 / 0.35)' }} />
          </>
        )}
      </div>
    </div>
  )
}
