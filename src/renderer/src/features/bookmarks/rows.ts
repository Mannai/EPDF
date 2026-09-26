import type { BmNode } from './pdf/model'

/** Pure view logic for the bookmarks tree: flattening with expand state and a filter, search text, "where am I". */

export interface Row {
  node: BmNode
  depth: number
  /** Siblings at this level (for aria-setsize) and this item's 1-based place among them (aria-posinset). */
  setSize: number
  posInSet: number
  parentId: string | null
  hasChildren: boolean
  expanded: boolean
  /** The item itself matches the filter (as opposed to only containing a match). */
  matches: boolean
}

const MARKS = /\p{M}/gu
/** Text for searching: case-folded, compatibility-normalised (Arabic presentation forms), with all combining marks (tashkeel, niqqud, accents) removed. */
export function searchKey(s: string): string {
  return s.normalize('NFKD').replace(MARKS, '').toLocaleLowerCase()
}

export interface FlattenOptions {
  isOpen(node: BmNode): boolean
  filter?: string
}

/** The rows to show. With a filter, only matching items and their ancestors appear, all of them expanded. */
export function flatten(roots: readonly BmNode[], opts: FlattenOptions): Row[] {
  const q = opts.filter ? searchKey(opts.filter.trim()) : ''
  const rows: Row[] = []

  const plain = (list: readonly BmNode[], depth: number, parentId: string | null): void => {
    list.forEach((n, i) => {
      const expanded = n.children.length > 0 && opts.isOpen(n)
      rows.push({ node: n, depth, setSize: list.length, posInSet: i + 1, parentId, hasChildren: n.children.length > 0, expanded, matches: false })
      if (expanded) plain(n.children, depth + 1, n.id)
    })
  }

  /** Rows of a subtree that has at least one match, numbered among the siblings that are shown. */
  const filtered = (list: readonly BmNode[], depth: number, parentId: string | null): Row[] => {
    const shown: { n: BmNode; matches: boolean; sub: Row[] }[] = []
    for (const n of list) {
      const matches = searchKey(n.title).includes(q)
      const sub = filtered(n.children, depth + 1, n.id)
      if (matches || sub.length) shown.push({ n, matches, sub })
    }
    const out: Row[] = []
    shown.forEach((s, i) => {
      out.push({ node: s.n, depth, setSize: shown.length, posInSet: i + 1, parentId, hasChildren: s.n.children.length > 0, expanded: s.sub.length > 0, matches: s.matches })
      out.push(...s.sub)
    })
    return out
  }

  if (q) rows.push(...filtered(roots, 0, null))
  else plain(roots, 0, null)
  return rows
}

/** All nodes in document order. */
export function allNodes(roots: readonly BmNode[]): BmNode[] {
  const out: BmNode[] = []
  const rec = (list: readonly BmNode[]): void => {
    for (const n of list) {
      out.push(n)
      rec(n.children)
    }
  }
  rec(roots)
  return out
}

/**
 * The bookmark that describes the current position: the first one that points at the current page, otherwise
 * the last one before it. Items without a page (headings only) are skipped. Null when the outline starts after it.
 */
export function currentBookmark(roots: readonly BmNode[], pageIndex: number): BmNode | null {
  let last: BmNode | null = null
  for (const n of allNodes(roots)) {
    if (n.target.kind !== 'page') continue
    const p = n.target.dest.pageIndex
    if (p === pageIndex) return n
    if (p < pageIndex) last = n
  }
  return last
}

/** The nearest visible ancestor-or-self of `id` given a row list (for highlighting an item inside a collapsed branch). */
export function visibleAncestor(roots: readonly BmNode[], rows: readonly Row[], id: string): string | null {
  const visible = new Set(rows.map((r) => r.node.id))
  if (visible.has(id)) return id
  const path: string[] = []
  const find = (list: readonly BmNode[], trail: string[]): boolean => {
    for (const n of list) {
      if (n.id === id) {
        path.push(...trail)
        return true
      }
      if (find(n.children, [...trail, n.id])) return true
    }
    return false
  }
  if (!find(roots, [])) return null
  for (let i = path.length - 1; i >= 0; i--) if (visible.has(path[i])) return path[i]
  return null
}

/** Ids of every ancestor of `id` (root first). */
export function ancestorsOf(roots: readonly BmNode[], id: string): string[] {
  const path: string[] = []
  const find = (list: readonly BmNode[], trail: string[]): boolean => {
    for (const n of list) {
      if (n.id === id) {
        path.push(...trail)
        return true
      }
      if (find(n.children, [...trail, n.id])) return true
    }
    return false
  }
  find(roots, [])
  return path
}
