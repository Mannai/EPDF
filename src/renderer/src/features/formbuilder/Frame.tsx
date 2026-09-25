import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

/**
 * A selectable, movable, resizable box laid over a page (a form field or a suggested field). Pointer: drag the
 * box to move it, drag a handle to resize. All coordinates are CSS pixels inside the page. The parent owns the
 * numbers: this component only reports gestures.
 */

export interface CssRect {
  left: number
  top: number
  width: number
  height: number
}

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

const MIN = 6

export function resizeRect(h: Handle, r: CssRect, dx: number, dy: number): CssRect {
  let left = r.left
  let top = r.top
  let right = r.left + r.width
  let bottom = r.top + r.height
  if (h.includes('w')) left = Math.min(left + dx, right - MIN)
  if (h.includes('e')) right = Math.max(right + dx, left + MIN)
  if (h.includes('n')) top = Math.min(top + dy, bottom - MIN)
  if (h.includes('s')) bottom = Math.max(bottom + dy, top + MIN)
  return { left, top, width: right - left, height: bottom - top }
}

export interface FrameProps {
  rect: CssRect
  label: string
  /** Short visible tag (name / kind), shown while selected or hovered. */
  tag?: string
  selected: boolean
  /** Handles and drag are available. */
  interactive: boolean
  resizable: boolean
  dashed?: boolean
  dim?: boolean
  testId?: string
  dataKey: string
  /** Extra classes for the box (colour variants). */
  className?: string
  children?: ReactNode
  /** Pointer went down on the box (select / toggle). Return false to stop a drag from starting. */
  onPress(e: ReactPointerEvent): boolean | void
  /** While dragging: offset from the start in CSS px (null when the gesture ends or is cancelled). */
  onMoveLive(delta: { dx: number; dy: number } | null): void
  onMoveEnd(delta: { dx: number; dy: number }): void
  onResizeLive(box: CssRect | null): void
  onResizeEnd(box: CssRect): void
  onKeyDown(e: KeyboardEvent): void
  onFocus(): void
}

/** Focus survives the reload that follows every edit: the key of the frame the keyboard user is working on. */
let keyboardFocusKey: string | null = null
export const rememberKeyboardFocus = (key: string | null): void => {
  keyboardFocusKey = key
}

export function Frame(p: FrameProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (p.selected && keyboardFocusKey === p.dataKey && ref.current && document.activeElement !== ref.current) {
      const a = document.activeElement
      // Only take the focus from nothing or from another frame (never from a panel control).
      if (!a || a === document.body || a.hasAttribute('data-fb-key')) ref.current.focus({ preventScroll: true })
    }
  })

  const startDrag = (e: ReactPointerEvent, mode: 'move' | Handle): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (p.onPress(e) === false) return
    if (!p.interactive) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const base = p.rect
    let last: { dx: number; dy: number } | null = null
    let lastBox: CssRect | null = null
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (mode === 'move') {
        last = { dx, dy }
        p.onMoveLive(last)
      } else {
        lastBox = resizeRect(mode, base, dx, dy)
        p.onResizeLive(lastBox)
      }
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      p.onMoveLive(null)
      p.onResizeLive(null)
      if (!commit) return
      if (mode === 'move' && last && Math.abs(last.dx) + Math.abs(last.dy) >= 3) p.onMoveEnd(last)
      else if (mode !== 'move' && lastBox) p.onResizeEnd(lastBox)
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const style: CSSProperties = { left: p.rect.left, top: p.rect.top, width: p.rect.width, height: p.rect.height, zIndex: p.selected ? 4 : 3 }
  return (
    <div
      ref={ref}
      role={p.interactive ? 'button' : 'note'}
      tabIndex={p.interactive ? 0 : -1}
      aria-label={p.label}
      aria-pressed={p.interactive ? p.selected : undefined}
      data-fb-key={p.dataKey}
      data-testid={p.testId}
      className={`epdf-fb-frame group absolute ${p.interactive ? 'pointer-events-auto cursor-move' : ''} ${p.selected ? 'epdf-fb-selected' : ''} ${p.dashed ? 'epdf-fb-dashed' : ''} ${p.dim ? 'opacity-60' : ''} ${p.className ?? ''}`}
      style={style}
      onPointerDown={(e) => startDrag(e, 'move')}
      onKeyDown={(e) => {
        if (!p.interactive) return
        rememberKeyboardFocus(p.dataKey)
        p.onKeyDown(e)
      }}
      onFocus={() => {
        // The user moved to another frame: stop restoring the focus of the previous one.
        if (keyboardFocusKey !== p.dataKey) keyboardFocusKey = null
        p.onFocus()
      }}
      onBlur={(e) => {
        // Leaving for another control ends "keyboard focus" tracking; losing it to a reload does not.
        const next = e.relatedTarget as HTMLElement | null
        if (next && next !== document.body) rememberKeyboardFocus(null)
      }}
    >
      {p.children}
      {p.tag && (
        <span aria-hidden="true" className="epdf-fb-tag pointer-events-none absolute -top-[18px] left-[-1px] max-w-[260px] truncate rounded-sm px-1 text-[10px] leading-4">
          {p.tag}
        </span>
      )}
      {p.selected && p.interactive && p.resizable &&
        HANDLES.map((h) => (
          <div
            key={h.h}
            aria-hidden="true"
            data-handle={h.h}
            className="epdf-fb-handle pointer-events-auto absolute h-2.5 w-2.5 rounded-sm"
            style={{ left: `calc(${h.x * 100}% - 5px)`, top: `calc(${h.y * 100}% - 5px)`, cursor: h.cursor }}
            onPointerDown={(e) => startDrag(e, h.h)}
          />
        ))}
    </div>
  )
}
