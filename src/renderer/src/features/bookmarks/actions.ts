import { askConfirm } from '../../state/confirm'
import { useTabs } from '../../state/tabs'
import { announce, runEdit } from '../links/common'
import { useBookmarks, refreshBookmarks } from './data'
import { currentViewTarget, selectionTarget, xyzTail, goToDestination } from './nav'
import type { BmNode, NewBookmark, Rgb } from './pdf/model'
import { firstPageIndex } from './pdf/model'
import {
  BookmarkError,
  addBookmark,
  addBookmarkTree,
  clearBookmarks,
  deleteBookmark,
  indentBookmark,
  moveBookmarkBy,
  moveBookmarkTo,
  outdentBookmark,
  renameBookmark,
  setAllBookmarksOpen,
  setBookmarkDestination,
  styleBookmark,
  type StylePatch
} from './pdf/ops'
import { locate, subtreeIds } from './pdf/tree'
import { useBookmarkUi } from './store'

/**
 * Glue between the bookmarks panel and the pure outline operations: each user action is one `editPdf` call
 * (one undo step), failures become toasts, successes are announced to screen readers.
 */

const run = <T>(docId: string, label: string, fn: Parameters<typeof runEdit<T>>[2]): Promise<T | undefined> =>
  runEdit(docId, label, fn, (e) => e instanceof BookmarkError)

const rootsOf = (docId: string): BmNode[] => useBookmarks.getState().byDoc[docId]?.roots ?? []

const MAX_DEFAULT_TITLE = 160

/** Title for a new bookmark made from selected text: one line, trimmed, not absurdly long. */
export const titleFromSelection = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_DEFAULT_TITLE ? `${t.slice(0, MAX_DEFAULT_TITLE - 1).trimEnd()}…` : t
}

/**
 * Adds a bookmark for the selected text (its title), or for the current page/position. It goes right after the
 * selected bookmark (same level), or at the end; the new item is selected and opened for renaming.
 */
export async function addBookmarkHere(docId: string): Promise<string | undefined> {
  const sel = selectionTarget()
  const target = sel?.target ?? currentViewTarget(docId)
  if (!target) return undefined
  const ui = useBookmarkUi.getState()
  const afterId = ui.selected[docId] && locate(rootsOf(docId), ui.selected[docId]!) ? ui.selected[docId]! : null
  const title = sel ? titleFromSelection(sel.text) : `Page ${target.pageIndex + 1}`
  const id = await run(docId, 'Add bookmark', (pdf) => {
    const page = pdf.getPages()[target.pageIndex]
    if (!page) throw new BookmarkError('That page does not exist.')
    return addBookmark(pdf, { title, page: { pageIndex: target.pageIndex, tail: xyzTail(page, target) }, afterId })
  })
  if (!id) return undefined
  void refreshBookmarks(docId)
  useBookmarkUi.getState().select(docId, id)
  useBookmarkUi.getState().revealItem(id)
  useBookmarkUi.getState().setEditing(id)
  announce(`Bookmark added for page ${target.pageIndex + 1}. Type a title and press Enter.`)
  return id
}

export async function renameAction(docId: string, id: string, title: string): Promise<boolean> {
  const before = locate(rootsOf(docId), id)?.node.title
  if (before === title) return true
  const ok = await run(docId, 'Rename bookmark', (pdf) => {
    renameBookmark(pdf, id, title)
    return true
  })
  if (ok) announce(`Bookmark renamed to ${title.trim()}`)
  return !!ok
}

