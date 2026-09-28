import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { createInk, createShape, createStamp, deleteAnnot, deleteAnnotByKey, moveAnnot, resizeAnnot, selectPlaced, type ShapeKind } from './actions'
import { useDocAnnots } from './data'
import { hexToRgb } from './pdf/basics'
import { geomOfViewport, pdfRectToView, viewRectToPdf, viewToPdf, type PageGeom, type Pt, type Rect } from './pdf/geometry'
import { hitTest } from './pdf/hit'
import { smoothStroke } from './pdf/ink'
import { capabilities, describeAnnot, type AnnotInfo } from './pdf/model'
import { registerPage } from './pages'
import { NoteDraftEditor, TextBoxDraftEditor } from './DraftEditors'
import { NoteGhost, StampGhost, TextBoxGhost } from './Ghost'
import { liftRegion, liftedBoxAt, type Lifted } from '../../viewer/lift'
import { CanvasAt } from '../../viewer/LiftedView'
import { TOOL, useMarkup } from './store'
import { openContextMenu, type ContextItem } from '../../components/contextMenu'
import { COMMENTS_PANEL } from './Options'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type DragMode = 'move' | Handle

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

const MIN_SIZE_PX = 12

function applyDrag(mode: DragMode, r: Rect, dx: number, dy: number, keepAspect = false): Rect {
  if (mode === 'move') return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
  if (keepAspect && mode.length === 2) {
    // A corner: the width follows the pointer, the height follows the width; the opposite corner stays put.
    const w0 = Math.max(1, r[2] - r[0])
    const h0 = Math.max(1, r[3] - r[1])
    const w = Math.max(MIN_SIZE_PX, mode.includes('e') ? w0 + dx : w0 - dx)
    const h = (w * h0) / w0
    const left = mode.includes('w') ? r[2] - w : r[0]
    const top = mode.includes('n') ? r[3] - h : r[1]
    return [left, top, left + w, top + h]
  }
  let [l, t, rr, b] = r
  if (mode.includes('w')) l = Math.min(l + dx, rr - MIN_SIZE_PX)
  if (mode.includes('e')) rr = Math.max(rr + dx, l + MIN_SIZE_PX)
  if (mode.includes('n')) t = Math.min(t + dy, b - MIN_SIZE_PX)
  if (mode.includes('s')) b = Math.max(b + dy, t + MIN_SIZE_PX)
  return [l, t, rr, b]
}

const SHAPE_TOOLS: Record<string, ShapeKind> = {
  [TOOL.rect]: 'rect',
  [TOOL.ellipse]: 'ellipse',
  [TOOL.line]: 'line',
  [TOOL.arrow]: 'arrow'
}

type Preview =
  | { kind: 'ink'; pts: Pt[] }
  | { kind: 'shape'; shape: ShapeKind | 'textbox'; a: Pt; b: Pt }

/** The per-page layer: select tool, drawing tools, selection frame and the note/text-box editors. */
export function MarkupOverlay({ docId, pageIndex, scale, width, height, viewport, renderVersion }: PageOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const geom = useMemo<PageGeom | null>(() => (viewport ? geomOfViewport(viewport) : null), [viewport])
  const tool = useWorkspace((s) => s.activeTool)
  const selection = useMarkup((s) => s.selection)
  const draft = useMarkup((s) => s.draft)
  const selectedHere = selection?.docId === docId
  const showFrame = tool === null || tool === TOOL.select
  const data = useDocAnnots(docId, tool === TOOL.select || selectedHere)

  // Let the rest of the feature find this page (text selection → quads, keyboard placement).
  useEffect(() => {
    const el = rootRef.current?.closest('.epdf-page') as HTMLElement | null
    if (!el || !geom) return
    return registerPage(el, { docId, pageIndex, scale, geom })
  }, [docId, pageIndex, scale, geom])

  const annots = data?.annots
  const selected = useMemo(
    () => (selectedHere && annots ? annots.find((a) => a.id === selection!.id && a.pageIndex === pageIndex) : undefined),
    [annots, selectedHere, selection, pageIndex]
  )

  const draftHere = draft && draft.docId === docId && draft.pageIndex === pageIndex ? draft : null

  return (
    <div ref={rootRef} className="absolute inset-0" style={{ width, height }} data-markup-page={pageIndex + 1} data-render={renderVersion}>
      {geom && tool === TOOL.select && <SelectCatcher docId={docId} pageIndex={pageIndex} scale={scale} geom={geom} annots={annots} />}
      {geom && tool && (tool === TOOL.ink || tool === TOOL.textbox || tool === TOOL.note || tool === TOOL.stamp || tool in SHAPE_TOOLS) && (
        <DrawCatcher docId={docId} pageIndex={pageIndex} scale={scale} geom={geom} width={width} height={height} tool={tool} />
      )}
      {geom && showFrame && selected && (
        <SelectionFrame docId={docId} pageIndex={pageIndex} scale={scale} geom={geom} annot={selected} viewport={viewport} renderVersion={renderVersion} rootRef={rootRef} />
      )}
      {geom && draftHere?.kind === 'note' && <NoteDraftEditor draft={draftHere} scale={scale} geom={geom} width={width} height={height} />}
      {geom && draftHere?.kind === 'textbox' && <TextBoxDraftEditor draft={draftHere} scale={scale} geom={geom} />}
    </div>
  )
}

