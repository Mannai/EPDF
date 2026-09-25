/**
 * Pure selection / reordering algorithms for the page organizer. Everything here works on 0-based page
 * indices and plain arrays so it can be unit-tested without a DOM or a PDF library.
 */

/** What a page of the edited document is made of. `orig` pages keep their identity (annotations, links...). */
export type PageSpec =
  | { kind: 'orig'; index: number; rotate?: number }
  /** A blank page. Give either an explicit size in points or `like` (the displayed size of an original page). */
  | { kind: 'blank'; width?: number; height?: number; like?: number }
  /** A page copied from the source PDF handed to the edit (`insert from another PDF`). */
  | { kind: 'ext'; index: number }

export interface PagePlan {
  specs: PageSpec[]
  /** Positions (in the resulting document) that should be selected afterwards. */
  selection: number[]
}

export interface Selection {
  selected: number[]
  /** Where a Shift+click range starts. */
  anchor: number | null
  /** Keyboard focus. */
  focus: number
}

export const EMPTY_SELECTION: Selection = { selected: [], anchor: null, focus: 0 }

const uniqSorted = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

export interface Mods {
  ctrl?: boolean
  shift?: boolean
}

/** Result of clicking (or Space/Enter on) page `index`. Plain click selects only it; Ctrl toggles; Shift extends from the anchor. */
export function clickSelect(sel: Selection, index: number, mods: Mods, count: number): Selection {
  if (index < 0 || index >= count) return sel
  if (mods.shift && sel.anchor !== null) {
    const a = clamp(sel.anchor, 0, count - 1)
    const lo = Math.min(a, index)
    const hi = Math.max(a, index)
    // Ctrl+Shift adds the range to what is selected; plain Shift replaces it.
    const base = mods.ctrl ? sel.selected : []
    return { selected: uniqSorted([...base, ...range(lo, hi)]), anchor: sel.anchor, focus: index }
  }
  if (mods.ctrl) {
    const has = sel.selected.includes(index)
    const selected = has ? sel.selected.filter((i) => i !== index) : uniqSorted([...sel.selected, index])
    return { selected, anchor: index, focus: index }
  }
  return { selected: [index], anchor: index, focus: index }
}

export const selectAll = (count: number, focus = 0): Selection => ({
  selected: range(0, count - 1),
  anchor: count ? 0 : null,
  focus: clamp(focus, 0, Math.max(0, count - 1))
})

/** Keeps a selection valid after the page count changed. */
export function clampSelection(sel: Selection, count: number): Selection {
  return {
    selected: sel.selected.filter((i) => i >= 0 && i < count),
    anchor: sel.anchor !== null && sel.anchor < count ? sel.anchor : null,
    focus: clamp(sel.focus, 0, Math.max(0, count - 1))
  }
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown'

/**
 * Grid navigation: the index that keyboard focus moves to. Left/Right move by one page, Up/Down by a row
 * (staying put when there is no page in that direction), Home/End jump to the first/last page of the row,
 * and PageUp/PageDown move `pageRows` rows.
 */
export function navigate(index: number, key: NavKey, cols: number, count: number, pageRows = 3, ctrl = false): number {
  if (count === 0) return 0
  const c = Math.max(1, cols)
  const row = Math.floor(index / c)
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowRight':
      return Math.min(count - 1, index + 1)
    case 'ArrowUp':
      return index - c >= 0 ? index - c : index
    case 'ArrowDown':
      return index + c < count ? index + c : index
    case 'Home':
      return ctrl ? 0 : row * c
    case 'End':
      return ctrl ? count - 1 : Math.min(count - 1, row * c + c - 1)
    case 'PageUp':
      return Math.max(0, index - c * pageRows)
    case 'PageDown':
      return Math.min(count - 1, index + c * pageRows)
  }
}

