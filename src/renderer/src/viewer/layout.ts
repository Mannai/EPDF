import type { ViewMode } from '@shared/types'

/** PDF points are 1/72in; CSS px are 1/96in. Zoom 100% therefore renders at scale 96/72. */
export const CSS_SCALE = 96 / 72
export const PAGE_GAP = 12
export const PAGE_PAD_X = 16
export const PAGE_PAD_Y = 16

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4, 6, 8]
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export interface PageSize {
  w: number
  h: number
}

export interface Row {
  /** 0-based page indices shown side by side in this row. */
  pages: number[]
  top: number
  height: number
  width: number
}

export interface Layout {
  rows: Row[]
  totalHeight: number
  maxRowWidth: number
  /** page index → row index, or -1 if the page is not part of the layout (single-page mode). */
  pageRow: Int32Array
}

/** Which pages go together in a row for a given view mode. */
export function groupPages(numPages: number, mode: ViewMode, currentIndex: number): number[][] {
  if (numPages <= 0) return []
  if (mode === 'single') return [[Math.min(Math.max(currentIndex, 0), numPages - 1)]]
  const per = mode === 'two' ? 2 : 1
  const groups: number[][] = []
  for (let i = 0; i < numPages; i += per) {
    const g: number[] = []
    for (let j = i; j < Math.min(i + per, numPages); j++) g.push(j)
    groups.push(g)
  }
  return groups
}

/** Number of page columns a view mode shows at once (used for fit-width). */
export const columnsFor = (mode: ViewMode): number => (mode === 'two' ? 2 : 1)

export function buildLayout(
  numPages: number,
  groups: number[][],
  sizeOf: (pageIndex: number) => PageSize,
  scale: number
): Layout {
  const pageRow = new Int32Array(numPages).fill(-1)
  const rows: Row[] = []
  let y = PAGE_PAD_Y
  let maxRowWidth = 0
  groups.forEach((pages, ri) => {
    let width = 0
    let height = 0
    pages.forEach((p, i) => {
      const s = sizeOf(p)
      width += s.w * scale + (i > 0 ? PAGE_GAP : 0)
      height = Math.max(height, s.h * scale)
      pageRow[p] = ri
    })
    rows.push({ pages, top: y, height, width })
    maxRowWidth = Math.max(maxRowWidth, width)
    y += height + PAGE_GAP
  })
  return { rows, totalHeight: y - (rows.length ? PAGE_GAP : 0) + PAGE_PAD_Y, maxRowWidth, pageRow }
}

/** Index of the row containing (or nearest below) `y`. Binary search; O(log n). */
export function rowAt(rows: { top: number; height: number }[], y: number): number {
  if (rows.length === 0) return -1
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].top + rows[mid].height <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Inclusive [first, last] row indices intersecting the viewport plus an overscan margin. */
export function visibleRows(rows: Row[], scrollTop: number, viewportH: number, overscan: number): [number, number] {
  if (rows.length === 0) return [0, -1]
  const first = rowAt(rows, scrollTop - overscan)
  let last = rowAt(rows, scrollTop + viewportH + overscan)
  if (rows[last].top > scrollTop + viewportH + overscan) last = Math.max(first, last - 1)
  return [first, last]
}

/** The page the user is "on": the row crossing a line a quarter of the way down the viewport. */
export function currentPageAt(layout: Layout, scrollTop: number, viewportH: number): number {
  const ri = rowAt(layout.rows, scrollTop + viewportH * 0.25)
  return ri < 0 ? 0 : layout.rows[ri].pages[0]
}

export interface FitInput {
  containerW: number
  containerH: number
  ref: PageSize
  columns: number
}

/** Scale (PDF pt → CSS px) that fits the reference page to the container width. */
export function fitWidthScale({ containerW, ref, columns }: FitInput): number {
  const avail = containerW - 2 * PAGE_PAD_X - (columns - 1) * PAGE_GAP
  return Math.max(avail / (ref.w * columns), 0.01)
}

/** Scale that fits one whole reference page (or spread) into the container. */
export function fitPageScale(input: FitInput): number {
  const byH = (input.containerH - 2 * PAGE_PAD_Y) / input.ref.h
  return Math.max(Math.min(fitWidthScale(input), byH), 0.01)
}

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export function nextZoomStep(current: number, dir: 1 | -1): number {
  const eps = 1e-3
  if (dir === 1) return ZOOM_STEPS.find((z) => z > current + eps) ?? MAX_ZOOM
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - eps) return ZOOM_STEPS[i]
  return MIN_ZOOM
}

/**
 * Caps the canvas backing-store size so huge pages/zooms don't exhaust GPU memory.
 * Returns the device-pixel multiplier to render at.
 */
export function outputScaleFor(cssW: number, cssH: number, dpr: number, maxPixels = 16_777_216): number {
  const wanted = dpr
  const pixels = cssW * wanted * (cssH * wanted)
  if (pixels <= maxPixels) return wanted
  return Math.max(Math.sqrt(maxPixels / (cssW * cssH)), 0.25)
}
