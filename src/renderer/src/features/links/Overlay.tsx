import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { geomOfViewport, pdfRectToView, viewRectToPdf, viewToPdf, type PageGeom, type Rect } from '../markup/pdf/geometry'
import { quadsBounds } from '../markup/pdf/quads'
import { deleteLinkAction, moveLinkAction, resizeLinkAction, styleOfBorder } from './actions'
import { useDocLinks } from './data'
import { hitLink, viewRectToLinkRect } from './pdf/geometry'
import { describeTarget, type LinkInfo } from './pdf/model'
import { registerPage } from './pages'
import { LINK_TOOL, defaultForm, useLinkUi, type LinkForm } from './store'

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

const MIN_SIZE_PX = 10

function applyDrag(mode: DragMode, r: Rect, dx: number, dy: number): Rect {
  if (mode === 'move') return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
  let [l, t, rr, b] = r
  if (mode.includes('w')) l = Math.min(l + dx, rr - MIN_SIZE_PX)
  if (mode.includes('e')) rr = Math.max(rr + dx, l + MIN_SIZE_PX)
  if (mode.includes('n')) t = Math.min(t + dy, b - MIN_SIZE_PX)
  if (mode.includes('s')) b = Math.max(b + dy, t + MIN_SIZE_PX)
  return [l, t, rr, b]
}

const rectStyle = (r: Rect): React.CSSProperties => ({ left: r[0], top: r[1], width: r[2] - r[0], height: r[3] - r[1] })
const toPx = (g: PageGeom, r: Rect, scale: number): Rect => pdfRectToView(g, r).map((v) => v * scale) as Rect

/** The form a fresh link starts from: the tool's default appearance and the current page as the target. */
export function newLinkForm(pageIndex: number, over: Partial<LinkForm> = {}): LinkForm {
  const ui = useLinkUi.getState()
  return { ...defaultForm(), page: pageIndex + 1, border: ui.newBorder, color: ui.newColor, ...over }
}

/** The per-page layer of the links feature: link outlines, the Add link and Edit links tools, target picking. */
export function LinksOverlay({ docId, pageIndex, scale, width, height, viewport, renderVersion }: PageOverlayProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const geom = useMemo<PageGeom | null>(() => (viewport ? geomOfViewport(viewport) : null), [viewport])
  const tool = useWorkspace((s) => s.activeTool)
  const highlight = useLinkUi((s) => s.highlight)
  const picking = useLinkUi((s) => s.picking)
  const selection = useLinkUi((s) => s.selection)
  const isAdd = tool === LINK_TOOL.add
  const isEdit = tool === LINK_TOOL.edit
  const showOutlines = highlight || isAdd || isEdit
  const data = useDocLinks(docId, showOutlines || (selection?.docId === docId))

  useEffect(() => {
    const el = rootRef.current?.closest('.epdf-page') as HTMLElement | null
    if (!el || !geom) return
    return registerPage(el, { docId, pageIndex, scale, geom })
  }, [docId, pageIndex, scale, geom])

  const links = useMemo(() => (data?.links ?? []).filter((l) => l.pageIndex === pageIndex), [data, pageIndex])
  const selected = selection?.docId === docId && isEdit ? links.find((l) => l.id === selection.id) : undefined

  return (
    <div ref={rootRef} className="absolute inset-0" style={{ width, height }} data-links-page={pageIndex + 1} data-render={renderVersion}>
      {geom && showOutlines && <Outlines links={links} geom={geom} scale={scale} selectedId={selected?.id} />}
      {geom && isAdd && !picking && <AddCatcher docId={docId} pageIndex={pageIndex} scale={scale} geom={geom} width={width} height={height} />}
      {geom && isEdit && !picking && <EditCatcher docId={docId} pageIndex={pageIndex} scale={scale} geom={geom} links={links} ready={!!data} />}
      {geom && selected && !picking && <Frame docId={docId} scale={scale} geom={geom} link={selected} />}
      {picking && <PickCatcher pageIndex={pageIndex} width={width} height={height} />}
    </div>
  )
}

// ---------------------------------------------------------------- outlines