/**
 * Moves the selected pages so they sit together in the gap `slot` (0 = before the first page, n = after
 * the last; expressed in the current numbering). Selected pages keep their relative order.
 * Returns the new order (`order[k]` = old index of the page now at position k) and the new positions of
 * the moved pages.
 */
export function moveBlock(n: number, selected: number[], slot: number): { order: number[]; selection: number[] } {
  const sel = uniqSorted(selected.filter((i) => i >= 0 && i < n))
  const isSel = new Set(sel)
  const target = clamp(slot, 0, n)
  const before: number[] = []
  const after: number[] = []
  for (let i = 0; i < n; i++) {
    if (isSel.has(i)) continue
    if (i < target) before.push(i)
    else after.push(i)
  }
  const order = [...before, ...sel, ...after]
  return { order, selection: range(before.length, before.length + sel.length - 1) }
}

/** True if dropping `selected` into `slot` would leave the order unchanged. */
export function isNoopMove(n: number, selected: number[], slot: number): boolean {
  const { order } = moveBlock(n, selected, slot)
  return order.every((v, i) => v === i)
}

/**
 * Moves the selection one step earlier (`delta` < 0) or later (`delta` > 0), `abs(delta)` times.
 * Pages already at the edge stay put; the others still move. Returns the same shape as `moveBlock`.
 */
export function moveByStep(n: number, selected: number[], delta: number): { order: number[]; selection: number[] } {
  const order = range(0, n - 1)
  const sel = new Set(selected.filter((i) => i >= 0 && i < n))
  const dir = delta < 0 ? -1 : 1
  for (let step = 0; step < Math.abs(delta); step++) {
    // Walk in the direction of travel: a selected page swaps with an unselected neighbour, so a block moves as one
    // and pages already at the edge (or packed against it) stay put.
    const positions = dir < 0 ? range(0, n - 1) : range(0, n - 1).reverse()
    for (const p of positions) {
      const q = p + dir
      if (q < 0 || q >= n || !sel.has(order[p]) || sel.has(order[q])) continue
      ;[order[p], order[q]] = [order[q], order[p]]
    }
  }
  const selection = order.map((old, pos) => (sel.has(old) ? pos : -1)).filter((pos) => pos >= 0)
  return { order, selection }
}

/** Turns an order (old indices) into page specs. */
export const specsFromOrder = (order: number[]): PageSpec[] => order.map((index) => ({ kind: 'orig', index }))

export function planReorder(n: number, selected: number[], slot: number): PagePlan | null {
  if (isNoopMove(n, selected, slot)) return null
  const { order, selection } = moveBlock(n, selected, slot)
  return { specs: specsFromOrder(order), selection }
}

export function planMoveByStep(n: number, selected: number[], delta: number): PagePlan | null {
  const { order, selection } = moveByStep(n, selected, delta)
  if (order.every((v, i) => v === i)) return null
  return { specs: specsFromOrder(order), selection }
}

export function planRotate(n: number, selected: number[], delta: 90 | -90 | 180): PagePlan {
  const isSel = new Set(selected)
  return {
    specs: range(0, n - 1).map((index) => ({ kind: 'orig', index, rotate: isSel.has(index) ? delta : undefined })),
    selection: uniqSorted(selected)
  }
}

/** Null when the selection would remove every page (a PDF needs at least one). */
export function planDelete(n: number, selected: number[]): PagePlan | null {
  const sel = new Set(selected.filter((i) => i >= 0 && i < n))
  if (sel.size === 0 || sel.size >= n) return null
  const keep = range(0, n - 1).filter((i) => !sel.has(i))
  const first = Math.min(...sel)
  // Select the page that took the place of the first deleted one, so keyboard use can carry on.
  const focus = clamp(first - range(0, first - 1).filter((i) => sel.has(i)).length, 0, keep.length - 1)
  return { specs: specsFromOrder(keep), selection: [focus] }
}

