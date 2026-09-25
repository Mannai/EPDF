import { spaceCjk } from './text'

/**
 * Turns what a person types into a safe FTS5 MATCH expression. The FTS5 query language is never exposed:
 *
 *   annual report          both words           (implicit AND)
 *   "annual report"        the exact phrase
 *   budget OR forecast     either               (AND / OR / NOT must be upper case)
 *   budget -draft          budget but not draft (NOT draft works too)
 *   invoi*                 words starting with "invoi"
 *   ( a OR b ) c           grouping
 *
 * Every word and phrase is emitted as a double-quoted FTS5 string, so column filters (`title:`), `NEAR(`, `^`,
 * `-`, `*` in the middle of a word and stray quotes are just text. Nothing the user types can change the shape
 * of the query except through the operators above.
 */

export const MAX_QUERY_LENGTH = 300
export const MAX_QUERY_TERMS = 32

export type BuiltQuery = { ok: true; match: string; terms: string[] } | { ok: false; error: string }

type Tok =
  | { k: 'open' }
  | { k: 'close' }
  | { k: 'op'; v: 'AND' | 'OR' | 'NOT' }
  | { k: 'term'; text: string; prefix: boolean; negate: boolean }

const hasWord = (s: string): boolean => /[\p{L}\p{N}]/u.test(s)

function tokenize(input: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = input.length
  const isSpace = (c: string): boolean => /\s/.test(c)
  while (i < n) {
    const c = input[i]
    if (isSpace(c)) {
      i++
    } else if (c === '(') {
      out.push({ k: 'open' })
      i++
    } else if (c === ')') {
      out.push({ k: 'close' })
      i++
    } else if (c === '"' || c === '“' || c === '”') {
      // A phrase runs to the next quote (or the end). A `*` right after the closing quote makes it a prefix.
      let j = i + 1
      while (j < n && input[j] !== '"' && input[j] !== '”' && input[j] !== '“') j++
      const text = input.slice(i + 1, j)
      let prefix = false
      i = j < n ? j + 1 : j
      if (input[i] === '*') {
        prefix = true
        while (input[i] === '*') i++
      }
      if (hasWord(text)) out.push({ k: 'term', text, prefix, negate: false })
    } else {
      let j = i
      while (j < n && !isSpace(input[j]) && input[j] !== '(' && input[j] !== ')' && input[j] !== '"') j++
      let word = input.slice(i, j)
      i = j
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        out.push({ k: 'op', v: word })
        continue
      }
      let negate = false
      while (word.startsWith('-') || word.startsWith('+')) {
        if (word.startsWith('-')) negate = true
        word = word.slice(1)
      }
      let prefix = false
      while (word.endsWith('*')) {
        prefix = true
        word = word.slice(0, -1)
      }
      // A `*` inside a word is not a wildcard: it separates words (the tokenizer would do the same).
      word = word.replace(/\*/g, ' ')
      if (hasWord(word)) out.push({ k: 'term', text: word, prefix, negate })
    }
  }
  return out
}

const quote = (text: string, prefix: boolean): string => {
  // Double quotes cannot reach here (they end a phrase), but never rely on that for safety.
  const body = spaceCjk(text.normalize('NFKC'))
    .replace(/["\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `"${body}"${prefix ? ' *' : ''}`
}

interface Parsed {
  expr: string | null
  /** Only negated operands at this level: FTS5 cannot express that. */
  onlyNegative: boolean
}

/** Builds a FTS5 MATCH string from user input; `error` explains what to fix in plain language. */
export function buildFtsQuery(input: string): BuiltQuery {
  const trimmed = input.trim().slice(0, MAX_QUERY_LENGTH)
  if (!trimmed) return { ok: false, error: 'Type a word or phrase to search for.' }
  const toks = tokenize(trimmed)
  if (toks.filter((t) => t.k === 'term').length === 0) return { ok: false, error: 'Type a word or phrase to search for.' }
  if (toks.filter((t) => t.k === 'term').length > MAX_QUERY_TERMS) return { ok: false, error: `Please use at most ${MAX_QUERY_TERMS} search words.` }

  const terms: string[] = []
  let pos = 0
  let sawOnlyNegative = false

  // orExpr := andExpr ('OR' andExpr)*
  const parseOr = (): Parsed => {
    const parts: string[] = []
    let onlyNeg = false
    for (;;) {
      const a = parseAnd()
      if (a.expr) parts.push(a.expr)
      if (a.onlyNegative) onlyNeg = true
      const t = toks[pos]
      if (t && t.k === 'op' && t.v === 'OR') {
        pos++
        continue
      }
      break
    }
    const expr = parts.length === 0 ? null : parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`
    return { expr, onlyNegative: onlyNeg && parts.length === 0 }
  }

  // andExpr := unit ((AND | NOT | nothing) unit)*   -- negated units are gathered and applied with NOT
  const parseAnd = (): Parsed => {
    const positives: string[] = []
    const negatives: string[] = []
    let pendingNot = false
    for (;;) {
      const t = toks[pos]
      if (!t || t.k === 'close' || (t.k === 'op' && t.v === 'OR')) break
      if (t.k === 'op') {
        pos++
        if (t.v === 'NOT') pendingNot = true
        continue // AND is the default
      }
      let unit: string | null = null
      if (t.k === 'open') {
        pos++
        const inner = parseOr()
        if (toks[pos]?.k === 'close') pos++
        unit = inner.expr
      } else if (t.k === 'term') {
        pos++
        unit = quote(t.text, t.prefix)
        if (!pendingNot && !t.negate) terms.push(t.text.trim())
        if (t.negate) pendingNot = true
      }
      if (unit) (pendingNot ? negatives : positives).push(unit)
      pendingNot = false
    }
    if (positives.length === 0) {
      if (negatives.length > 0) sawOnlyNegative = true
      return { expr: null, onlyNegative: negatives.length > 0 }
    }
    let expr = positives.length === 1 ? positives[0] : `(${positives.join(' AND ')})`
    for (const neg of negatives) expr = `(${expr} NOT ${neg})`
    return { expr, onlyNegative: false }
  }

  const exprs: string[] = []
  const first = parseOr()
  if (first.expr) exprs.push(first.expr)
  // A stray closing parenthesis ends the first group early: carry on with the rest as another AND-ed group.
  while (pos < toks.length) {
    pos++
    const more = parseOr()
    if (more.expr) exprs.push(more.expr)
  }
  if (exprs.length === 0) {
    return {
      ok: false,
      error: sawOnlyNegative ? 'Add at least one word that must appear, not only words to exclude.' : 'Type a word or phrase to search for.'
    }
  }
  return { ok: true, match: exprs.length === 1 ? exprs[0] : `(${exprs.join(' AND ')})`, terms }
}
