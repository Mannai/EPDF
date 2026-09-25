/**
 * Text helpers shared by the indexer (worker), the search (main) and the UI. Everything here is pure.
 *
 * Indexing model: page text goes into an FTS5 table with the `unicode61` tokenizer (case- and
 * diacritic-insensitive). That tokenizer does not split CJK text into words, so before indexing (and when
 * building a query) every Han/Kana character is surrounded by spaces: a phrase query then finds any run of
 * CJK characters, i.e. substring search for CJK.
 */

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}'
const CJK_RE = new RegExp(`[${CJK_CLASS}]`, 'gu')
const CJK_SPACED_RE = new RegExp(`([${CJK_CLASS}]) (?=[${CJK_CLASS}])`, 'gu')

/** Marks the start / end of a highlighted range in the raw text FTS5's `snippet()` returns. */
export const MARK_START = '\u0001'
export const MARK_END = '\u0002'

// Like CJK_SPACED_RE, but tolerant of highlight markers around the padding space.
const SNIPPET_CJK_SPACED_RE = new RegExp(`([${CJK_CLASS}])(${MARK_END}?) (${MARK_START}?)(?=[${CJK_CLASS}])`, 'gu')

// Bidi overrides/isolates, zero-width characters and BOM: invisible, and used to make one file name look like another.
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁩﻿]/g
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** Lowercase, accent-free, compatibility-folded form used for name matching. */
export function normalizeKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(INVISIBLE_RE, '')
}

/** Splits a query into lowercase, accent-free words (used for the "search by file name" box). */
export function nameTokens(query: string): string[] {
  return normalizeKey(query)
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 12)
}

/** Text safe to show (as React text; never as HTML): no control/bidi/zero-width characters, bounded length. */
export function sanitizeDisplay(s: string, max = 300): string {
  const clean = s.replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export const hasCjk = (s: string): boolean => new RegExp(`[${CJK_CLASS}]`, 'u').test(s)

/** Surrounds each Han/Kana character with spaces so the FTS tokenizer sees one token per character. */
export function spaceCjk(s: string): string {
  return hasCjk(s) ? s.replace(CJK_RE, ' $& ').replace(/[ \t]{2,}/g, ' ') : s
}

/** Undoes `spaceCjk` for display: a space between two CJK characters is removed. */
export function unspaceCjk(s: string): string {
  return s.replace(CJK_SPACED_RE, '$1')
}

/**
 * Cleans one page of extracted text for storage: compatibility-folded (ligatures such as "ﬁ" become "fi"),
 * control characters and our snippet markers removed, whitespace collapsed, CJK spaced for the tokenizer.
 */
export function prepareIndexText(raw: string): string {
  const folded = raw.normalize('NFKC').replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ')
  return spaceCjk(folded.replace(/\s+/g, ' ').trim())
}

export interface SnippetPart {
  text: string
  hit: boolean
}

/**
 * Turns the raw output of `snippet(table, 0, MARK_START, MARK_END, '…', n)` into structured parts. The UI renders
 * hit parts as `<mark>` elements and everything else as plain text, so no markup from a PDF can ever reach the DOM.
 */
export function parseSnippet(raw: string, maxLength = 600): SnippetPart[] {
  // Adjacent highlighted characters (CJK) are one hit once the padding spaces are removed.
  const merged = raw
    .replace(/\s+/g, ' ')
    .replace(SNIPPET_CJK_SPACED_RE, '$1$2$3')
    .replace(new RegExp(`${MARK_END}${MARK_START}`, 'g'), '')
    .replace(INVISIBLE_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000\u0003-\u001F\u007F-\u009F]/g, ' ')
  const parts: SnippetPart[] = []
  let hit = false
  let budget = maxLength
  for (const piece of merged.split(new RegExp(`([${MARK_START}${MARK_END}])`))) {
    if (piece === MARK_START) hit = true
    else if (piece === MARK_END) hit = false
    else if (piece.length > 0 && budget > 0) {
      const text = piece.length > budget ? piece.slice(0, budget) : piece
      budget -= text.length
      const last = parts[parts.length - 1]
      if (last && last.hit === hit) last.text += text
      else parts.push({ text, hit })
    }
  }
  return parts
}

/**
 * The text to hand to the in-document search for a content hit: the first run of highlighted words (a phrase
 * match is several adjacent hits separated only by spaces).
 */
export function highlightTerm(parts: SnippetPart[]): string {
  let out = ''
  let started = false
  for (const p of parts) {
    if (p.hit) {
      out += p.text
      started = true
    } else if (started) {
      if (p.text.trim() === '') out += ' '
      else break
    }
  }
  return out.trim()
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