/** Deletes a bookmark; asks first when it has children (they go with it). */
export async function deleteAction(docId: string, id: string): Promise<boolean> {
  const roots = rootsOf(docId)
  const loc = locate(roots, id)
  if (!loc) return false
  const total = subtreeIds(loc.node).length
  if (total > 1) {
    const answer = await askConfirm({
      title: 'Delete this bookmark and its children?',
      message: `“${loc.node.title}” has ${total - 1} ${total - 1 === 1 ? 'bookmark' : 'bookmarks'} nested under it. They will be deleted too.`,
      buttons: [
        { label: `Delete ${total} bookmarks`, value: 'delete', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (answer !== 'delete') return false
  }
  // Where selection should go afterwards: the next sibling, else the previous one, else the parent.
  const neighbour = loc.list[loc.index + 1]?.id ?? loc.list[loc.index - 1]?.id ?? loc.parent?.id ?? null
  const n = await run(docId, total > 1 ? 'Delete bookmarks' : 'Delete bookmark', (pdf) => deleteBookmark(pdf, id))
  if (n === undefined) return false
  useBookmarkUi.getState().select(docId, neighbour)
  announce(n > 1 ? `${n} bookmarks deleted` : 'Bookmark deleted')
  return true
}

export async function deleteAllAction(docId: string): Promise<boolean> {
  const count = useBookmarks.getState().byDoc[docId]?.count ?? 0
  if (count === 0) return false
  const answer = await askConfirm({
    title: 'Delete all bookmarks?',
    message: `All ${count} ${count === 1 ? 'bookmark' : 'bookmarks'} of this document will be removed. You can undo this.`,
    buttons: [
      { label: 'Delete all', value: 'delete', variant: 'danger' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel'
  })
  if (answer !== 'delete') return false
  const n = await run(docId, 'Delete all bookmarks', (pdf) => clearBookmarks(pdf))
  if (n === undefined) return false
  useBookmarkUi.getState().select(docId, null)
  announce('All bookmarks deleted')
  return true
}

export async function indentAction(docId: string, id: string): Promise<boolean> {
  const ok = await run(docId, 'Nest bookmark', (pdf) => {
    indentBookmark(pdf, id)
    return true
  })
  if (ok) {
    useBookmarkUi.getState().revealItem(id)
    announce('Bookmark nested one level deeper')
  }
  return !!ok
}

export async function outdentAction(docId: string, id: string): Promise<boolean> {
  const ok = await run(docId, 'Un-nest bookmark', (pdf) => {
    outdentBookmark(pdf, id)
    return true
  })
  if (ok) {
    useBookmarkUi.getState().revealItem(id)
    announce('Bookmark moved one level up')
  }
  return !!ok
}

export async function moveByAction(docId: string, id: string, delta: -1 | 1): Promise<boolean> {
  const ok = await run(docId, 'Reorder bookmark', (pdf) => {
    moveBookmarkBy(pdf, id, delta)
    return true
  })
  if (ok) {
    useBookmarkUi.getState().revealItem(id)
    announce(delta < 0 ? 'Bookmark moved up' : 'Bookmark moved down')
  }
  return !!ok
}

export async function moveToAction(docId: string, id: string, targetId: string, where: 'before' | 'after' | 'inside'): Promise<boolean> {
  const ok = await run(docId, 'Move bookmark', (pdf) => {
    moveBookmarkTo(pdf, id, targetId, where)
    return true
  })
  if (ok) {
    useBookmarkUi.getState().select(docId, id)
    useBookmarkUi.getState().revealItem(id)
    announce('Bookmark moved')
  }
  return !!ok
}

export async function styleAction(docId: string, id: string, patch: StylePatch): Promise<boolean> {
  const ok = await run(docId, 'Change bookmark style', (pdf) => {
    styleBookmark(pdf, id, patch)
    return true
  })
  return !!ok
}

export const colorToHex = (c: Rgb | null): string => (c ? `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : '#000000')
export const hexToColor = (hex: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Points the bookmark at what is on screen now: the selected text's position, or the top of the visible part of the current page. */
export async function pointToCurrentView(docId: string, id: string): Promise<boolean> {
  const target = selectionTarget()?.target ?? currentViewTarget(docId)
  if (!target) return false
  const ok = await run(docId, 'Change bookmark destination', (pdf) => {
    const page = pdf.getPages()[target.pageIndex]
    if (!page) throw new BookmarkError('That page does not exist.')
    setBookmarkDestination(pdf, id, { pageIndex: target.pageIndex, tail: xyzTail(page, target) })
    return true
  })
  if (ok) announce(`Bookmark now points to page ${target.pageIndex + 1}`)
  return !!ok
}

export async function setAllOpenAction(docId: string, open: boolean): Promise<boolean> {
  const ok = await run(docId, open ? 'Open all bookmarks by default' : 'Close all bookmarks by default', (pdf) => {
    setAllBookmarksOpen(pdf, open)
    return true
  })
  if (ok) {
    useBookmarkUi.getState().clearExpanded(docId)
    announce(open ? 'All bookmarks will be expanded by default' : 'All bookmarks will be collapsed by default')
  }
  return !!ok
}

/** Creates the reviewed, generated bookmarks: replacing the existing ones or appended after them. One undo step. */
export async function applyGenerated(docId: string, items: NewBookmark[], mode: 'replace' | 'append'): Promise<number | undefined> {
  const n = await run(docId, mode === 'replace' ? 'Generate bookmarks' : 'Add generated bookmarks', (pdf) => addBookmarkTree(pdf, items, mode))
  if (n === undefined) return undefined
  useBookmarkUi.getState().clearExpanded(docId)
  announce(`${n} bookmarks created`)
  return n
}

/** Follows a bookmark: to its page and position (or the first descendant's page for a heading-only item). */
export async function goToBookmark(docId: string, node: BmNode): Promise<void> {
  if (node.target.kind === 'page') {
    await goToDestination(docId, node.target.dest.pageIndex, node.target.dest.tail)
    return
  }
  if (node.target.kind === 'uri') {
    window.open(node.target.uri, '_blank', 'noopener') // the main process only lets http(s) and mailto leave the app
    return
  }
  if (node.target.kind === 'other') {
    announce(`This bookmark runs a ${node.target.action} action, which Epdf does not follow.`)
    return
  }
  const p = firstPageIndex(node)
  if (p !== null) useTabs.getState().goToPage(docId, p + 1)
  else announce('This bookmark has no destination in the document.')
}
