import type { PDFDocument } from 'pdf-lib'
import { normalizeTail, type DestTail } from '@shared/features/destinations'
import { sanitizeTitle } from '@shared/features/pdftext'
import { makeNode, type BmNode, type NewBookmark, type Rgb } from './model'
import { readBookmarks } from './read'
import { contains, indent, insertNode, locate, moveNode, moveWithinParent, outdent, removeNode, setAllOpen, subtreeIds } from './tree'
import { writeBookmarks } from './write'

/**
 * Outline edit operations on a live pdf-lib document (call them inside `editPdf`). Each reads the current
 * outline, applies one change to the tree and writes it back; the ones that create items return the id the
 * new item has in the file. They throw `BookmarkError` (with a message fit to show) when the change is not possible.
 */

export class BookmarkError extends Error {}

function edit<T>(pdf: PDFDocument, fn: (roots: BmNode[]) => T): { result: T; created: Map<string, string> } {
  const { roots } = readBookmarks(pdf)
  const result = fn(roots)
  return { result, created: writeBookmarks(pdf, roots) }
}

const need = (roots: BmNode[], id: string): NonNullable<ReturnType<typeof locate>> => {
  const loc = locate(roots, id)
  if (!loc) throw new BookmarkError('That bookmark no longer exists.')
  return loc
}

const pageCheck = (pdf: PDFDocument, pageIndex: number): void => {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw new BookmarkError('That page does not exist.')
}

export interface AddBookmarkSpec {
  title: string
  page?: { pageIndex: number; tail: DestTail }
  /** Put the new bookmark right after this one (same level), or as the `index`th child of `parentId` (null = top level; default: end). */
  afterId?: string | null
  parentId?: string | null
  index?: number
  bold?: boolean
  italic?: boolean
  color?: Rgb | null
}

/** Adds one bookmark; returns its id in the file. */
export function addBookmark(pdf: PDFDocument, spec: AddBookmarkSpec): string {
  const title = sanitizeTitle(spec.title).trim()
  if (!title) throw new BookmarkError('A bookmark needs a title.')
  if (spec.page) pageCheck(pdf, spec.page.pageIndex)
  const node = makeNode({ title, page: spec.page ? { pageIndex: spec.page.pageIndex, tail: normalizeTail(spec.page.tail) } : undefined, bold: spec.bold, italic: spec.italic, color: spec.color })
  const { created } = edit(pdf, (roots) => {
    const ok = spec.afterId ? insertNode(roots, node, { afterId: spec.afterId }) : insertNode(roots, node, { parentId: spec.parentId ?? null, index: spec.index })
    if (!ok) throw new BookmarkError('The place for the new bookmark no longer exists.')
  })
  return created.get(node.id)!
}

export function renameBookmark(pdf: PDFDocument, id: string, title: string): void {
  const t = sanitizeTitle(title).trim()
  if (!t) throw new BookmarkError('A bookmark needs a title.')
  edit(pdf, (roots) => {
    need(roots, id).node.title = t
  })
}

/** Deletes the bookmark and everything below it; returns how many items went. */
export function deleteBookmark(pdf: PDFDocument, id: string): number {
  return edit(pdf, (roots) => {
    const loc = need(roots, id)
    const n = subtreeIds(loc.node).length
    removeNode(roots, id)
    return n
  }).result
}

export function indentBookmark(pdf: PDFDocument, id: string): void {
  edit(pdf, (roots) => {
    need(roots, id)
    if (!indent(roots, id)) throw new BookmarkError('The first bookmark of a level cannot be nested further.')
  })
}

export function outdentBookmark(pdf: PDFDocument, id: string): void {
  edit(pdf, (roots) => {
    need(roots, id)
    if (!outdent(roots, id)) throw new BookmarkError('This bookmark is already at the top level.')
  })
}

export function moveBookmarkBy(pdf: PDFDocument, id: string, delta: -1 | 1): void {
  edit(pdf, (roots) => {
    need(roots, id)
    if (!moveWithinParent(roots, id, delta)) throw new BookmarkError(delta < 0 ? 'It is already the first bookmark of its level.' : 'It is already the last bookmark of its level.')
  })
}

export function moveBookmarkTo(pdf: PDFDocument, id: string, targetId: string, where: 'before' | 'after' | 'inside'): void {
  edit(pdf, (roots) => {
    const src = need(roots, id)
    need(roots, targetId)
    if (id === targetId || contains(src.node, targetId)) throw new BookmarkError('A bookmark cannot be moved into itself.')
    moveNode(roots, id, targetId, where)
  })
}

export interface StylePatch {
  bold?: boolean
  italic?: boolean
  color?: Rgb | null
  open?: boolean
}

export function styleBookmark(pdf: PDFDocument, id: string, patch: StylePatch): void {
  edit(pdf, (roots) => {
    const n = need(roots, id).node
    if (patch.bold !== undefined) n.bold = patch.bold
    if (patch.italic !== undefined) n.italic = patch.italic
    if (patch.color !== undefined) n.color = patch.color
    if (patch.open !== undefined) n.open = patch.open
  })
}

/** Opens (or closes) every bookmark that has children by default. */
export function setAllBookmarksOpen(pdf: PDFDocument, open: boolean): void {
  edit(pdf, (roots) => setAllOpen(roots, open))
}

/** Points a bookmark at a page/view. */
export function setBookmarkDestination(pdf: PDFDocument, id: string, page: { pageIndex: number; tail: DestTail } | null): void {
  if (page) pageCheck(pdf, page.pageIndex)
  edit(pdf, (roots) => {
    const n = need(roots, id).node
    n.target = page ? { kind: 'page', dest: { pageIndex: page.pageIndex, tail: normalizeTail(page.tail) }, via: 'dest' } : { kind: 'none' }
    n.targetChanged = true
  })
}

export function clearBookmarks(pdf: PDFDocument): number {
  return edit(pdf, (roots) => {
    const n = roots.reduce((s, r) => s + subtreeIds(r).length, 0)
    roots.length = 0
    return n
  }).result
}

/**
 * Adds a whole tree of new bookmarks (auto-generation): `replace` swaps the existing outline for it, `append`
 * puts it after the existing top-level items. Returns how many items were created.
 */
export function addBookmarkTree(pdf: PDFDocument, items: NewBookmark[], mode: 'replace' | 'append'): number {
  const check = (list: NewBookmark[]): void => {
    for (const it of list) {
      if (it.page) pageCheck(pdf, it.page.pageIndex)
      check(it.children ?? [])
    }
  }
  check(items)
  const fresh = items.map((i) => sanitizeTree(i)).filter((i): i is NewBookmark => !!i).map(makeNode)
  if (fresh.length === 0) throw new BookmarkError('There are no bookmarks to add.')
  edit(pdf, (roots) => {
    if (mode === 'replace') roots.length = 0
    roots.push(...fresh)
  })
  let n = 0
  const count = (list: BmNode[]): void => {
    for (const x of list) {
      n++
      count(x.children)
    }
  }
  count(fresh)
  return n
}

function sanitizeTree(item: NewBookmark): NewBookmark | null {
  const title = sanitizeTitle(item.title).trim()
  if (!title) return null
  return { ...item, title, page: item.page ? { pageIndex: item.page.pageIndex, tail: normalizeTail(item.page.tail) } : undefined, children: (item.children ?? []).map(sanitizeTree).filter((c): c is NewBookmark => !!c) }
}
