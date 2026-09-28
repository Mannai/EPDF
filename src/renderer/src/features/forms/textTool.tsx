import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { errorMessage, notify } from '../../state/notify'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import { createFillMark, createFillText, selectPlaced } from '../markup/actions'
import type { FillMarkKind } from '../markup/pdf/ops'
import { useMarkup } from '../markup/store'
import { KeepToolField } from '../markup/Options'
import { assertDrawable } from './appearance'
import { DEFAULT_TEXT_SIZE, LINE_HEIGHT, dateLabel, type StampKind } from './draw'
import { PageGeometry, geometryOf, normalizeRotation, type Matrix } from './geometry'
import { isolateViewerKeys } from './keys'

/**
 * "Add text" and the stamp tools (check, cross, dot, date) for flat PDFs. Each item is a Fill & sign annotation (one
 * undo step each, see markup/pdf/ops.ts): selectable, movable and changeable until it is locked into the page, which
 * saving offers (fillSignSave.ts).
 */

export interface TextDraft {
  docId: string
  pageIndex: number
  /** Points → CSS px matrix and page rotation of the page the box is on (refreshed while it renders). */
  matrix: Matrix
  rotation: number
  /** The box in points, in the page as the reader sees it (origin top-left, y down). */
  left: number
  top: number
  width: number
  height: number
  text: string
}

interface TextToolState {
  size: number
  color: string
  draft: TextDraft | null
  setSize(n: number): void
  setColor(c: string): void
  setDraft(d: TextDraft | null): void
  patchDraft(p: Partial<TextDraft>): void
}

export const useTextTool = create<TextToolState>((set) => ({
  size: DEFAULT_TEXT_SIZE,
  color: '#000000',
  draft: null,
  setSize: (size) => set({ size: Math.min(144, Math.max(4, Math.round(size) || DEFAULT_TEXT_SIZE)) }),
  setColor: (color) => set({ color }),
  setDraft: (draft) => set({ draft }),
  patchDraft: (p) => set((s) => (s.draft ? { draft: { ...s.draft, ...p } } : s))
}))

const DEFAULT_BOX_WIDTH = 180

/** A box on the displayed page (CSS px) as a PDF user-space rect, for any page rotation. */
function cssBoxToPdf(geom: PageGeometry, left: number, top: number, width: number, height: number): [number, number, number, number] {
  const a = geom.toPdf(left, top)
  const b = geom.toPdf(left + width, top + height)
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
}