// ---------------------------------------------------------------- select tool

function SelectCatcher({ docId, pageIndex, scale, geom, annots }: { docId: string; pageIndex: number; scale: number; geom: PageGeom; annots: AnnotInfo[] | undefined }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<AnnotInfo | undefined>()
  const select = useMarkup((s) => s.select)

  const hitAt = (e: { clientX: number; clientY: number }): AnnotInfo | undefined => {
    const b = ref.current!.getBoundingClientRect()
    const [x, y] = viewToPdf(geom, (e.clientX - b.left) / scale, (e.clientY - b.top) / scale)
    return hitTest(annots ?? [], pageIndex, [x, y], 4 / scale)
  }

  return (
    <>
      <div
        ref={ref}
        data-testid="markup-select-layer"
        data-ready={annots ? 'true' : 'false'}
        className="pointer-events-auto absolute inset-0"
        style={{ cursor: hover ? 'pointer' : 'default' }}
        onPointerMove={(e) => {
          const h = hitAt(e)
          setHover((cur) => (cur?.id === h?.id ? cur : h))
        }}
        onPointerLeave={() => setHover(undefined)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const h = hitAt(e)
          if (h) {
            select(docId, h.id)
            e.preventDefault()
          } else select(docId, null)
        }}
        onContextMenu={(e) => {
          const h = hitAt(e)
          if (!h) return // empty spot: the page's own menu
          select(docId, h.id)
          void openContextMenu(e, annotationMenu(docId, h))
        }}
      />
      {hover && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-sm outline outline-2 outline-accent/60"
          style={rectStyle(pdfRectToViewPx(geom, hover.rect, scale))}
        />
      )}
    </>
  )
}

/** Right-click on an annotation (with the Select tool): the same actions as its keyboard shortcuts. */
function annotationMenu(docId: string, a: AnnotInfo): ContextItem[] {
  const caps = capabilities(a)
  return [
    {
      label: 'Edit text',
      keys: 'Enter',
      enabled: caps.text,
      run: () => {
        useMarkup.getState().select(docId, a.id)
        useMarkup.getState().requestFocusText()
      }
    },
    { label: 'Show in Comments panel', run: () => useWorkspace.getState().setRightPanel(COMMENTS_PANEL) },
    { type: 'separator' },
    { label: 'Delete', keys: 'Delete', run: () => void deleteAnnot(docId, a) }
  ]
}

const pdfRectToViewPx = (g: PageGeom, r: Rect, scale: number): Rect => pdfRectToView(g, r).map((v) => v * scale) as Rect
const rectStyle = (r: Rect): React.CSSProperties => ({ left: r[0], top: r[1], width: r[2] - r[0], height: r[3] - r[1] })

// ---------------------------------------------------------------- selection frame

