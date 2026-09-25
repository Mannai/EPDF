import type { PageViewport } from 'pdfjs-dist'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditInfo } from '../../edit/session'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { loadPageContent, type PageContentResult } from '../textedit/pageContent'
import type { ImageItem } from '../textedit/pdfcontent/analyze'
import type { Rect } from '../textedit/pdfcontent/matrix'
import { applyImageBox, placeImage, placementFromViewportRect, removeImage } from './actions'
import { useImageEdit, type SelectedImage } from './state'

export const IMAGE_TOOL_ID = 'edit-images'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const HANDLE_CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
const MIN_PX = 8

const toBox = (viewport: PageViewport, r: Rect): Box => {
  const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0)
  const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1)
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

/** A box on the displayed page (CSS pixels) back to a user-space rectangle. */
export const toRect = (viewport: PageViewport, b: Box): Rect => {
  const [ax, ay] = viewport.convertToPdfPoint(b.left, b.top)
  const [bx, by] = viewport.convertToPdfPoint(b.left + b.width, b.top + b.height)
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }
}

export function resizeBox(b0: Box, h: Handle, dx: number, dy: number, keep: boolean): Box {
  let left = b0.left
  let top = b0.top
  let right = b0.left + b0.width
  let bottom = b0.top + b0.height
  if (h.includes('w')) left += dx
  if (h.includes('e')) right += dx
  if (h.includes('n')) top += dy
  if (h.includes('s')) bottom += dy
  if (keep) {
    const ar = b0.width / b0.height
    const w = right - left
    const hh = bottom - top
    if (h.length === 2) {
      const k = Math.max(w / b0.width, hh / b0.height)
      const nw = b0.width * k
      const nh = b0.height * k
      if (h.includes('w')) left = right - nw
      else right = left + nw
      if (h.includes('n')) top = bottom - nh
      else bottom = top + nh
    } else if (h === 'e' || h === 'w') {
      const nh = w / ar
      top = b0.top + (b0.height - nh) / 2
      bottom = top + nh
    } else {
      const nw = hh * ar
      left = b0.left + (b0.width - nw) / 2
      right = left + nw
    }
  }
  if (right - left < MIN_PX) {
    if (h.includes('w')) left = right - MIN_PX
    else right = left + MIN_PX
  }
  if (bottom - top < MIN_PX) {
    if (h.includes('n')) top = bottom - MIN_PX
    else bottom = top + MIN_PX
  }
  return { left, top, width: right - left, height: bottom - top }
}

const rightAngled = (m: readonly number[]): boolean => {
  const eps = 1e-6 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]) + 1)
  return (Math.abs(m[1]) < eps && Math.abs(m[2]) < eps) || (Math.abs(m[0]) < eps && Math.abs(m[3]) < eps)
}

const selectionOf = (docId: string, pageIndex: number, im: ImageItem): SelectedImage => ({
  docId,
  pageIndex,
  id: im.id,
  bbox: im.bbox,
  resizable: rightAngled(im.ctm),
  name: im.kind === 'inline' ? 'Inline image' : `Image ${im.name}`,
  editable: !im.shared
})

/** Outlines the images of every page while the "Edit images" tool is active. */
export function ImageOverlay(props: PageOverlayProps): JSX.Element | null {
  const active = useWorkspace((s) => s.activeTool === IMAGE_TOOL_ID)
  if (!active || !props.viewport) return null
  return <Layer {...props} viewport={props.viewport} />
}

