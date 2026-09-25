import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { geometryOf } from '../forms/geometry'
import { isolateViewerKeys } from '../forms/keys'
import './builder.css'
import { Frame, rememberKeyboardFocus, type CssRect } from './Frame'
import {
  copySelection,
  createKindOf,
  createManual,
  deleteSelection,
  duplicateSelection,
  isBuilderTool,
  moveSelectionBy,
  moveWidgets,
  nudgeSelection,
  pasteClipboard,
  rejectProposals,
  resizeSelection,
  selectionKeys,
  updateProposal,
  visibleProposals
} from './actions'
import { KIND_LABEL, type FieldInfo, type URect } from './logic/spec'
import { NO_KEYS, SELECT_TOOL, splitKey, useBuilder, widgetKey } from './store'
import type { Proposal } from './logic/detect'
import { DETECT_LABEL } from './labels'

/**
 * The page layer of the form builder: frames on existing fields (select / move / resize / nudge), the
 * rubber-band for drawing new fields, the suggested fields of the detection review, and the numbers of the
 * tab-order editor. Frames sit above the form-filling inputs, which are made inert while building (CSS).
 */

const rectStyle = (r: CssRect): React.CSSProperties => ({ left: r.left, top: r.top, width: r.width, height: r.height })

export function BuilderOverlay({ docId, pageIndex, viewport, scale, width, height }: PageOverlayProps): JSX.Element | null {
  const tool = useWorkspace((s) => s.activeTool)
  const doc = useBuilder((s) => s.docs[docId])
  const detect = useBuilder((s) => (s.detect && s.detect.docId === docId ? s.detect : null))
  const taborder = useBuilder((s) => (s.taborder && s.taborder.docId === docId && s.mode === 'taborder' ? s.taborder : null))
  const geom = useMemo(() => (viewport ? geometryOf(viewport) : null), [viewport])
  const editing = isBuilderTool(tool)
  const reviewing = !!detect && detect.phase !== 'running'
  if (!geom || (!editing && !reviewing && !taborder)) return null
  return (
    <div className="absolute inset-0" style={{ width, height }} data-fb-page={pageIndex + 1}>
      {editing && !taborder && doc && <FieldLayer docId={docId} pageIndex={pageIndex} doc={{ fields: doc.fields }} geom={geom} scale={scale} width={width} height={height} tool={tool!} />}
      {editing && !doc && tool && createKindOf(tool) && <FieldLayer docId={docId} pageIndex={pageIndex} doc={{ fields: [] }} geom={geom} scale={scale} width={width} height={height} tool={tool} />}
      {reviewing && detect && <ProposalLayer pageIndex={pageIndex} scale={scale} height={height} />}
      {taborder && doc && <TabBadges pageIndex={pageIndex} fields={doc.fields} keys={taborder.keys} geom={geom} />}
    </div>
  )
}

type Geom = NonNullable<ReturnType<typeof geometryOf>>

// ---------------------------------------------------------------- fields