function SelectionFrame({
  docId,
  pageIndex,
  scale,
  geom,
  annot,
  viewport,
  renderVersion,
  rootRef
}: {
  docId: string
  pageIndex: number
  scale: number
  geom: PageGeom
  annot: AnnotInfo
  viewport: PageOverlayProps['viewport']
  renderVersion: number
  rootRef: React.RefObject<HTMLDivElement | null>
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const caps = capabilities(annot)
  // Stamps and signatures keep their proportions: only the corner handles, and they scale both ways.
  const keepAspect = annot.subtype === 'Stamp'
  const [drag, setDrag] = useState<{ cur: Rect; done: boolean } | null>(null)
  // The annotation itself, lifted off the page so it follows the pointer (not just an outline), and kept where it was
  // dropped until the redrawn page arrives: `landed` is the render version at the drop.
  const [lift, setLift] = useState<{ lifted: Lifted; from: Rect; at: Rect; landed: number | null } | null>(null)
  const dragging = useRef(false)
  const renderRef = useRef(renderVersion)
  renderRef.current = renderVersion
  const reveal = useMarkup((s) => s.reveal)
  const base = pdfRectToViewPx(geom, annot.rect, scale)
  const rect = drag?.cur ?? base

  // The document reloaded after a committed move/resize: drop the temporary rect.
  useEffect(() => {
    setDrag((d) => (d?.done ? null : d))
  }, [annot])

  // The page has been redrawn since the drop: the real annotation is in its new place now.
  useEffect(() => {
    setLift((l) => (l && l.landed !== null && renderVersion !== l.landed ? null : l))
  }, [renderVersion])

  useEffect(() => {
    if (!reveal || reveal.id !== annot.id) return
    ref.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
    useMarkup.getState().consumeReveal()
  }, [reveal, annot.id])

  const commit = async (mode: DragMode, from: Rect, to: Rect): Promise<boolean> => {
    if (mode === 'move') {
      const [ax, ay] = viewToPdf(geom, from[0] / scale, from[1] / scale)
      const [bx, by] = viewToPdf(geom, to[0] / scale, to[1] / scale)
      return moveAnnot(docId, annot.id, bx - ax, by - ay)
    }
    return resizeAnnot(docId, annot.id, viewRectToPdf(geom, to.map((v) => v / scale) as Rect))
  }

  const beginDrag = (e: React.PointerEvent, mode: DragMode): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ref.current?.focus({ preventScroll: true })
    const sx = e.clientX
    const sy = e.clientY
    const from = base
    let latest = from
    let clicked = false // released without moving
    let landedAt: number | null = null // render version when it was dropped
    dragging.current = true
    setDrag({ cur: from, done: false })
    const pageEl = rootRef.current?.closest('.epdf-page') as HTMLElement | null
    if (pageEl && viewport) {
      void liftRegion({ pageEl, docId, pageIndex, viewport, rect: from, mode: 'annotation' }).then((lifted) => {
        // Too late to help: a click without a move, or the page was already redrawn after the drop.
        if (!lifted || clicked || (landedAt !== null && renderRef.current !== landedAt)) return
        setLift((l) => l ?? { lifted, from, at: latest, landed: landedAt })
      })
    }
    const onMove = (ev: PointerEvent): void => {
      latest = applyDrag(mode, from, ev.clientX - sx, ev.clientY - sy, keepAspect)
      setDrag({ cur: latest, done: false })
      setLift((l) => (l ? { ...l, at: latest } : l))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const moved = Math.abs(latest[0] - from[0]) + Math.abs(latest[1] - from[1]) + Math.abs(latest[2] - from[2]) + Math.abs(latest[3] - from[3])
      if (moved < 3) {
        clicked = true
        dragging.current = false
        setLift(null)
        return setDrag(null)
      }
      landedAt = renderRef.current
      setDrag({ cur: latest, done: true })
      setLift((l) => (l ? { ...l, at: latest, landed: landedAt } : l))
      void commit(mode, from, latest).then((ok) => {
        dragging.current = false
        if (!ok) {
          setDrag(null)
          setLift(null)
        }
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /** Arrow keys nudge by 1pt (10pt with Shift); Alt+arrows resize; Delete removes; Enter edits the text. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (arrows[e.key]) {
      e.preventDefault()
      e.stopPropagation()
      const k = e.shiftKey ? 10 : 1
      const [ux, uy] = arrows[e.key]
      if (e.altKey) {
        if (!caps.resize) return
        const next = pdfRectToView(geom, annot.rect)
        next[2] = Math.max(next[0] + 4, next[2] + ux * k)
        next[3] = Math.max(next[1] + 4, next[3] + uy * k)
        void resizeAnnot(docId, annot.id, viewRectToPdf(geom, next))
      } else {
        const [ax, ay] = viewToPdf(geom, 0, 0)
        const [bx, by] = viewToPdf(geom, ux * k, uy * k)
        void moveAnnot(docId, annot.id, bx - ax, by - ay)
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      void deleteAnnotByKey(docId, annot)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      useMarkup.getState().requestFocusText()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      useMarkup.getState().select(docId, null)
    }
  }

  const label = `${describeAnnot(annot)} by ${annot.author || 'unknown author'}${annot.contents ? `: ${annot.contents.slice(0, 60)}` : ''}`

  return (
    <>
      {lift?.lifted.eraser && <CanvasAt canvas={lift.lifted.eraser} box={lift.lifted.box} testId="lift-eraser" />}
      {lift && <CanvasAt canvas={lift.lifted.image} box={liftedBoxAt(lift.lifted, lift.from, lift.at)} testId="lift-image" />}
    <div
      ref={ref}
      role="group"
      tabIndex={0}
      aria-label={`Selected ${label}. Arrow keys move it, Delete removes it, Enter edits its text.`}
      data-markup-frame={annot.id}
      data-testid="markup-frame"
      className="pointer-events-auto absolute cursor-move rounded-sm outline outline-2 outline-offset-2 outline-accent focus-visible:outline-4"
      style={rectStyle(rect)}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => void openContextMenu(e, annotationMenu(docId, annot))}
    >
      {caps.resize &&
        HANDLES.filter((h) => !keepAspect || h.h.length === 2).map((h) => (
          <div
            key={h.h}
            aria-hidden="true"
            data-handle={h.h}
            className="pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-accent-ink bg-accent"
            style={{ left: `calc(${h.x * 100}% - 5px)`, top: `calc(${h.y * 100}% - 5px)`, cursor: h.cursor }}
            onPointerDown={(e) => beginDrag(e, h.h)}
          />
        ))}
    </div>
    </>
  )
}

// ---------------------------------------------------------------- drawing tools

function DrawCatcher({ docId, pageIndex, scale, geom, width, height, tool }: { docId: string; pageIndex: number; scale: number; geom: PageGeom; width: number; height: number; tool: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  // Where the pointer is while no button is down: stamps, notes and text boxes preview there before the click.
  const [hover, setHover] = useState<Pt | null>(null)
  const opts = useMarkup((s) => s.options)
  const shape = SHAPE_TOOLS[tool]
  const start = useRef<Pt | null>(null)
  const clickToPlace = tool === TOOL.stamp || tool === TOOL.note || tool === TOOL.textbox
  // While a note or text box is being typed, the next click finishes it rather than placing another: no preview.
  const draftOpen = useMarkup((s) => s.draft !== null)

  const pos = (e: React.PointerEvent | PointerEvent): Pt => {
    const b = ref.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }
  const toPdf = (p: Pt): Pt => viewToPdf(geom, p[0] / scale, p[1] / scale)

  const onDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    ref.current!.setPointerCapture(e.pointerId)
    const p = pos(e)
    start.current = p
    setHover(null)
    if (tool === TOOL.ink) setPreview({ kind: 'ink', pts: [p] })
    else if (shape) setPreview({ kind: 'shape', shape, a: p, b: p })
    else if (tool === TOOL.textbox) setPreview({ kind: 'shape', shape: 'textbox', a: p, b: p })
  }

  const onMove = (e: React.PointerEvent): void => {
    if (!start.current) {
      if (clickToPlace && e.pointerType !== 'touch') setHover(pos(e))
      return
    }
    if (tool === TOOL.ink) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? []
      const pts = (events.length ? events : [e.nativeEvent]).map((ev) => pos(ev))
      setPreview((pv) => (pv?.kind === 'ink' ? { kind: 'ink', pts: [...pv.pts, ...pts] } : pv))
    } else {
      const p = pos(e)
      setPreview((pv) => (pv?.kind === 'shape' ? { ...pv, b: p } : pv))
    }
  }

  const onUp = (e: React.PointerEvent): void => {
    const s = start.current
    start.current = null
    const pv = preview
    setPreview(null)
    if (!s) return
    const p = pos(e)
    if (tool === TOOL.ink && pv?.kind === 'ink') {
      const stroke = smoothStroke(pv.pts.map(toPdf), opts.ink.smoothing)
      if (stroke.length >= 2) void createInk(docId, pageIndex, [stroke])
    } else if (shape) {
      if (Math.hypot(p[0] - s[0], p[1] - s[1]) < 4) return // a click without a drag draws nothing
      void createShape(docId, pageIndex, shape, toPdf(s), toPdf(p)).then((id) => selectPlaced(docId, id))
    } else if (tool === TOOL.textbox) {
      const small = Math.abs(p[0] - s[0]) < 20 || Math.abs(p[1] - s[1]) < 14
      const view: Rect = small
        ? [s[0], s[1], s[0] + 200 * scale, s[1] + 48 * scale]
        : [Math.min(s[0], p[0]), Math.min(s[1], p[1]), Math.max(s[0], p[0]), Math.max(s[1], p[1])]
      useMarkup.getState().setDraft({ kind: 'textbox', docId, pageIndex, rect: viewRectToPdf(geom, view.map((v) => v / scale) as Rect) })
    } else if (tool === TOOL.note) {
      useMarkup.getState().setDraft({ kind: 'note', docId, pageIndex, at: toPdf(p) })
    } else if (tool === TOOL.stamp) {
      void createStamp(docId, pageIndex, toPdf(p)).then((id) => selectPlaced(docId, id))
    }
  }

  const cancel = (): void => {
    start.current = null
    setPreview(null)
  }

  return (
    <div
      ref={ref}
      data-testid="markup-draw-layer"
      data-tool={tool}
      className="pointer-events-auto absolute inset-0 touch-none"
      style={{ cursor: tool === TOOL.stamp || tool === TOOL.note ? 'copy' : 'crosshair', width, height }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={cancel}
      onPointerLeave={() => setHover(null)}
    >
      {preview && <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">{renderPreview(preview, opts, scale)}</svg>}
      {hover && !preview && tool === TOOL.stamp && <StampGhost at={hover} scale={scale} pageW={width} pageH={height} />}
      {hover && !preview && tool === TOOL.note && !draftOpen && <NoteGhost at={hover} scale={scale} pageW={width} pageH={height} />}
      {hover && !preview && tool === TOOL.textbox && !draftOpen && <TextBoxGhost at={hover} scale={scale} />}
    </div>
  )
}

function renderPreview(pv: Preview, o: ReturnType<typeof useMarkup.getState>['options'], scale: number): JSX.Element {
  const css = (hex: string): string => {
    const [r, g, b] = hexToRgb(hex)
    return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
  }
  if (pv.kind === 'ink') {
    return (
      <polyline
        points={pv.pts.map((p) => p.join(',')).join(' ')}
        fill="none"
        stroke={css(o.ink.color)}
        strokeOpacity={o.ink.opacity}
        strokeWidth={o.ink.width * scale}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  }
  const { a, b } = pv
  if (pv.shape === 'textbox') {
    return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} fill="none" stroke="currentColor" strokeDasharray="4 3" className="text-accent" />
  }
  const s = o.shape
  const common = {
    stroke: css(s.color),
    strokeOpacity: s.opacity,
    strokeWidth: s.width * scale,
    strokeDasharray: s.dashed ? `${s.width * scale * 3} ${s.width * scale * 2}` : undefined,
    fill: s.fill && (pv.shape === 'rect' || pv.shape === 'ellipse') ? css(s.fill) : 'none',
    fillOpacity: s.opacity
  }
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  const w = Math.abs(b[0] - a[0])
  const h = Math.abs(b[1] - a[1])
  if (pv.shape === 'rect') return <rect x={x} y={y} width={w} height={h} {...common} />
  if (pv.shape === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
  return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} strokeLinecap="round" markerEnd={undefined} />
}