function Outlines({ links, geom, scale, selectedId }: { links: LinkInfo[]; geom: PageGeom; scale: number; selectedId?: string }): JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0" data-testid="link-outlines">
      {links.map((l) => {
        const boxes: Rect[] = l.quads.length ? l.quads.map((q) => quadsBounds([q])!) : [l.rect]
        return boxes.map((b, i) => (
          <div
            key={`${l.id}:${i}`}
            data-link-outline={l.id}
            className={`absolute bg-accent/10 ${l.target.kind === 'uri' ? 'outline outline-2 outline-accent' : 'outline outline-2 outline-dashed outline-accent'} ${l.id === selectedId ? 'opacity-0' : ''}`}
            style={rectStyle(toPx(geom, b, scale))}
          />
        ))
      })}
    </div>
  )
}

// ---------------------------------------------------------------- Add link: draw a rectangle

function AddCatcher({ docId, pageIndex, scale, geom, width, height }: { docId: string; pageIndex: number; scale: number; geom: PageGeom; width: number; height: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<[number, number] | null>(null)
  const [preview, setPreview] = useState<Rect | null>(null)

  const pos = (e: React.PointerEvent): [number, number] => {
    const b = ref.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }
  const open = (view: Rect): void => {
    const rect = viewRectToLinkRect(geom, view.map((v) => v / scale) as Rect)
    useLinkUi.getState().openDialog({ mode: 'create', docId, regions: [{ pageIndex, rect, quads: [] }] }, newLinkForm(pageIndex))
  }

  return (
    <div
      ref={ref}
      data-testid="links-draw-layer"
      className="pointer-events-auto absolute inset-0 touch-none"
      style={{ cursor: 'crosshair', width, height }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        ref.current!.setPointerCapture(e.pointerId)
        start.current = pos(e)
        setPreview(null)
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const p = pos(e)
        setPreview([Math.min(s[0], p[0]), Math.min(s[1], p[1]), Math.max(s[0], p[0]), Math.max(s[1], p[1])])
      }}
      onPointerUp={(e) => {
        const s = start.current
        start.current = null
        setPreview(null)
        if (!s) return
        const p = pos(e)
        if (Math.hypot(p[0] - s[0], p[1] - s[1]) < 6) {
          // A plain click makes a default-sized link box at that spot.
          open([s[0], s[1], s[0] + 120 * scale, s[1] + 20 * scale])
        } else open([Math.min(s[0], p[0]), Math.min(s[1], p[1]), Math.max(s[0], p[0]), Math.max(s[1], p[1])])
      }}
      onPointerCancel={() => {
        start.current = null
        setPreview(null)
      }}
    >
      {preview && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/15" style={rectStyle(preview)} />}
    </div>
  )
}

// ---------------------------------------------------------------- Edit links: select

function EditCatcher({ docId, pageIndex, scale, geom, links, ready }: { docId: string; pageIndex: number; scale: number; geom: PageGeom; links: LinkInfo[]; ready: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<LinkInfo | undefined>()
  const hitAt = (e: React.PointerEvent): LinkInfo | undefined => {
    const b = ref.current!.getBoundingClientRect()
    const [x, y] = viewToPdf(geom, (e.clientX - b.left) / scale, (e.clientY - b.top) / scale)
    return hitLink(links, pageIndex, x, y, 3 / scale)
  }
  return (
    <div
      ref={ref}
      data-testid="links-select-layer"
      data-ready={ready}
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
        useLinkUi.getState().select(docId, h?.id ?? null)
        if (h) e.preventDefault()
      }}
      onDoubleClick={(e) => {
        const h = hitAt(e as unknown as React.PointerEvent)
        if (h) openEdit(docId, h)
      }}
    >
      {hover && <div aria-hidden="true" className="pointer-events-none absolute outline outline-2 outline-offset-1 outline-accent" style={rectStyle(toPx(geom, hover.rect, scale))} />}
    </div>
  )
}

export function formFromLink(l: LinkInfo): LinkForm {
  const { style, color } = styleOfBorder(l.border)
  const base: LinkForm = { ...defaultForm(), border: style, color, contents: l.contents }
  const t = l.target
  if (t.kind === 'uri') return { ...base, kind: 'uri', uri: t.uri }
  if (t.kind === 'page') return { ...base, kind: t.named ? 'named' : 'page', named: t.named ?? '', page: t.dest.pageIndex + 1, view: 'keep' }
  return base
}