let measureCtx: CanvasRenderingContext2D | null | undefined
/** Width of `text` in Helvetica at `size` pt (Arial has the same metrics); a rough estimate for other scripts. */
function textWidthPt(text: string, size: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.6
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`
  return measureCtx.measureText(text).width
}

/**
 * Adds the current text box to the page as a Fill & sign text item (it stays movable and editable until it is locked
 * into the page, which saving offers) and closes the box. Empty text just closes it. The new text is then selected with
 * the Select tool, unless "Keep tool selected" is on. Resolves true when something was added.
 */
export async function commitTextDraft(opts: { select?: boolean } = {}): Promise<boolean> {
  const { draft, size, color } = useTextTool.getState()
  useTextTool.getState().setDraft(null)
  if (!draft || draft.text.trim() === '') return false
  const geom = new PageGeometry(draft.matrix, normalizeRotation(draft.rotation))
  const s = geom.scaleX()
  const rect = cssBoxToPdf(geom, draft.left * s, draft.top * s, draft.width * s, draft.height * s)
  try {
    await assertDrawable(draft.text)
  } catch (err) {
    notify('error', errorMessage(err))
    return false
  }
  const id = await createFillText(draft.docId, draft.pageIndex, rect, draft.text, size, color)
  if (id && opts.select !== false) selectPlaced(draft.docId, id)
  return !!id
}

export const cancelTextDraft = (): void => useTextTool.getState().setDraft(null)

const MARKS: Partial<Record<StampKind, FillMarkKind>> = { check: 'check', cross: 'cross', dot: 'dot' }

/** Check / cross / dot / today's date at a click (CSS px), as a Fill & sign item; then selected for adjusting. */
export async function placeStamp(docId: string, pageIndex: number, geom: PageGeometry, kind: StampKind, cssX: number, cssY: number): Promise<void> {
  const { size, color } = useTextTool.getState()
  const mark = MARKS[kind]
  let id: string | undefined
  if (mark) {
    id = await createFillMark(docId, pageIndex, mark, geom.toPdf(cssX, cssY), size, color)
  } else {
    const label = dateLabel()
    try {
      await assertDrawable(label)
    } catch (err) {
      notify('error', errorMessage(err))
      return
    }
    // A box just big enough for the date, centred on the click (the text box adds a little padding).
    const s = geom.scaleX()
    const w = (textWidthPt(label, size) + size * 0.8 + 6) * s
    const h = size * LINE_HEIGHT * 1.25 * s
    id = await createFillText(docId, pageIndex, cssBoxToPdf(geom, cssX - w / 2, cssY - h / 2, w, h), label, size, color, 'Add date')
  }
  selectPlaced(docId, id)
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48, 72]

/** Size and color controls shown in the ribbon for the text and stamp tools. */
export function TextOptions(): JSX.Element {
  const size = useTextTool((s) => s.size)
  const color = useTextTool((s) => s.color)
  const sizes = SIZES.includes(size) ? SIZES : [...SIZES, size].sort((a, b) => a - b)
  return (
    <>
      <label className="flex items-center gap-1 text-xs">
        Size
        <select className="field h-7 w-16 px-1" value={size} onChange={(e) => useTextTool.getState().setSize(Number(e.target.value))}>
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs">
        Color
        <input type="color" className="h-7 w-9 cursor-pointer rounded border border-line bg-surface p-0.5" value={color} onChange={(e) => useTextTool.getState().setColor(e.target.value)} />
      </label>
      <KeepToolField />
    </>
  )
}

const STAMP_TOOLS: Record<string, StampKind> = {
  'forms.stampCheck': 'check',
  'forms.stampCross': 'cross',
  'forms.stampDot': 'dot',
  'forms.stampDate': 'date'
}

function DraftBox({ docId, pageIndex, viewport, scale }: PageOverlayProps): JSX.Element | null {
  const draft = useTextTool((s) => s.draft)
  const size = useTextTool((s) => s.size)
  const color = useTextTool((s) => s.color)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const drag = useRef<null | { kind: 'move' | 'resize'; x: number; y: number; left: number; top: number; width: number; height: number }>(null)
  const mine = !!draft && draft.docId === docId && draft.pageIndex === pageIndex

  // Keep the box's page geometry current while its page re-renders (zoom changes).
  useEffect(() => {
    if (mine && viewport) {
      const g = geometryOf(viewport)
      useTextTool.getState().patchDraft({ matrix: g.matrix, rotation: g.rotation })
    }
  }, [mine, viewport])

  // Focus the text area when a box is created (not on every move).
  useEffect(() => {
    if (mine) areaRef.current?.focus()
  }, [mine])

  if (!mine || !draft) return null
  const patch = useTextTool.getState().patchDraft

  const onPointerDown = (kind: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.clientX, y: e.clientY, left: draft.left, top: draft.top, width: draft.width, height: draft.height }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale
    const dy = (e.clientY - d.y) / scale
    if (d.kind === 'move') patch({ left: d.left + dx, top: d.top + dy })
    else patch({ width: Math.max(size * 2, d.width + dx), height: Math.max(size * LINE_HEIGHT, d.height + dy) })
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  const nudge = (kind: 'move' | 'resize') => (e: KeyboardEvent<HTMLElement>) => {
    isolateViewerKeys(e)
    const step = e.shiftKey ? 10 : 2
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    if (kind === 'move') patch({ left: draft.left + d[0], top: draft.top + d[1] })
    else patch({ width: Math.max(size * 2, draft.width + d[0]), height: Math.max(size * LINE_HEIGHT, draft.height + d[1]) })
  }

  return (
    <div
      role="group"
      aria-label="Text box"
      className="pointer-events-auto absolute"
      style={{ left: draft.left * scale, top: draft.top * scale, width: draft.width * scale, height: draft.height * scale }}
      data-testid="text-draft"
    >
      <button
        type="button"
        aria-label="Move text box (drag, or use the arrow keys)"
        title="Move"
        className="absolute -top-5 left-0 h-5 w-10 cursor-move rounded-t border border-b-0 border-accent bg-accent text-[10px] leading-none text-accent-ink outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={nudge('move')}
      >
        Move
      </button>
      <textarea
        ref={areaRef}
        aria-label="Text to add to the page"
        className="absolute inset-0 m-0 block resize-none overflow-hidden border-0 bg-white/60 p-0 outline outline-1 outline-dashed outline-accent focus:outline-2"
        style={{ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: size * scale, lineHeight: LINE_HEIGHT, color, colorScheme: 'light', userSelect: 'text' }}
        value={draft.text}
        dir="auto"
        spellCheck={false}
        onChange={(e) => patch({ text: e.target.value })}
        onKeyDown={(e) => {
          isolateViewerKeys(e)
          if (e.key === 'Escape') {
            e.stopPropagation()
            cancelTextDraft()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void commitTextDraft()
          }
        }}
      />
      <button
        type="button"
        aria-label="Resize text box (drag, or use the arrow keys)"
        title="Resize"
        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-accent bg-accent outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        onPointerDown={onPointerDown('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={nudge('resize')}
      />
      <div className="absolute left-0 flex gap-1" style={{ top: draft.height * scale + 8 }}>
        <button type="button" className="btn-primary h-7 px-2 text-xs" onClick={() => void commitTextDraft()}>
          Add to page
        </button>
        <button type="button" className="btn h-7 px-2 text-xs" onClick={cancelTextDraft}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * A see-through copy of the mark a click would stamp, under the pointer: same size, colour and shape as drawStamp
 * (whose offsets are y-up in the reader's frame; y is flipped here).
 */
function StampGhost({ kind, at, scale }: { kind: StampKind; at: [number, number]; scale: number }): JSX.Element {
  const size = useTextTool((s) => s.size)
  const color = useTextTool((s) => s.color)
  const s = size * scale
  const w = Math.max(0.8, size * 0.13) * scale
  const pt = (dx: number, dy: number): string => `${at[0] + dx * s} ${at[1] - dy * s}`
  const common = { stroke: color, strokeWidth: w, strokeLinecap: 'round' as const, fill: 'none' }
  return (
    <svg data-testid="place-ghost" data-ghost={kind} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ opacity: 0.55 }} aria-hidden="true">
      {kind === 'check' && <path d={`M${pt(-0.45, 0.02)} L${pt(-0.12, -0.34)} L${pt(0.5, 0.42)}`} {...common} strokeLinejoin="round" />}
      {kind === 'cross' && <path d={`M${pt(-0.4, -0.4)} L${pt(0.4, 0.4)} M${pt(-0.4, 0.4)} L${pt(0.4, -0.4)}`} {...common} />}
      {kind === 'dot' && <circle cx={at[0]} cy={at[1]} r={Math.max(1.2, size * 0.28) * scale} fill={color} />}
      {kind === 'date' && (
        <text x={at[0]} y={at[1] + 0.3 * s} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontSize={s} fill={color}>
          {dateLabel()}
        </text>
      )}
    </svg>
  )
}

/** The click-to-place layer for the text and stamp tools, plus the text box being edited. */
export function TextToolOverlay(props: PageOverlayProps): JSX.Element | null {
  const tool = useWorkspace((s) => s.activeTool)
  const [hover, setHover] = useState<[number, number] | null>(null)
  const drafting = useTextTool((s) => s.draft !== null)
  useEffect(() => setHover(null), [tool]) // a preview never outlives its tool
  const { docId, pageIndex, viewport, scale } = props
  const isText = tool === 'forms.addText'
  const stamp = tool ? STAMP_TOOLS[tool] : undefined
  if (!viewport || (!isText && !stamp)) return null
  const size = useTextTool.getState().size

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    const geom = geometryOf(viewport)
    if (stamp) {
      void placeStamp(docId, pageIndex, geom, stamp, x, y)
      return
    }
    e.preventDefault()
    const st = useTextTool.getState()
    // A click outside the box being typed confirms it (nothing typed is ever silently dropped). Only with "Keep tool
    // selected" does the same click also start the next box.
    if (st.draft) {
      const keep = useMarkup.getState().keepTool
      void commitTextDraft({ select: !keep })
      if (!keep) return
    }
    const size = st.size
    st.setDraft({
      docId,
      pageIndex,
      matrix: geom.matrix,
      rotation: geom.rotation,
      left: x / scale,
      top: y / scale - (size * LINE_HEIGHT) / 2,
      width: DEFAULT_BOX_WIDTH,
      height: size * LINE_HEIGHT * 2,
      text: ''
    })
  }

  return (
    <>
      <div
        className="pointer-events-auto absolute inset-0"
        style={{ cursor: isText ? 'text' : 'crosshair' }}
        data-testid={isText ? 'add-text-layer' : 'stamp-layer'}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch') return
          const b = e.currentTarget.getBoundingClientRect()
          setHover([e.clientX - b.left, e.clientY - b.top])
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hover && stamp && <StampGhost kind={stamp} at={hover} scale={scale} />}
      {/* Add text: the box a click would open (its left edge at the pointer, centred on its first line). */}
      {hover && isText && !drafting && (
        <div
          data-testid="place-ghost"
          data-ghost="text"
          aria-hidden="true"
          className="pointer-events-none absolute border border-dashed border-accent"
          style={{ left: hover[0], top: hover[1] - (size * LINE_HEIGHT * scale) / 2, width: DEFAULT_BOX_WIDTH * scale, height: size * LINE_HEIGHT * 2 * scale, opacity: 0.8 }}
        />
      )}
      {isText && <DraftBox {...props} />}
    </>
  )
}