function FieldLayer({ docId, pageIndex, doc, geom, scale, width, height, tool }: { docId: string; pageIndex: number; doc: { fields: FieldInfo[] }; geom: Geom; scale: number; width: number; height: number; tool: string }): JSX.Element {
  const selection = useBuilder((s) => (s.selectionDoc === docId ? s.selection : NO_KEYS))
  const optimistic = useBuilder((s) => s.optimistic[docId])
  const [live, setLive] = useState<{ dx: number; dy: number } | null>(null)
  const [liveBox, setLiveBox] = useState<{ key: string; box: CssRect } | null>(null)
  const kind = createKindOf(tool)
  const selecting = tool === SELECT_TOOL || !kind

  const items = useMemo(
    () =>
      doc.fields.flatMap((f) =>
        f.widgets.filter((w) => w.pageIndex === pageIndex).map((w) => ({ field: f, widget: w, key: widgetKey(f.name, w.index) }))
      ),
    [doc.fields, pageIndex]
  )

  const cssOf = (r: URect): CssRect => geom.rectToCss({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 })

  const select = (keys: string[]): void => useBuilder.getState().select(docId, keys)

  const onKeyDown = (e: KeyboardEvent, key: string): void => {
    isolateViewerKeys(e)
    const mod = e.ctrlKey || e.metaKey
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (arrows[e.key] && !mod) {
      handled()
      const k = e.shiftKey ? 10 : 1
      const [ux, uy] = arrows[e.key]
      if (e.altKey) void resizeSelection(docId, ux * k, uy * k)
      else void nudgeSelection(docId, ux * k, uy * k)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled()
      void deleteSelection(docId)
    } else if (mod && e.key.toLowerCase() === 'c') {
      handled()
      copySelection(docId)
    } else if (mod && e.key.toLowerCase() === 'v') {
      handled()
      void pasteClipboard(docId, pageIndex)
    } else if (mod && e.key.toLowerCase() === 'd') {
      handled()
      void duplicateSelection(docId)
    } else if (mod && e.key.toLowerCase() === 'a') {
      handled()
      select(items.map((i) => i.key))
    } else if (e.key === ' ' && (mod || e.shiftKey)) {
      handled()
      useBuilder.getState().toggleKey(docId, key)
    } else if (e.key === 'Enter') {
      handled()
      useBuilder.getState().requestNameFocus()
      document.querySelector<HTMLInputElement>('[data-fb-name-input]')?.focus()
    } else if (e.key === 'Escape' && selectionKeys(docId).length > 0) {
      handled()
      select([])
      rememberKeyboardFocus(null)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }

  return (
    <>
      {kind && <CreateLayer docId={docId} pageIndex={pageIndex} geom={geom} scale={scale} width={width} height={height} kind={kind} />}
      {selecting && <BackgroundCatcher docId={docId} items={items.map((i) => ({ key: i.key, css: cssOf(optimistic?.[i.key] ?? i.widget.rect) }))} />}
      {items.map(({ field, widget, key }) => {
        const selected = selection.includes(key)
        const base = cssOf(optimistic?.[key] ?? widget.rect)
        let rect = base
        if (liveBox?.key === key) rect = liveBox.box
        else if (live && selected) rect = { ...base, left: base.left + live.dx, top: base.top + live.dy }
        const many = selection.length > 1
        const label = `${field.tooltip || field.name}, ${KIND_LABEL[field.kind]}${field.kind === 'radio' ? ` button ${widget.value ?? widget.index + 1}` : ''}${field.required ? ', required' : ''}${widget.hidden ? ', hidden' : ''}. Arrow keys move it, Alt with arrows resizes it, Delete removes it.`
        return (
          <Frame
            key={key}
            dataKey={key}
            testId={`fb-field-${field.name}`}
            rect={rect}
            label={label}
            tag={selected ? (many ? `${field.name}` : `${field.name} · ${KIND_LABEL[field.kind]}`) : undefined}
            selected={selected}
            interactive={selecting}
            resizable={selecting && selection.length === 1 && selected}
            dashed={widget.hidden}
            dim={widget.hidden}
            onPress={(e) => {
              if (e.shiftKey || e.ctrlKey || e.metaKey) {
                useBuilder.getState().toggleKey(docId, key)
                return false
              }
              if (!selected) select([key])
            }}
            onMoveLive={setLive}
            onMoveEnd={({ dx, dy }) => void moveSelectionBy(docId, dx / scale, -dy / scale)}
            onResizeLive={(box) => setLiveBox(box ? { key, box } : null)}
            onResizeEnd={(box) => {
              const u = geom.boxToPdf(box)
              void moveWidgets(docId, [{ name: field.name, index: widget.index, rect: { x1: u.x1, y1: u.y1, x2: u.x2, y2: u.y2 } }], `Resize “${field.name}”`)
            }}
            onKeyDown={(e) => onKeyDown(e, key)}
            onFocus={() => {
              if (!selection.includes(key)) select([key])
            }}
          />
        )
      })}
    </>
  )
}

/** Clicking empty page area clears the selection; dragging on it draws a rubber band that selects the fields it touches. */
function BackgroundCatcher({ docId, items }: { docId: string; items: { key: string; css: CssRect }[] }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<CssRect | null>(null)

  const onDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    const box = ref.current!.getBoundingClientRect()
    const x0 = e.clientX - box.left
    const y0 = e.clientY - box.top
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    let moved = false
    let cur: CssRect = { left: x0, top: y0, width: 0, height: 0 }
    const onMove = (ev: PointerEvent): void => {
      const x = ev.clientX - box.left
      const y = ev.clientY - box.top
      moved = moved || Math.abs(x - x0) + Math.abs(y - y0) > 4
      cur = { left: Math.min(x0, x), top: Math.min(y0, y), width: Math.abs(x - x0), height: Math.abs(y - y0) }
      if (moved) setBand(cur)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setBand(null)
      const st = useBuilder.getState()
      if (!moved) {
        if (!additive) st.select(docId, [])
        return
      }
      const hit = items.filter(({ css }) => css.left < cur.left + cur.width && css.left + css.width > cur.left && css.top < cur.top + cur.height && css.top + css.height > cur.top).map((i) => i.key)
      const prev = additive && st.selectionDoc === docId ? st.selection : []
      st.select(docId, [...new Set([...prev, ...hit])])
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div ref={ref} data-testid="fb-select-layer" className="pointer-events-auto absolute inset-0" style={{ zIndex: 2 }} onPointerDown={onDown}>
      {band && <div aria-hidden="true" className="epdf-fb-band absolute" style={rectStyle(band)} />}
    </div>
  )
}

/** Draw a rectangle to create a field; a plain click drops one of the default size. */
function CreateLayer({ docId, pageIndex, geom, scale, width, height, kind }: { docId: string; pageIndex: number; geom: Geom; scale: number; width: number; height: number; kind: NonNullable<ReturnType<typeof createKindOf>> }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<CssRect | null>(null)

  const onDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const box = ref.current!.getBoundingClientRect()
    const x0 = e.clientX - box.left
    const y0 = e.clientY - box.top
    let cur: CssRect = { left: x0, top: y0, width: 0, height: 0 }
    let cancelled = false
    const clampX = (v: number): number => Math.min(width, Math.max(0, v))
    const clampY = (v: number): number => Math.min(height, Math.max(0, v))
    const onMove = (ev: PointerEvent): void => {
      const x = clampX(ev.clientX - box.left)
      const y = clampY(ev.clientY - box.top)
      cur = { left: Math.min(x0, x), top: Math.min(y0, y), width: Math.abs(x - x0), height: Math.abs(y - y0) }
      setBand(cur)
    }
    const onKey = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        cancelled = true
        ev.stopPropagation()
        finish()
      }
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      setBand(null)
    }
    const onUp = (): void => {
      finish()
      if (cancelled) return
      if (cur.width < 8 || cur.height < 8) {
        const [vx, vy] = [x0 / scale, (height - y0) / scale]
        void createManual(docId, kind, pageIndex, { visualCenter: [vx, vy] })
        return
      }
      const u = geom.boxToPdf(cur)
      void createManual(docId, kind, pageIndex, { x1: u.x1, y1: u.y1, x2: u.x2, y2: u.y2 })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  return (
    <div ref={ref} data-testid="fb-create-layer" className="pointer-events-auto absolute inset-0" style={{ zIndex: 5, cursor: 'crosshair' }} onPointerDown={onDown}>
      {band && <div aria-hidden="true" className="epdf-fb-band absolute" style={rectStyle(band)} />}
    </div>
  )
}

