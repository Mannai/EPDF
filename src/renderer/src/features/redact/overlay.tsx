import type { PageViewport } from 'pdfjs-dist'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import type { Rect } from './logic/geom'
import { quadClip, registerPage, toBox } from './pages'
import { useDocRedact, useRedact, type UiMark } from './store'

export const AREA_TOOL = 'redact-area'
export const TEXT_TOOL = 'redact-text'
export const FIND_TOOL = 'redact-find'

const MIN_PX = 6

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: { h: Handle; cursor: string; x: number; y: number }[] = [
  { h: 'nw', cursor: 'nwse-resize', x: 0, y: 0 },
  { h: 'n', cursor: 'ns-resize', x: 0.5, y: 0 },
  { h: 'ne', cursor: 'nesw-resize', x: 1, y: 0 },
  { h: 'e', cursor: 'ew-resize', x: 1, y: 0.5 },
  { h: 'se', cursor: 'nwse-resize', x: 1, y: 1 },
  { h: 's', cursor: 'ns-resize', x: 0.5, y: 1 },
  { h: 'sw', cursor: 'nesw-resize', x: 0, y: 1 },
  { h: 'w', cursor: 'ew-resize', x: 0, y: 0.5 }
]

type Box = { left: number; top: number; width: number; height: number }

const pdfRectOfBox = (vp: PageViewport, b: Box): Rect => {
  const [ax, ay] = vp.convertToPdfPoint(b.left, b.top)
  const [bx, by] = vp.convertToPdfPoint(b.left + b.width, b.top + b.height)
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }
}

function applyDrag(mode: Handle | 'move', b: Box, dx: number, dy: number, pageW: number, pageH: number): Box {
  let l = b.left
  let t = b.top
  let r = b.left + b.width
  let bt = b.top + b.height
  if (mode === 'move') {
    const w = b.width
    const h = b.height
    l = Math.min(Math.max(0, l + dx), pageW - w)
    t = Math.min(Math.max(0, t + dy), pageH - h)
    return { left: l, top: t, width: w, height: h }
  }
  if (mode.includes('w')) l = Math.min(l + dx, r - MIN_PX)
  if (mode.includes('e')) r = Math.max(r + dx, l + MIN_PX)
  if (mode.includes('n')) t = Math.min(t + dy, bt - MIN_PX)
  if (mode.includes('s')) bt = Math.max(bt + dy, t + MIN_PX)
  l = Math.max(0, l)
  t = Math.max(0, t)
  r = Math.min(pageW, r)
  bt = Math.min(pageH, bt)
  return { left: l, top: t, width: r - l, height: bt - t }
}

