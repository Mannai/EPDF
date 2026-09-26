import type { BmNode } from './model'

/** Pure operations on a bookmark tree (arrays of `BmNode`). They mutate in place and return whether anything changed. */

export interface Loc {
  node: BmNode
  list: BmNode[]
  index: number
  parent: BmNode | null
  depth: number
}

export function locate(roots: BmNode[], id: string): Loc | null {
  const stack: { list: BmNode[]; parent: BmNode | null; depth: number }[] = [{ list: roots, parent: null, depth: 0 }]
  while (stack.length) {
    const { list, parent, depth } = stack.pop()!
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { node: list[i], list, index: i, parent, depth }
      if (list[i].children.length) stack.push({ list: list[i].children, parent: list[i], depth: depth + 1 })
    }
  }
  return null
}

export function contains(node: BmNode, id: string): boolean {
  if (node.id === id) return true
  return node.children.some((c) => contains(c, id))
}

export function walk(roots: readonly BmNode[], cb: (n: BmNode, depth: number, parent: BmNode | null) => void): void {
  const rec = (list: readonly BmNode[], depth: number, parent: BmNode | null): void => {
    for (const n of list) {
      cb(n, depth, parent)
      if (n.children.length) rec(n.children, depth + 1, n)
    }
  }
  rec(roots, 0, null)
}

/** How many levels of nesting the tree has (an empty tree has 0). */
export function maxDepth(roots: readonly BmNode[]): number {
  let m = 0
  walk(roots, (_n, d) => {
    m = Math.max(m, d + 1)
  })
  return m
}

export function insertNode(roots: BmNode[], node: BmNode, where: { parentId: string | null; index?: number } | { afterId: string }): boolean {
  if ('afterId' in where) {
    const loc = locate(roots, where.afterId)
    if (!loc) return false
    loc.list.splice(loc.index + 1, 0, node)
    return true
  }
  const list = where.parentId === null ? roots : locate(roots, where.parentId)?.node.children
  if (!list) return false
  const at = where.index === undefined ? list.length : Math.min(Math.max(0, where.index), list.length)
  list.splice(at, 0, node)
  if (where.parentId !== null) locate(roots, where.parentId)!.node.open = true
  return true
}

export function removeNode(roots: BmNode[], id: string): BmNode | null {
  const loc = locate(roots, id)
  if (!loc) return null
  loc.list.splice(loc.index, 1)
  return loc.node
}

/** Makes the item the last child of its previous sibling (which is opened so the item stays visible). */
export function indent(roots: BmNode[], id: string): boolean {
  const loc = locate(roots, id)
  if (!loc || loc.index === 0) return false
  const prev = loc.list[loc.index - 1]
  loc.list.splice(loc.index, 1)
  prev.children.push(loc.node)
  prev.open = true
  return true
}

/** Moves the item out of its parent, to just after it. Items that followed it stay under the old parent. */
export function outdent(roots: BmNode[], id: string): boolean {
  const loc = locate(roots, id)
  if (!loc || !loc.parent) return false
  const parentLoc = locate(roots, loc.parent.id)!
  loc.list.splice(loc.index, 1)
  parentLoc.list.splice(parentLoc.index + 1, 0, loc.node)
  return true
}

/** Swaps the item with its previous/next sibling. */
export function moveWithinParent(roots: BmNode[], id: string, delta: -1 | 1): boolean {
  const loc = locate(roots, id)
  if (!loc) return false
  const to = loc.index + delta
  if (to < 0 || to >= loc.list.length) return false
  ;[loc.list[loc.index], loc.list[to]] = [loc.list[to], loc.list[loc.index]]
  return true
}

/**
 * Moves an item (with its children) next to or into another one: `before`/`after` make it a sibling of
 * `targetId`, `inside` makes it the last child. Refuses to move an item into itself or its own descendants.
 */
export function moveNode(roots: BmNode[], id: string, targetId: string, where: 'before' | 'after' | 'inside'): boolean {
  if (id === targetId) return false
  const src = locate(roots, id)
  if (!src || contains(src.node, targetId)) return false
  if (!locate(roots, targetId)) return false
  src.list.splice(src.index, 1)
  const target = locate(roots, targetId)! // re-located: the removal may have shifted indices
  if (where === 'inside') {
    target.node.children.push(src.node)
    target.node.open = true
  } else target.list.splice(target.index + (where === 'after' ? 1 : 0), 0, src.node)
  return true
}

/** The item's id and every descendant's, in document order. */
export function subtreeIds(node: BmNode): string[] {
  const out: string[] = []
  walk([node], (n) => out.push(n.id))
  return out
}

export function setAllOpen(roots: BmNode[], open: boolean): void {
  walk(roots, (n) => {
    if (n.children.length) n.open = open
  })
}

/** Deep copy (nodes are plain data). */
export function cloneTree(nodes: readonly BmNode[]): BmNode[] {
  return nodes.map((n) => ({ ...n, color: n.color ? ([...n.color] as BmNode['color']) : null, target: n.target, children: cloneTree(n.children) }))
}
