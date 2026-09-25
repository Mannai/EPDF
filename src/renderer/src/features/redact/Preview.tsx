import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { getLoaded } from '../../pdf/docCache'
import { toBox } from './pages'
import { openWithPdfjs } from './pdfjsText'
import { pagesOf, type UiMark } from './store'

/**
 * Before/after view of the marked pages: "Before" is the document as it is now with the marks drawn on it,
 * "After" is the redacted result rendered from its own bytes (what a reader of the saved file will see).
 */
export function Preview({ docId, afterBytes, marks }: { docId: string; afterBytes: Uint8Array; marks: readonly UiMark[] }): JSX.Element {
  const pages = pagesOf(marks)
  const [idx, setIdx] = useState(0)
  const [mode, setMode] = useState<'before' | 'after'>('after')
  const [after, setAfter] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [boxes, setBoxes] = useState<{ left: number; top: number; width: number; height: number }[]>([])
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const pageIndex = pages[Math.min(idx, pages.length - 1)] ?? 0

  useEffect(() => {
    const task = openWithPdfjs(afterBytes)
    let cancelled = false
    task.promise.then(
      (doc) => {
        if (!cancelled) setAfter(doc)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      cancelled = true
      void task.destroy().catch(() => undefined)
    }
  }, [afterBytes])

  useEffect(() => {
    const source = mode === 'before' ? getLoaded(docId)?.doc : after
    const canvas = canvasRef.current
    if (!source || !canvas) return
    let cancelled = false
    let task: { cancel(): void; promise: Promise<unknown> } | undefined
    void (async () => {
      try {
        const page = await source.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(2, 520 / base.width)
        const vp = page.getViewport({ scale })
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({ canvasContext: ctx, canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined, background: 'rgb(255,255,255)' })
        await task.promise
        if (cancelled) return
        setSize({ w: vp.width, h: vp.height })
        setBoxes(mode === 'before' ? marks.filter((m) => m.pageIndex === pageIndex).flatMap((m) => m.rects.map((r) => toBox(vp, r))) : [])
        canvas.dataset.ready = `${mode}:${pageIndex + 1}`
      } catch (e) {
        if (!cancelled && !(e as { name?: string })?.name?.includes('Cancel')) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [mode, after, pageIndex, docId, marks])

  if (pages.length === 0) return <p className="text-sm text-ink-muted">Nothing to preview.</p>
  return (
    <div className="mt-3 rounded-md border border-line p-2" data-testid="redact-preview">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Preview mode" className="inline-flex overflow-hidden rounded-md border border-line">
          {(['before', 'after'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className="h-8 px-3 text-sm outline-none hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-accent aria-pressed:text-accent-ink" data-testid={`preview-${m}`}>
              {m === 'before' ? 'Before' : 'After'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm">
          <span>Page</span>
          <select aria-label="Preview page" className="field" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {pages.map((p, i) => (
              <option key={p} value={i}>
                {p + 1}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-ink-muted">{mode === 'before' ? 'The document now, with the marks in red.' : 'What the saved file will show.'}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <div tabIndex={0} role="region" aria-label="Page preview" className="max-h-[50vh] overflow-auto rounded bg-canvas p-2 outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <div className="relative mx-auto bg-white" style={size ? { width: size.w, height: size.h } : { width: 320, height: 200 }}>
          <canvas ref={canvasRef} data-testid="preview-canvas" aria-label={`Preview of page ${pageIndex + 1}, ${mode === 'before' ? 'before' : 'after'} redaction`} role="img" />
          {boxes.map((b, i) => (
            <div key={i} aria-hidden="true" className="pointer-events-none absolute" style={{ ...b, background: 'rgb(220 38 38 / 0.32)', outline: '2px dashed rgb(185 28 28)' }} />
          ))}
        </div>
      </div>
    </div>
  )
}
