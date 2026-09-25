import type { ChangeText } from './enrich'
import type { Change, ChangeKind, CompareCounts, CompareResult } from './types'

/** Pure helpers behind the change list: filtering, counting per page, next/previous and announcements. */

export const KIND_LABEL: Record<ChangeKind, string> = { added: 'Added', removed: 'Removed', modified: 'Modified', moved: 'Moved' }
export const ALL_KINDS: ChangeKind[] = ['removed', 'modified', 'added', 'moved']

export interface Filters {
  kinds: ReadonlySet<ChangeKind>
  /** Only changes touching this page (either document), or null for all. */
  page: number | null
  /** Case-insensitive text that must occur in the old or new text of the change. */
  query: string
}

export const NO_FILTER: Filters = { kinds: new Set(ALL_KINDS), page: null, query: '' }

/** The page number a change is listed under: its new page, else its old page. */
export const primaryPage = (c: Change): number => c.new?.page ?? c.old?.page ?? 0

const touchesPage = (c: Change, page: number): boolean => c.old?.page === page || c.new?.page === page

export function filterChanges(changes: Change[], texts: ChangeText[], f: Filters): Change[] {
  const q = f.query.trim().toLowerCase()
  return changes.filter((c) => {
    if (!f.kinds.has(c.kind)) return false
    if (f.page !== null && !touchesPage(c, f.page)) return false
    if (q) {
      const t = texts[c.id]
      if (!t) return false
      if (!t.oldText.toLowerCase().includes(q) && !t.newText.toLowerCase().includes(q)) return false
    }
    return true
  })
}

export interface PageCounts extends CompareCounts {
  page: number
}

/** Changes per (new, else old) page number, ascending. */
export function countsPerPage(changes: Change[]): PageCounts[] {
  const byPage = new Map<number, PageCounts>()
  for (const c of changes) {
    const page = primaryPage(c)
    let e = byPage.get(page)
    if (!e) byPage.set(page, (e = { page, added: 0, removed: 0, modified: 0, moved: 0, total: 0 }))
    e[c.kind]++
    e.total++
  }
  return [...byPage.values()].sort((a, b) => a.page - b.page)
}

/** Index in `visible` of the change after / before `currentId` (wrapping), or -1 when the list is empty. */
export function stepChange(visible: Change[], currentId: number | null, dir: 1 | -1): number {
  if (visible.length === 0) return -1
  if (currentId === null) return dir === 1 ? 0 : visible.length - 1
  const at = visible.findIndex((c) => c.id === currentId)
  if (at >= 0) return (at + dir + visible.length) % visible.length
  // The current change is filtered out: continue from where it would have been.
  if (dir === 1) {
    const i = visible.findIndex((c) => c.id > currentId)
    return i >= 0 ? i : 0
  }
  for (let i = visible.length - 1; i >= 0; i--) if (visible[i].id < currentId) return i
  return visible.length - 1
}

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One sentence for a screen reader: "Change 5 of 42. Modified on page 3: “100” to “200”." */
export function describeChange(c: Change, position: number, total: number, t: ChangeText | undefined): string {
  const where = c.kind === 'moved' ? `from page ${c.old?.page} to page ${c.new?.page}` : `on page ${primaryPage(c)}`
  const oldT = clip(t?.oldText ?? '')
  const newT = clip(t?.newText ?? '')
  let what = ''
  if (c.kind === 'removed') what = `“${oldT}”`
  else if (c.kind === 'added') what = `“${newT}”`
  else if (c.kind === 'modified') what = `“${oldT}” to “${newT}”`
  else what = `“${newT || oldT}”${c.edited ? ' (also edited)' : ''}`
  return `Change ${position} of ${total}. ${KIND_LABEL[c.kind]} ${where}: ${what}.`
}

/** "12 changes: 5 added, 3 removed, 3 modified, 1 moved" (zero kinds omitted). */
export function describeCounts(c: CompareCounts): string {
  if (c.total === 0) return 'No differences'
  const parts = (['added', 'removed', 'modified', 'moved'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`)
  return `${c.total} ${c.total === 1 ? 'change' : 'changes'}: ${parts.join(', ')}`
}

/** Rows (page pairs) that have something to show when only changed pages are wanted. */
export function changedPairIndexes(r: CompareResult): number[] {
  const out: number[] = []
  r.pairs.forEach((p, i) => {
    if (p.changes > 0 || p.old === null || p.new === null || p.moved) out.push(i)
  })
  return out
}
