import { subtypeLabel, type AnnotInfo, type ReviewState } from './model'

/**
 * Comment threads: replies are annotations with /IRT (in reply to) and /RT /R; review states are
 * annotations with /StateModel /Review and /State that point at their target with /IRT. Pure logic over
 * `AnnotInfo`, shared by the Comments panel and the tests.
 */

export const isStateRecord = (a: AnnotInfo): boolean => !!a.stateModel && !!a.state

export interface Thread {
  root: AnnotInfo
  /** Replies in time order (nested replies are flattened; `depth` says how deep). */
  replies: { annot: AnnotInfo; depth: number }[]
  /** Current review state of the root. */
  state: ReviewState
  /** Who set the current state and when, when known. */
  stateBy?: string
  stateAt?: number | null
}

export const timeOf = (a: AnnotInfo): number => a.created ?? a.modified ?? 0

/** Page order, then top to bottom, then left to right (PDF y grows upwards). */
export function compareByPosition(a: AnnotInfo, b: AnnotInfo): number {
  return a.pageIndex - b.pageIndex || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0] || a.order - b.order
}

const REVIEW: ReviewState[] = ['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']
const asReview = (s: string | null): ReviewState | null => (REVIEW as string[]).includes(s ?? '') ? (s as ReviewState) : null

/** Newest review-state record per target id. */
export function reviewStates(annots: readonly AnnotInfo[]): Map<string, { state: ReviewState; by: string; at: number | null }> {
  const latest = new Map<string, { state: ReviewState; by: string; at: number | null; t: number; i: number }>()
  annots.forEach((a, i) => {
    if (!isStateRecord(a) || a.stateModel !== 'Review' || !a.irt) return
    const state = asReview(a.state)
    if (!state) return
    const t = a.created ?? a.modified ?? 0
    const cur = latest.get(a.irt)
    if (!cur || t > cur.t || (t === cur.t && i > cur.i)) latest.set(a.irt, { state, by: a.author, at: a.created ?? a.modified, t, i })
  })
  return new Map([...latest].map(([k, v]) => [k, { state: v.state, by: v.by, at: v.at }]))
}

export function buildThreads(annots: readonly AnnotInfo[]): Thread[] {
  const byId = new Map(annots.map((a) => [a.id, a]))
  const states = reviewStates(annots)
  const visible = annots.filter((a) => !isStateRecord(a))
  const parentOf = (a: AnnotInfo): AnnotInfo | undefined => {
    const p = a.irt ? byId.get(a.irt) : undefined
    return p && !isStateRecord(p) ? p : undefined
  }
  // Root of a reply chain (guarding against cycles in broken files).
  const rootOf = (a: AnnotInfo): { root: AnnotInfo; depth: number } => {
    let cur = a
    let depth = 0
    const seen = new Set<string>([a.id])
    for (;;) {
      const p = parentOf(cur)
      if (!p || seen.has(p.id)) return { root: cur, depth }
      seen.add(p.id)
      cur = p
      depth++
    }
  }
  const threads = new Map<string, Thread>()
  const roots = visible.filter((a) => !parentOf(a) || rootOf(a).root === a)
  for (const r of roots) {
    const s = states.get(r.id)
    threads.set(r.id, { root: r, replies: [], state: s?.state ?? asReview(r.state) ?? 'None', stateBy: s?.by, stateAt: s?.at })
  }
  for (const a of visible) {
    const { root, depth } = rootOf(a)
    if (root === a) continue
    threads.get(root.id)?.replies.push({ annot: a, depth })
  }
  for (const t of threads.values()) t.replies.sort((x, y) => timeOf(x.annot) - timeOf(y.annot) || x.annot.order - y.annot.order)
  return [...threads.values()].sort((a, b) => compareByPosition(a.root, b.root))
}

export interface Filters {
  /** 'all' or a PDF subtype. */
  type: string
  /** 'all' or an author name. */
  author: string
  /** 'all' or a review state. */
  status: string
  query: string
}

export const NO_FILTERS: Filters = { type: 'all', author: 'all', status: 'all', query: '' }

export function filterThreads(threads: readonly Thread[], f: Filters): Thread[] {
  const q = f.query.trim().toLowerCase()
  return threads.filter((t) => {
    if (f.type !== 'all' && t.root.subtype !== f.type) return false
    if (f.status !== 'all' && t.state !== f.status) return false
    if (f.author !== 'all' && t.root.author !== f.author && !t.replies.some((r) => r.annot.author === f.author)) return false
    if (!q) return true
    const hay = [t.root, ...t.replies.map((r) => r.annot)]
      .map((a) => `${a.contents}\n${a.author}\n${subtypeLabel(a.subtype)}\n${a.subject}`)
      .join('\n')
      .toLowerCase()
    return hay.includes(q)
  })
}

export const authorsOf = (annots: readonly AnnotInfo[]): string[] =>
  [...new Set(annots.filter((a) => !isStateRecord(a)).map((a) => a.author).filter(Boolean))].sort((a, b) => a.localeCompare(b))

export const typesOf = (annots: readonly AnnotInfo[]): string[] =>
  [...new Set(annots.filter((a) => !a.irt && !isStateRecord(a)).map((a) => a.subtype))].sort((a, b) => subtypeLabel(a).localeCompare(subtypeLabel(b)))

/** The one-line text shown for an annotation in lists: its comment, or what kind of mark it is. */
export function previewOf(a: AnnotInfo, max = 120): string {
  const t = a.contents.replace(/\s+/g, ' ').trim()
  if (!t) return subtypeLabel(a.subtype)
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export const isResolved = (s: ReviewState): boolean => s === 'Completed'

export const STATE_LABEL: Record<ReviewState, string> = {
  None: 'No status',
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Cancelled: 'Cancelled',
  Completed: 'Completed'
}
