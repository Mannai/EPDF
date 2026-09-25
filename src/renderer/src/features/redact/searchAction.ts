import { pdfFor } from './doc'
import type { Rect } from './logic/geom'
import { PRESETS } from './logic/patterns'
import { RegexBudgetError, validateRegex } from './logic/safeRegex'
import { compileMatcher, searchDocument, type Matcher } from './logic/search'
import { newId, useRedact, type SearchResult } from './store'

export interface SearchForm {
  mode: 'literal' | 'preset' | 'regex'
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  presetId: string
  regex: string
  /** 1-based inclusive page range; 0 = no limit. */
  from: number
  to: number
}

export const DEFAULT_FORM: SearchForm = { mode: 'literal', query: '', caseSensitive: false, wholeWord: false, presetId: PRESETS[0].id, regex: '', from: 0, to: 0 }

const controllers = new Map<string, { aborted: boolean }>()

export function cancelSearch(docId: string): void {
  const c = controllers.get(docId)
  if (c) c.aborted = true
}

export function matcherOf(f: SearchForm): Matcher {
  if (f.mode === 'preset') return { kind: 'preset', id: f.presetId }
  if (f.mode === 'regex') return { kind: 'regex', source: f.regex, caseSensitive: f.caseSensitive }
  return { kind: 'literal', query: f.query, caseSensitive: f.caseSensitive, wholeWord: f.wholeWord }
}

/** A message when the current form cannot be searched (empty text, invalid or unsupported regular expression). */
export function formProblem(f: SearchForm): string | null {
  if (f.mode === 'literal') return f.query.trim() ? null : 'Type the text to look for.'
  if (f.mode === 'regex') {
    if (!f.regex) return 'Type a regular expression.'
    const v = validateRegex(f.regex, f.caseSensitive ? 'u' : 'iu')
    if (v.ok) return null
    const plain = validateRegex(f.regex, f.caseSensitive ? '' : 'i')
    return plain.ok ? null : v.message
  }
  return null
}

const sameRect = (a: Rect, b: Rect): boolean => Math.abs(a.x0 - b.x0) < 0.5 && Math.abs(a.y0 - b.y0) < 0.5 && Math.abs(a.x1 - b.x1) < 0.5 && Math.abs(a.y1 - b.y1) < 0.5

/** Searches the document and fills the review list; hits that are already marked show as marked. */
export async function runSearch(docId: string, form: SearchForm): Promise<void> {
  const store = useRedact.getState()
  const problem = formProblem(form)
  if (problem) {
    store.setSearching(docId, false, problem)
    return
  }
  const ctl = { aborted: false }
  controllers.set(docId, ctl)
  store.setSearching(docId, true)
  try {
    const d = await pdfFor(docId)
    if (!d) {
      store.setSearching(docId, false, 'This document is password protected. Unlock it to search it.')
      return
    }
    // compileMatcher validates presets and custom patterns; errors are shown to the user
    compileMatcher(matcherOf(form))
    const n = d.pdf.getPageCount()
    const from = Math.max(1, form.from || 1)
    const to = Math.min(n, form.to || n)
    const pages: number[] = []
    for (let p = from; p <= to; p++) pages.push(p - 1)
    if (pages.length === 0) {
      store.setSearching(docId, false, 'The page range is empty.')
      return
    }
    const hits = await searchDocument(d.pdf, matcherOf(form), { pages, signal: ctl })
    if (ctl.aborted) {
      store.setSearching(docId, false)
      return
    }
    const existing = useRedact.getState().docs[docId]?.marks ?? []
    const results: SearchResult[] = hits.map((h) => {
      const twin = existing.find((m) => m.pageIndex === h.pageIndex && m.rects.length === h.rects.length && m.rects.every((r, i) => sameRect(r, h.rects[i])))
      return { id: twin?.id ?? newId('r'), pageIndex: h.pageIndex, text: h.text, rects: h.rects, quads: h.quads, hiddenOnly: h.hiddenOnly, decision: twin ? 'accepted' : 'pending' }
    })
    const pagesHit = new Set(results.map((r) => r.pageIndex)).size
    const label = results.length === 0 ? 'No matches found.' : `${results.length} ${results.length === 1 ? 'match' : 'matches'} on ${pagesHit} ${pagesHit === 1 ? 'page' : 'pages'}.`
    store.setResults(docId, results, label)
    store.announce(label)
  } catch (e) {
    store.setSearching(docId, false, e instanceof RegexBudgetError ? e.message : e instanceof Error ? e.message : String(e))
  } finally {
    if (controllers.get(docId) === ctl) controllers.delete(docId)
  }
}