const preview = (t: string | undefined): string => {
  const s = (t ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 40 ? `${s.slice(0, 37)}…` : s
}

export const markLabel = (m: UiMark): string => `${m.kind === 'area' ? 'Area' : 'Text'}${m.text ? `: ${preview(m.text)}` : ''} on page ${m.pageIndex + 1}`

/** The per-page layer: redaction marks (translucent red), pending search hits, and the area tool. */
export function RedactOverlay(props: PageOverlayProps): JSX.Element | null {
  const { docId, pageIndex, scale, width, height, viewport, renderVersion } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const tool = useWorkspace((s) => s.activeTool)
  const d = useDocRedact(docId)
  const marks = useMemo(() => d.marks.filter((m) => m.pageIndex === pageIndex), [d.marks, pageIndex])
  const pending = useMemo(() => d.results.filter((r) => r.pageIndex === pageIndex && r.decision === 'pending'), [d.results, pageIndex])

  useEffect(() => {
    const el = rootRef.current?.closest('.epdf-page') as HTMLElement | null
    if (!el || !viewport) return
    return registerPage(el, { docId, pageIndex, scale, viewport })
  }, [docId, pageIndex, scale, viewport])

  if (!viewport) return <div ref={rootRef} className="absolute inset-0" />
  const selected = marks.find((m) => m.id === d.selectedId && m.kind === 'area' && m.rects.length === 1)

  return (
    <div ref={rootRef} className="absolute inset-0" style={{ width, height }} data-redact-page={pageIndex + 1} data-render={renderVersion}>
      {tool === AREA_TOOL && <DrawLayer docId={docId} pageIndex={pageIndex} viewport={viewport} width={width} height={height} />}
      {pending.map((r) =>
        r.rects.map((rect, i) => {
          const b = toBox(viewport, rect)
          return (
            <div
              key={`${r.id}:${i}`}
              aria-hidden="true"
              data-testid="redact-pending-hit"
              className="pointer-events-none absolute rounded-sm"
              style={{ left: b.left - 1, top: b.top - 1, width: b.width + 2, height: b.height + 2, background: 'rgb(245 158 11 / 0.30)', outline: '2px dashed rgb(180 83 9)', clipPath: r.quads[i] ? quadClip(viewport, r.quads[i]!, b) : undefined }}
            />
          )
        })
      )}
      {marks.map((m) =>
        m.rects.map((rect, i) => {
          const b = toBox(viewport, rect)
          const q = m.quads[i]
          const sel = d.selectedId === m.id
          return (
            <MarkBox key={`${m.id}:${i}`} docId={docId} mark={m} index={i} box={b} viewport={viewport} clip={q ? quadClip(viewport, q, b) : undefined} selected={sel} first={i === 0} />
          )
        })
      )}
      {selected && <AreaEditor key={selected.id} docId={docId} mark={selected} viewport={viewport} width={width} height={height} />}
    </div>
  )
}

function MarkBox({ docId, mark, index, box, viewport, clip, selected, first }: { docId: string; mark: UiMark; index: number; box: Box; viewport: PageViewport; clip?: string; selected: boolean; first: boolean }): JSX.Element {
  const select = useRedact((s) => s.select)
  const move = (dxView: number, dyView: number, resize: boolean): void => {
    if (mark.kind !== 'area' || mark.rects.length !== 1) return
    const next = resize ? { ...box, width: Math.max(MIN_PX, box.width + dxView), height: Math.max(MIN_PX, box.height + dyView) } : { ...box, left: box.left + dxView, top: box.top + dyView }
    useRedact.getState().updateMark(docId, mark.id, { rects: [pdfRectOfBox(viewport, next)], quads: [null] }, `key:${mark.id}`)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Redaction mark. ${markLabel(mark)}${mark.rects.length > 1 ? `, part ${index + 1} of ${mark.rects.length}` : ''}. Delete removes it${mark.kind === 'area' ? '; arrow keys move it, Alt with arrows resizes it' : ''}.`}
      data-testid="redact-mark"
      data-mark-id={mark.id}
      data-first={first}
      className="pointer-events-auto absolute cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        background: 'rgb(220 38 38 / 0.32)',
        outline: `${selected ? 3 : 2}px ${selected ? 'solid' : 'dashed'} rgb(185 28 28)`,
        outlineOffset: 0,
        clipPath: clip
      }}
      onClick={(e) => {
        e.stopPropagation()
        select(docId, mark.id)
      }}
      onFocus={() => select(docId, mark.id)}
      onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          useRedact.getState().removeMark(docId, mark.id)
          useRedact.getState().announce(`Removed a redaction mark on page ${mark.pageIndex + 1}.`)
        } else if (e.key.startsWith('Arrow') && mark.kind === 'area') {
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          const px = step * viewport.scale
          const dx = e.key === 'ArrowLeft' ? -px : e.key === 'ArrowRight' ? px : 0
          const dy = e.key === 'ArrowUp' ? -px : e.key === 'ArrowDown' ? px : 0
          move(dx, dy, e.altKey)
        }
      }}
    />
  )
}

/** Drag on the page to add an area mark. */
function DrawLayer({ docId, pageIndex, viewport, width, height }: { docId: string; pageIndex: number; viewport: PageViewport; width: number; height: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Box | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    const b = ref.current!.getBoundingClientRect()
    return { x: Math.min(Math.max(0, e.clientX - b.left), width), y: Math.min(Math.max(0, e.clientY - b.top), height) }
  }
  const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })

  return (
    <div
      ref={ref}
      data-testid="redact-draw-layer"
      className="pointer-events-auto absolute inset-0"
      style={{ cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        ref.current?.setPointerCapture(e.pointerId)
        start.current = point(e)
        setDrag(rectOf(start.current, start.current))
      }}
      onPointerMove={(e) => {
        if (start.current) setDrag(rectOf(start.current, point(e)))
      }}
      onPointerUp={(e) => {
        const s = start.current
        start.current = null
        setDrag(null)
        if (!s) return
        const b = rectOf(s, point(e))
        if (b.width >= MIN_PX && b.height >= MIN_PX) {
          useRedact.getState().addMark(docId, { kind: 'area', pageIndex, rects: [pdfRectOfBox(viewport, b)], quads: [null] })
          useRedact.getState().announce(`Added an area mark on page ${pageIndex + 1}.`)
        }
      }}
      onPointerCancel={() => {
        start.current = null
        setDrag(null)
      }}
    >
      {drag && <div className="absolute" style={{ ...drag, background: 'rgb(220 38 38 / 0.25)', outline: '2px dashed rgb(185 28 28)' }} />}
    </div>
  )
}

/** Handles to resize and a grip to move the selected area mark with the pointer. */
function AreaEditor({ docId, mark, viewport, width, height }: { docId: string; mark: UiMark; viewport: PageViewport; width: number; height: number }): JSX.Element | null {
  const [drag, setDrag] = useState<Box | null>(null)
  const base = toBox(viewport, mark.rects[0])
  const box = drag ?? base

  const begin = (e: React.PointerEvent, mode: Handle | 'move'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    let latest = base
    setDrag(base)
    const onMove = (ev: PointerEvent): void => {
      latest = applyDrag(mode, base, ev.clientX - sx, ev.clientY - sy, width, height)
      setDrag(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const moved = Math.abs(latest.left - base.left) + Math.abs(latest.top - base.top) + Math.abs(latest.width - base.width) + Math.abs(latest.height - base.height)
      if (moved >= 2) useRedact.getState().updateMark(docId, mark.id, { rects: [pdfRectOfBox(viewport, latest)], quads: [null] })
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} data-testid="redact-area-editor">
      <div className="pointer-events-auto absolute inset-0 cursor-move" onPointerDown={(e) => begin(e, 'move')} aria-hidden="true" />
      {HANDLES.map((h) => (
        <div
          key={h.h}
          aria-hidden="true"
          data-handle={h.h}
          className="pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-white bg-red-700"
          style={{ left: `calc(${h.x * 100}% - 5px)`, top: `calc(${h.y * 100}% - 5px)`, cursor: h.cursor }}
          onPointerDown={(e) => begin(e, h.h)}
        />
      ))}
    </div>
  )
}