function Layer({ docId, pageIndex, pageNumber, scale, width, height, viewport }: PageOverlayProps & { viewport: PageViewport }): JSX.Element {
  const version = useEditInfo(docId).version
  const selected = useImageEdit((s) => (s.selected && s.selected.docId === docId && s.selected.pageIndex === pageIndex ? s.selected : null))
  const pending = useImageEdit((s) => (s.pending && s.pending.docId === docId ? s.pending : null))
  const busy = useImageEdit((s) => s.busy)
  const centerRequest = useImageEdit((s) => s.centerRequest)
  const currentPage = useTabs((s) => s.tabs.find((t) => t.docId === docId)?.view.page)
  const [loaded, setLoaded] = useState<{ v: number; r: PageContentResult } | null>(null)
  const res = loaded?.r ?? null
  const [live, setLive] = useState<Box | null>(null)
  const [nudge, setNudge] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const nudgeRef = useRef({ x: 0, y: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> })
  const drag = useRef<{ kind: 'move' | Handle; sx: number; sy: number; box: Box } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void loadPageContent(docId, pageIndex).then((r) => {
      if (!cancelled) setLoaded({ v: version, r })
    })
    return () => {
      cancelled = true
    }
  }, [docId, pageIndex, version])

  const images = useMemo(() => (res?.ok ? res.content.analysis.images : []), [res])

  // After an edit the image ids may have shifted: find the selection again by its box.
  useEffect(() => {
    if (!selected || !res?.ok || loaded?.v !== version) return
    const still = images.find((im) => im.id === selected.id)
    if (still) {
      const moved = ['x0', 'y0', 'x1', 'y1'].some((k) => Math.abs(still.bbox[k as keyof Rect] - selected.bbox[k as keyof Rect]) > 0.6)
      if (moved) useImageEdit.getState().select(selectionOf(docId, pageIndex, still))
      return
    }
    const near = images.find((im) => ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(im.bbox[k as keyof Rect] - selected.bbox[k as keyof Rect]) < 1))
    useImageEdit.getState().select(near ? selectionOf(docId, pageIndex, near) : null)
  }, [images, res, loaded, version, selected, docId, pageIndex])

  const flushNudge = (): void => {
    const n = nudgeRef.current
    clearTimeout(n.timer)
    const sel = useImageEdit.getState().selected
    const ux = n.x
    const uy = n.y
    n.x = n.y = 0
    setNudge({ x: 0, y: 0 })
    if (!sel || (ux === 0 && uy === 0)) return
    void applyImageBox(sel, { x0: sel.bbox.x0 + ux, y0: sel.bbox.y0 + uy, x1: sel.bbox.x1 + ux, y1: sel.bbox.y1 + uy })
  }

  const placeAt = (cx: number, cy: number): void => {
    if (!pending) return
    const pageW = width
    const natW = pending.width * 0.75 * scale
    const k = Math.min(1, (0.5 * pageW) / natW, (0.5 * height) / (pending.height * 0.75 * scale))
    const w = natW * k
    const h = pending.height * 0.75 * scale * k
    const x = Math.min(Math.max(0, cx - w / 2), Math.max(0, width - w))
    const y = Math.min(Math.max(0, cy - h / 2), Math.max(0, height - h))
    void placeImage(pending, pageIndex, placementFromViewportRect(viewport, x, y, w, h))
  }

  // "Place at page center" applies to the page being viewed.
  const firstCenter = useRef(centerRequest)
  useEffect(() => {
    if (centerRequest === firstCenter.current) return
    firstCenter.current = centerRequest
    if (pending && currentPage === pageNumber) placeAt(width / 2, height / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerRequest])

  const banner =
    pending
      ? `Click on the page where “${pending.name}” should go, or choose “Place at page center”. Escape cancels.`
      : res && !res.ok
        ? res.message
        : res?.ok && images.length === 0
          ? 'No images on this page. Use “Add image…” to insert one.'
          : null

  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (d.kind === 'move') setLive({ ...d.box, left: d.box.left + dx, top: d.box.top + dy })
    else setLive(resizeBox(d.box, d.kind, dx, dy, e.shiftKey))
  }
  const onUp = (): void => {
    const d = drag.current
    drag.current = null
    const box = live
    setLive(null)
    const sel = useImageEdit.getState().selected
    if (!d || !box || !sel) return
    if (Math.abs(box.left - d.box.left) < 2 && Math.abs(box.top - d.box.top) < 2 && Math.abs(box.width - d.box.width) < 2 && Math.abs(box.height - d.box.height) < 2) return
    void applyImageBox(sel, toRect(viewport, box))
  }

  return (
    <div ref={layerRef} className="absolute inset-0" onPointerMove={onMove} onPointerUp={onUp}>
      <div
        className="pointer-events-auto absolute inset-0"
        data-testid="imageedit-layer"
        style={{ cursor: pending ? 'crosshair' : 'default' }}
        onMouseDown={(e) => {
          if (pending) {
            const r = layerRef.current!.getBoundingClientRect()
            placeAt(e.clientX - r.left, e.clientY - r.top)
          } else {
            useImageEdit.getState().select(null)
          }
        }}
      />
      {!pending &&
        images.map((im, i) => {
          const isSel = selected?.id === im.id
          let b = toBox(viewport, im.bbox)
          if (isSel && live) b = live
          else if (isSel && (nudge.x || nudge.y)) {
            const o = viewport.convertToViewportPoint(im.bbox.x0 + nudge.x, im.bbox.y0 + nudge.y)
            const o0 = viewport.convertToViewportPoint(im.bbox.x0, im.bbox.y0)
            b = { ...b, left: b.left + (o[0] - o0[0]), top: b.top + (o[1] - o0[1]) }
          }
          const label = `${im.kind === 'inline' ? 'Inline image' : `Image ${im.name}`}, ${im.width} by ${im.height} pixels${im.shared ? ' (shared, can’t be changed)' : ''}`
          const resizable = rightAngled(im.ctm) && !im.shared
          return (
            <div key={im.id}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-label={`${label} (${i + 1} of ${images.length})`}
                data-image={im.id}
                className={`pointer-events-auto absolute rounded-sm outline outline-2 focus-visible:outline-4 ${
                  isSel ? 'outline-accent' : 'outline-dashed outline-accent/70 hover:bg-accent/10'
                } ${im.shared ? 'cursor-not-allowed' : 'cursor-move'}`}
                style={{ left: b.left, top: b.top, width: b.width, height: b.height, touchAction: 'none' }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  const sel = selectionOf(docId, pageIndex, im)
                  useImageEdit.getState().select(sel)
                  if (im.shared) {
                    notify('info', 'This image is part of a shared element, so it can’t be changed.')
                    return
                  }
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = { kind: 'move', sx: e.clientX, sy: e.clientY, box: toBox(viewport, im.bbox) }
                }}
                onKeyDown={(e) => {
                  const sel = selectionOf(docId, pageIndex, im)
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    useImageEdit.getState().select(sel)
                  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !im.shared) {
                    e.preventDefault()
                    useImageEdit.getState().select(sel)
                    void removeImage(sel)
                  } else if (e.key.startsWith('Arrow') && !im.shared) {
                    e.preventDefault()
                    if (!isSel) useImageEdit.getState().select(sel)
                    const step = e.shiftKey ? 10 : 1
                    const pxStep = step * scale
                    const c = viewport.convertToViewportPoint(im.bbox.x0, im.bbox.y0)
                    const dxpx = e.key === 'ArrowRight' ? pxStep : e.key === 'ArrowLeft' ? -pxStep : 0
                    const dypx = e.key === 'ArrowDown' ? pxStep : e.key === 'ArrowUp' ? -pxStep : 0
                    const p0 = viewport.convertToPdfPoint(c[0], c[1])
                    const p1 = viewport.convertToPdfPoint(c[0] + dxpx, c[1] + dypx)
                    const n = nudgeRef.current
                    n.x += p1[0] - p0[0]
                    n.y += p1[1] - p0[1]
                    setNudge({ x: n.x, y: n.y })
                    clearTimeout(n.timer)
                    n.timer = setTimeout(flushNudge, 450)
                  }
                }}
              />
              {isSel && resizable && !busy && !pending &&
                HANDLES.map((h) => {
                  const hx = h.includes('w') ? b.left : h.includes('e') ? b.left + b.width : b.left + b.width / 2
                  const hy = h.includes('n') ? b.top : h.includes('s') ? b.top + b.height : b.top + b.height / 2
                  return (
                    <div
                      key={h}
                      aria-hidden="true"
                      data-handle={h}
                      className="pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-accent bg-white"
                      style={{ left: hx - 5, top: hy - 5, cursor: HANDLE_CURSOR[h], touchAction: 'none' }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        drag.current = { kind: h, sx: e.clientX, sy: e.clientY, box: toBox(viewport, im.bbox) }
                      }}
                    />
                  )
                })}
            </div>
          )
        })}
      {banner && (
        <div
          role="status"
          data-testid="imageedit-banner"
          className="pointer-events-none absolute left-1/2 top-3 max-w-[90%] -translate-x-1/2 rounded-md border border-line bg-raised px-3 py-1.5 text-center text-xs text-ink shadow"
        >
          {banner}
        </div>
      )}
    </div>
  )
}

export function cancelPlacement(): void {
  useImageEdit.getState().setPending(null)
}
