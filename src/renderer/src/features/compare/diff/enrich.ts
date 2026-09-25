import { charMarks, type Mark } from './charDiff'
import type { Change, Loc, PageModel } from './types'

/** Attaches the readable text (with character-level marks) to a structural change. */

export interface ChangeText {
  /** Text of the old side from the first to the last changed word ('' for an addition). */
  oldText: string
  newText: string
  /** Character ranges of `oldText` that were removed / of `newText` that were added. */
  oldMarks: Mark[]
  newMarks: Mark[]
  /** A few unchanged words before and after, for orientation in the list. */
  before: string
  after: string
}

const CONTEXT_WORDS = 4

interface Built {
  /** Text of the span. */
  text: string
  /** Text of the changed words only (parts joined by a space) and, per character, its offset in `text`. */
  changed: string
  toText: number[]
}

function build(page: PageModel, loc: Loc): Built {
  const inPart = new Uint8Array(Math.max(0, loc.span[1] - loc.span[0]))
  for (const [s, e] of loc.parts) for (let i = s; i < e; i++) inPart[i - loc.span[0]] = 1
  let text = ''
  let changed = ''
  const toText: number[] = []
  for (let i = loc.span[0]; i < loc.span[1]; i++) {
    const w = page.text[i] ?? ''
    if (text) text += ' '
    const start = text.length
    text += w
    if (inPart[i - loc.span[0]]) {
      if (changed) {
        changed += ' '
        toText.push(start - 1)
      }
      for (let k = 0; k < w.length; k++) toText.push(start + k)
      changed += w
    }
  }
  return { text, changed, toText }
}

const wordsAround = (page: PageModel | undefined, from: number, to: number): [string, string] => {
  if (!page) return ['', '']
  const before = page.text.slice(Math.max(0, from - CONTEXT_WORDS), Math.max(0, from)).join(' ')
  const after = page.text.slice(Math.min(page.text.length, to), Math.min(page.text.length, to + CONTEXT_WORDS)).join(' ')
  return [before, after]
}

const mapMarks = (marks: Mark[], toText: number[]): Mark[] =>
  marks
    .map(([s, e]): Mark => [toText[s] ?? 0, (toText[e - 1] ?? toText[toText.length - 1] ?? 0) + 1])
    .filter(([s, e]) => e > s)

/** Text and marks for one change; `oldPage` / `newPage` are the models of the pages the change is on. */
export function changeText(c: Change, oldPage: PageModel | undefined, newPage: PageModel | undefined): ChangeText {
  const o = c.old && oldPage ? build(oldPage, c.old) : null
  const n = c.new && newPage ? build(newPage, c.new) : null
  let oldMarks: Mark[] = []
  let newMarks: Mark[] = []
  if (c.kind === 'removed' && o) oldMarks = o.text ? [[0, o.text.length]] : []
  else if (c.kind === 'added' && n) newMarks = n.text ? [[0, n.text.length]] : []
  else if ((c.kind === 'modified' || c.kind === 'moved') && o && n) {
    if (c.kind === 'modified' || c.edited) {
      const cm = charMarks(o.changed, n.changed)
      oldMarks = mapMarks(cm.a, o.toText)
      newMarks = mapMarks(cm.b, n.toText)
    }
  }
  const ref = c.new && newPage ? wordsAround(newPage, c.new.span[0], c.new.span[1]) : c.old && oldPage ? wordsAround(oldPage, c.old.span[0], c.old.span[1]) : ['', '']
  return { oldText: o?.text ?? '', newText: n?.text ?? '', oldMarks, newMarks, before: ref[0], after: ref[1] }
}

/**
 * For a modification with as many old as new words, the pairs (old word, new word) that differ, so the page
 * overlay can mark the characters inside them. Empty when the words do not line up one to one.
 */
export function pairedWords(c: Change): [number, number][] {
  if (c.kind !== 'modified' || !c.old || !c.new) return []
  const o = c.old.parts.flatMap(([s, e]) => Array.from({ length: e - s }, (_, i) => s + i))
  const n = c.new.parts.flatMap(([s, e]) => Array.from({ length: e - s }, (_, i) => s + i))
  if (o.length !== n.length) return []
  return o.map((w, i): [number, number] => [w, n[i]])
}
