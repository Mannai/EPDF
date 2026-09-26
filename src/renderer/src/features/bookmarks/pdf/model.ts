import type { DestTail, ItemTarget } from '@shared/features/destinations'

/**
 * The bookmark (outline) tree as plain data: what the panel shows and what the edit operations work on.
 * Nothing here imports pdf.js or the DOM.
 */

export type Rgb = [number, number, number]

export interface BmNode {
  /** "<obj> <gen>" of the outline item's dictionary for items read from the file; a temporary id for new ones. */
  id: string
  title: string
  target: ItemTarget
  /** True once the user chose a new destination: only then is /Dest rewritten (other targets are preserved verbatim). */
  targetChanged: boolean
  /** Children visible by default (a positive /Count). */
  open: boolean
  bold: boolean
  italic: boolean
  /** /C, each component 0..1. */
  color: Rgb | null
  children: BmNode[]
}

export interface BmRead {
  roots: BmNode[]
  warnings: string[]
  /** Every item, at all levels. */
  count: number
  hasOutline: boolean
}

let counter = 0
/** A fresh temporary id for an item that is not in the file yet. */
export const newBookmarkId = (): string => `new:${++counter}`
export const isNewId = (id: string): boolean => id.startsWith('new:')

export interface NewBookmark {
  title: string
  /** The page and view the bookmark should open; omitted for a heading-only item. */
  page?: { pageIndex: number; tail: DestTail }
  open?: boolean
  bold?: boolean
  italic?: boolean
  color?: Rgb | null
  children?: NewBookmark[]
}

export function makeNode(spec: NewBookmark): BmNode {
  return {
    id: newBookmarkId(),
    title: spec.title,
    target: spec.page ? { kind: 'page', dest: { pageIndex: spec.page.pageIndex, tail: spec.page.tail }, via: 'dest' } : { kind: 'none' },
    targetChanged: !!spec.page,
    open: spec.open ?? true,
    bold: spec.bold ?? false,
    italic: spec.italic ?? false,
    color: spec.color ?? null,
    children: (spec.children ?? []).map(makeNode)
  }
}

/** Number of items below `n` that a reader shows when `n` is expanded (children, plus the visible part of open children). */
export const visibleCount = (n: BmNode): number => n.children.reduce((sum, c) => sum + 1 + (c.open ? visibleCount(c) : 0), 0)

export function countAll(nodes: readonly BmNode[]): number {
  let n = 0
  const stack = [...nodes]
  while (stack.length) {
    const cur = stack.pop()!
    n++
    stack.push(...cur.children)
  }
  return n
}

/** The page an item (or, failing that, its first descendant with a destination) leads to. */
export function firstPageIndex(node: BmNode): number | null {
  if (node.target.kind === 'page') return node.target.dest.pageIndex
  for (const c of node.children) {
    const p = firstPageIndex(c)
    if (p !== null) return p
  }
  return null
}