/** Each selected page is copied right after itself. The copies become the selection. */
export function planDuplicate(n: number, selected: number[]): PagePlan {
  const sel = new Set(selected.filter((i) => i >= 0 && i < n))
  const specs: PageSpec[] = []
  const selection: number[] = []
  for (let i = 0; i < n; i++) {
    specs.push({ kind: 'orig', index: i })
    if (sel.has(i)) {
      selection.push(specs.length)
      specs.push({ kind: 'orig', index: i }) // same index again = a copy
    }
  }
  return { specs, selection }
}

/** Inserts `count` blank pages into gap `slot`. `like` is the neighbour whose size they copy. */
export function planInsertBlank(n: number, slot: number, size: { width: number; height: number } | 'neighbour', count = 1): PagePlan {
  const s = clamp(slot, 0, n)
  const like = n === 0 ? undefined : s > 0 ? s - 1 : 0
  const blank: PageSpec = size === 'neighbour' ? { kind: 'blank', like } : { kind: 'blank', width: size.width, height: size.height }
  const specs: PageSpec[] = []
  const selection: number[] = []
  for (let i = 0; i <= n; i++) {
    if (i === s) {
      for (let k = 0; k < count; k++) {
        selection.push(specs.length)
        specs.push({ ...blank })
      }
    }
    if (i < n) specs.push({ kind: 'orig', index: i })
  }
  return { specs, selection }
}

/** Inserts pages `srcIndices` (0-based, of the other PDF) into gap `slot`. */
export function planInsertExternal(n: number, slot: number, srcIndices: number[]): PagePlan {
  const s = clamp(slot, 0, n)
  const specs: PageSpec[] = []
  const selection: number[] = []
  for (let i = 0; i <= n; i++) {
    if (i === s) {
      for (const index of srcIndices) {
        selection.push(specs.length)
        specs.push({ kind: 'ext', index })
      }
    }
    if (i < n) specs.push({ kind: 'orig', index: i })
  }
  return { specs, selection }
}

/**
 * Which gap a pointer at (x, y) is over, for drag & drop in a grid of equally sized cells.
 * The gap is before the cell when the pointer is in its left half, after it otherwise.
 */
export function dropSlot(x: number, y: number, cellW: number, cellH: number, cols: number, count: number): number {
  if (count === 0) return 0
  const c = Math.max(1, cols)
  const rows = Math.ceil(count / c)
  const row = clamp(Math.floor(y / cellH), 0, rows - 1)
  const col = clamp(Math.floor(x / cellW), 0, c - 1)
  const inLeftHalf = x - col * cellW < cellW / 2
  const index = row * c + col
  if (index >= count) return count
  return clamp(inLeftHalf ? index : index + 1, 0, count)
}

/** Columns that fit in `width` px of grid area for cells `cellW` wide (never fewer than one). */
export const columnsFor = (width: number, cellW: number): number => Math.max(1, Math.floor(width / Math.max(1, cellW)))

/** Rows of the grid intersecting [scrollTop - overscan, scrollTop + viewH + overscan], as [first, last] inclusive. */
export function visibleRowRange(scrollTop: number, viewH: number, rowH: number, rows: number, overscanRows = 1): [number, number] {
  if (rows <= 0) return [0, -1]
  const first = clamp(Math.floor(scrollTop / rowH) - overscanRows, 0, rows - 1)
  const last = clamp(Math.floor((scrollTop + viewH) / rowH) + overscanRows, 0, rows - 1)
  return [first, last]
}

/** "Pages 3-5 moved to position 1" style phrases for the live region. */
export function describeMove(selectedAfter: number[]): string {
  if (selectedAfter.length === 0) return ''
  const first = selectedAfter[0] + 1
  const last = selectedAfter[selectedAfter.length - 1] + 1
  const contiguous = last - first + 1 === selectedAfter.length
  if (selectedAfter.length === 1) return `Page moved to position ${first}.`
  return contiguous ? `${selectedAfter.length} pages moved to positions ${first} to ${last}.` : `${selectedAfter.length} pages moved.`
}