export function openEdit(docId: string, link: LinkInfo): void {
  useLinkUi.getState().openDialog({ mode: 'edit', docId, link }, formFromLink(link))
}

// ---------------------------------------------------------------- selection frame

function Frame({ docId, scale, geom, link }: { docId: string; scale: number; geom: PageGeom; link: LinkInfo }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ cur: Rect; done: boolean } | null>(null)
  const base = toPx(geom, link.quads.length ? (quadsBounds(link.quads) ?? link.rect) : link.rect, scale)
  const rect = drag?.cur ?? base

  // The document reloaded after a committed move/resize: drop the temporary rect.
  useEffect(() => {
    setDrag((d) => (d?.done ? null : d))
  }, [link])

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [link.id])

  const commit = async (mode: DragMode, from: Rect, to: Rect): Promise<boolean> => {
    if (mode === 'move') {
      const [ax, ay] = viewToPdf(geom, from[0] / scale, from[1] / scale)
      const [bx, by] = viewToPdf(geom, to[0] / scale, to[1] / scale)
      return moveLinkAction(docId, link.id, bx - ax, by - ay)
    }
    return resizeLinkAction(docId, link.id, viewRectToPdf(geom, to.map((v) => v / scale) as Rect))
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
    setDrag({ cur: from, done: false })
    const onMove = (ev: PointerEvent): void => {
      latest = applyDrag(mode, from, ev.clientX - sx, ev.clientY - sy)
      setDrag({ cur: latest, done: false })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const moved = Math.abs(latest[0] - from[0]) + Math.abs(latest[1] - from[1]) + Math.abs(latest[2] - from[2]) + Math.abs(latest[3] - from[3])
      if (moved < 3) return setDrag(null)
      setDrag({ cur: latest, done: true })
      void commit(mode, from, latest).then((ok) => {
        if (!ok) setDrag(null)
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /** Arrows nudge by 1 pt (10 pt with Shift); Alt+arrows resize; Enter edits the target; Delete removes; Escape deselects. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (arrows[e.key]) {
      e.preventDefault()
      e.stopPropagation()
      const k = e.shiftKey ? 10 : 1
      const [ux, uy] = arrows[e.key]
      if (e.altKey) {
        const next = pdfRectToView(geom, link.rect)
        next[2] = Math.max(next[0] + 4, next[2] + ux * k)
        next[3] = Math.max(next[1] + 4, next[3] + uy * k)
        void resizeLinkAction(docId, link.id, viewRectToPdf(geom, next))
      } else {
        const [ax, ay] = viewToPdf(geom, 0, 0)
        const [bx, by] = viewToPdf(geom, ux * k, uy * k)
        void moveLinkAction(docId, link.id, bx - ax, by - ay)
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      void deleteLinkAction(docId, link.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      openEdit(docId, link)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      useLinkUi.getState().select(docId, null)
    }
  }

  return (
    <div
      ref={ref}
      role="group"
      tabIndex={0}
      aria-label={`Selected link: ${describeTarget(link.target)}. Arrow keys move it, Alt with arrows resizes it, Enter edits it, Delete removes it.`}
      data-link-frame={link.id}
      data-testid="link-frame"
      className="pointer-events-auto absolute cursor-move rounded-sm outline outline-2 outline-offset-2 outline-accent focus-visible:outline-4"
      style={rectStyle(rect)}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onKeyDown={onKeyDown}
    >
      {HANDLES.map((h) => (
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
  )
}

// ---------------------------------------------------------------- pick a target position

function PickCatcher({ pageIndex, width, height }: { pageIndex: number; width: number; height: number }): JSX.Element {
  return (
    <div
      data-testid="links-pick-layer"
      data-pick-page={pageIndex + 1}
      className="pointer-events-auto absolute inset-0"
      style={{ cursor: 'crosshair', width, height }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const b = e.currentTarget.getBoundingClientRect()
        const fx = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width))
        const fy = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))
        useLinkUi.getState().patchForm({ page: pageIndex + 1, pos: { fx, fy }, view: 'position' })
        useLinkUi.getState().setPicking(false)
      }}
    />
  )
}