// ---------------------------------------------------------------- detection review

function ProposalLayer({ pageIndex, scale, height }: { pageIndex: number; scale: number; height: number }): JSX.Element | null {
  const detect = useBuilder((s) => s.detect)
  const [live, setLive] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [liveBox, setLiveBox] = useState<{ id: string; box: CssRect } | null>(null)
  if (!detect) return null
  const visible = visibleProposals(detect).filter((p) => p.pageIndex === pageIndex)

  const css = (p: Proposal): CssRect => ({ left: p.rect.x0 * scale, top: height - p.rect.y1 * scale, width: (p.rect.x1 - p.rect.x0) * scale, height: (p.rect.y1 - p.rect.y0) * scale })
  const setSelected = (ids: string[]): void => useBuilder.getState().patchDetect({ selected: ids })

  return (
    <>
      {visible.map((p) => {
        const selected = detect.selected.includes(p.id)
        let rect = css(p)
        if (liveBox?.id === p.id) rect = liveBox.box
        else if (live?.id === p.id) rect = { ...rect, left: rect.left + live.dx, top: rect.top + live.dy }
        const tag = `${DETECT_LABEL[p.kind]} ${Math.round(p.confidence * 100)}%`
        const label = `Suggested ${DETECT_LABEL[p.kind].toLowerCase()}${p.label ? ` for “${p.label}”` : ''}, ${Math.round(p.confidence * 100)} percent sure. ${selected ? 'Selected.' : ''} Arrow keys move it, Alt with arrows resizes it, Delete rejects it, Space selects it.`
        const move = (dxPt: number, dyPt: number): void => {
          updateProposal(p.id, {
            rect: { x0: p.rect.x0 + dxPt, x1: p.rect.x1 + dxPt, y0: p.rect.y0 + dyPt, y1: p.rect.y1 + dyPt },
            buttons: p.buttons?.map((b) => ({ ...b, rect: { x0: b.rect.x0 + dxPt, x1: b.rect.x1 + dxPt, y0: b.rect.y0 + dyPt, y1: b.rect.y1 + dyPt } }))
          })
        }
        return (
          <Frame
            key={p.id}
            dataKey={p.id}
            testId={`fb-proposal-${p.id}`}
            rect={rect}
            label={label}
            tag={tag}
            selected={selected}
            interactive
            resizable={p.kind !== 'radio'}
            dashed
            className="epdf-fb-proposal"
            onPress={(e) => {
              if (e.shiftKey || e.ctrlKey || e.metaKey) setSelected(selected ? detect.selected.filter((s) => s !== p.id) : [...detect.selected, p.id])
              else if (!selected) setSelected([p.id])
            }}
            onFocus={() => {
              if (!selected) setSelected([p.id])
            }}
            onMoveLive={(d) => setLive(d ? { id: p.id, ...d } : null)}
            onMoveEnd={({ dx, dy }) => move(dx / scale, -dy / scale)}
            onResizeLive={(box) => setLiveBox(box ? { id: p.id, box } : null)}
            onResizeEnd={(box) =>
              updateProposal(p.id, { rect: { x0: box.left / scale, x1: (box.left + box.width) / scale, y1: (height - box.top) / scale, y0: (height - box.top - box.height) / scale } })
            }
            onKeyDown={(e) => {
              isolateViewerKeys(e)
              const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
              const stop = (): void => {
                e.preventDefault()
                e.stopPropagation()
              }
              if (arrows[e.key]) {
                stop()
                const k = e.shiftKey ? 10 : 1
                const [ux, uy] = arrows[e.key]
                if (e.altKey && p.kind !== 'radio') updateProposal(p.id, { rect: { ...p.rect, x1: Math.max(p.rect.x0 + 4, p.rect.x1 + ux * k), y0: Math.min(p.rect.y1 - 4, p.rect.y0 + uy * k) } })
                else move(ux * k, uy * k)
              } else if (e.key === ' ') {
                stop()
                setSelected(selected ? detect.selected.filter((s) => s !== p.id) : [...detect.selected, p.id])
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                stop()
                rejectProposals([p.id])
              }
            }}
          >
            {p.buttons?.map((b, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="epdf-fb-sub pointer-events-none absolute"
                style={{ left: (b.rect.x0 - p.rect.x0) * scale - 1, top: (p.rect.y1 - b.rect.y1) * scale - 1, width: (b.rect.x1 - b.rect.x0) * scale + 2, height: (b.rect.y1 - b.rect.y0) * scale + 2 }}
              />
            ))}
          </Frame>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- tab order

function TabBadges({ pageIndex, fields, keys, geom }: { pageIndex: number; fields: FieldInfo[]; keys: string[]; geom: Geom }): JSX.Element {
  const byKey = new Map<string, { css: CssRect; name: string }>()
  for (const f of fields) for (const w of f.widgets) if (w.pageIndex === pageIndex) byKey.set(widgetKey(f.name, w.index), { css: geom.rectToCss(w.rect), name: f.name })
  return (
    <>
      {keys.map((k, i) => {
        const e = byKey.get(k)
        if (!e) return null
        return (
          <div key={k} className="epdf-fb-frame epdf-fb-order absolute pointer-events-none" style={{ ...rectStyle(e.css), zIndex: 4 }} data-testid={`fb-order-${splitKey(k).name}`}>
            <span className="epdf-fb-badge absolute -left-2 -top-3 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold" aria-label={`Tab stop ${i + 1}: ${e.name}`}>
              {i + 1}
            </span>
          </div>
        )
      })}
    </>
  )
}
