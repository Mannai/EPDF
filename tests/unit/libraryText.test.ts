import { describe, expect, it } from 'vitest'
import { FILE_ATTRIBUTE, icloudStubName, isPlaceholderAttributes, placeholderSuspicion, resolveSuspect } from '../../src/shared/features/library/placeholder'
import { INDEX_VERSION, isInside, planSync, relativeDir, type KnownFile, type ScanEntry } from '../../src/shared/features/library/plan'
import { buildFtsQuery, MAX_QUERY_LENGTH, MAX_QUERY_TERMS } from '../../src/shared/features/library/query'
import {
  MARK_END,
  MARK_START,
  formatBytes,
  highlightTerm,
  nameTokens,
  normalizeKey,
  parseSnippet,
  prepareIndexText,
  sanitizeDisplay,
  spaceCjk,
  unspaceCjk
} from '../../src/shared/features/library/text'
import { parseRef, RefSchema } from '../../src/shared/features/library'

const q = (s: string): string => {
  const r = buildFtsQuery(s)
  if (!r.ok) throw new Error(r.error)
  return r.match
}

describe('text normalisation', () => {
  it('folds case, accents and compatibility forms for name matching', () => {
    expect(normalizeKey('Résumé_Ünïcode.PDF')).toBe('resume_unicode.pdf')
    expect(normalizeKey('ﬁnance ＡＢＣ')).toBe('finance abc')
    expect(nameTokens('  Ünï  RAPPORT ')).toEqual(['uni', 'rapport'])
  })

  it('spaces CJK characters for the tokenizer and reverses it for display', () => {
    expect(spaceCjk('abc 日本語 def')).toBe('abc 日 本 語 def')
    expect(unspaceCjk('日 本 語 and 你 好')).toBe('日本語 and 你好')
    expect(spaceCjk('plain latin')).toBe('plain latin')
  })

  it('cleans page text: ligatures, control chars, whitespace, snippet markers', () => {
    const t = prepareIndexText(`the ﬁnal  \u0000 report\t\n${MARK_START}x${MARK_END}\u200Bend`)
    expect(t).toBe('the final report x end')
  })

  it('sanitises names for display: invisible/bidi characters and control characters are removed', () => {
    expect(sanitizeDisplay('inv\u202Eoice\u200B.pdf')).toBe('invoice.pdf')
    expect(sanitizeDisplay('a\u0007b\nc')).toBe('a b c')
    expect(sanitizeDisplay('x'.repeat(500), 20)).toHaveLength(20)
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('snippets (structured, never HTML)', () => {
  it('turns marker text into plain/hit parts', () => {
    const parts = parseSnippet(`…the ${MARK_START}annual${MARK_END} ${MARK_START}report${MARK_END} shows…`)
    expect(parts).toEqual([
      { text: '…the ', hit: false },
      { text: 'annual', hit: true },
      { text: ' ', hit: false },
      { text: 'report', hit: true },
      { text: ' shows…', hit: false }
    ])
    expect(highlightTerm(parts)).toBe('annual report')
  })

  it('never lets markup through as anything but text', () => {
    const parts = parseSnippet(`<img src=x onerror=alert(1)> ${MARK_START}<script>alert(1)</script>${MARK_END}`)
    expect(parts.map((p) => p.text).join('')).toBe('<img src=x onerror=alert(1)> <script>alert(1)</script>')
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['<script>alert(1)</script>'])
  })

  it('merges adjacent highlighted CJK characters into one hit', () => {
    const raw = `${MARK_START}世${MARK_END} ${MARK_START}界${MARK_END} 你 好`
    expect(parseSnippet(raw)).toEqual([
      { text: '世界', hit: true },
      { text: '你好', hit: false }
    ])
  })

  it('bounds the length and strips control characters', () => {
    const parts = parseSnippet('a'.repeat(5000) + '\u0007', 100)
    expect(parts.map((p) => p.text).join('').length).toBeLessThanOrEqual(100)
  })

  it('takes the first highlighted run as the in-document search term', () => {
    expect(highlightTerm(parseSnippet(`x ${MARK_START}budget${MARK_END} y ${MARK_START}forecast${MARK_END}`))).toBe('budget')
    expect(highlightTerm([{ text: 'nothing', hit: false }])).toBe('')
  })
})

describe('FTS query builder', () => {
  it('quotes plain words and ANDs them', () => {
    expect(q('annual report')).toBe('("annual" AND "report")')
    expect(q('single')).toBe('"single"')
  })

  it('supports phrases, OR, NOT, exclusion with -, prefix * and grouping', () => {
    expect(q('"annual report"')).toBe('"annual report"')
    expect(q('budget OR forecast')).toBe('("budget" OR "forecast")')
    expect(q('budget NOT draft')).toBe('("budget" NOT "draft")')
    expect(q('budget -draft')).toBe('("budget" NOT "draft")')
    expect(q('invoi*')).toBe('"invoi" *')
    expect(q('"annual rep"*')).toBe('"annual rep" *')
    expect(q('(a OR b) c')).toBe('(("a" OR "b") AND "c")')
    expect(q('a AND b')).toBe('("a" AND "b")')
  })

  it('lower-case and/or/not are ordinary words', () => {
    expect(q('cats and dogs')).toBe('("cats" AND "and" AND "dogs")')
  })

  it('neutralises FTS5 syntax: column filters, NEAR, carets, stray quotes and operators', () => {
    expect(q('text:secret')).toBe('"text:secret"')
    expect(q('NEAR(a b, 2)')).toBe('("NEAR" AND ("a" AND "b," AND "2"))')
    expect(q('^first')).toBe('"^first"')
    expect(q('say "hello')).toBe('("say" AND "hello")')
    expect(q('a" OR "b')).toBe('("a" AND "OR" AND "b")') // the quotes pair up as a phrase: OR is text here, not an operator
    expect(q('foo*bar')).toBe('"foo bar"')
    expect(q('x -')).toBe('"x"')
    expect(q("it's o'clock")).toBe('("it\'s" AND "o\'clock")')
    for (const evil of ['" OR 1=1 --', "'; DROP TABLE library_files;--", '*', '**', '""', '()', ') (', 'NOT', 'AND OR NOT', '- -', '{a b}', 'a:b:c', '"unterminated', 'x)))']) {
      const r = buildFtsQuery(evil)
      if (r.ok) expect(r.match).toMatch(/^[("\s\w*:'.=;{}\-_,ANDORT)]+$/)
    }
  })

  it('reports friendly errors for empty or exclusion-only searches', () => {
    expect(buildFtsQuery('')).toEqual({ ok: false, error: 'Type a word or phrase to search for.' })
    expect(buildFtsQuery('   ')).toMatchObject({ ok: false })
    expect(buildFtsQuery('!!! ???')).toMatchObject({ ok: false })
    expect(buildFtsQuery('-draft')).toMatchObject({ ok: false, error: expect.stringContaining('at least one word') })
    expect(buildFtsQuery('NOT draft')).toMatchObject({ ok: false })
  })

  it('handles unicode: accents, CJK runs become phrases of characters, mixed scripts', () => {
    expect(q('café')).toBe('"café"')
    expect(q('世界')).toBe('" 世  界 "'.replace(/\s+/g, ' ').replace('" ', '"').replace(' "', '"'))
    expect(q('日本語')).toBe('"日 本 語"')
    expect(q('東京 tower')).toBe('("東 京" AND "tower")')
    expect(q('ﬁnance')).toBe('"finance"')
  })

  it('bounds the query length and the number of terms', () => {
    expect(buildFtsQuery(Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, i) => `w${i}`).join(' '))).toMatchObject({ ok: false })
    expect(buildFtsQuery('word '.repeat(500))).toMatchObject({ ok: false, error: expect.stringContaining('at most') })
    const long = buildFtsQuery('x'.repeat(5000))
    expect(long.ok).toBe(true) // truncated to MAX_QUERY_LENGTH characters
    if (long.ok) expect(long.terms[0].length).toBe(MAX_QUERY_LENGTH)
  })

  it('returns the positive terms for highlighting', () => {
    const r = buildFtsQuery('"annual report" budget -draft')
    expect(r.ok && r.terms).toEqual(['annual report', 'budget'])
  })
})

describe('file references', () => {
  it('accepts only well-formed refs', () => {
    expect(parseRef('f12')).toEqual({ kind: 'file', id: 12 })
    expect(parseRef('r7')).toEqual({ kind: 'recent', id: 7 })
    for (const bad of ['f0', 'f-1', 'f01', 'x1', 'f', '', 'f1.5', 'f1 ', ' f1', 'f1e3', 'f9999999999999999999', '../etc/passwd', 'C:\\x.pdf', 5, null, undefined, {}]) {
      expect(parseRef(bad as never)).toBeNull()
    }
    expect(RefSchema.safeParse('f42').success).toBe(true)
    expect(RefSchema.safeParse('/etc/passwd').success).toBe(false)
  })
})

describe('placeholder (cloud-only) detection', () => {
  it('reads Windows attribute words', () => {
    expect(isPlaceholderAttributes(FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS | 0x20)).toBe(true)
    expect(isPlaceholderAttributes(FILE_ATTRIBUTE.RECALL_ON_OPEN)).toBe(true)
    expect(isPlaceholderAttributes(FILE_ATTRIBUTE.OFFLINE)).toBe(true)
    expect(isPlaceholderAttributes(0x20)).toBe(false) // archive only
    expect(isPlaceholderAttributes(FILE_ATTRIBUTE.SPARSE_FILE | FILE_ATTRIBUTE.REPARSE_POINT | 0x20)).toBe(false) // a pinned/local OneDrive file
    expect(isPlaceholderAttributes(-1)).toBe(false)
    expect(isPlaceholderAttributes(Number.NaN)).toBe(false)
  })

  it('flags "size but no blocks" as a suspect, never tiny (MFT-resident) files', () => {
    expect(placeholderSuspicion({ size: 500_000, blocks: 0 })).toBe('suspect')
    expect(placeholderSuspicion({ size: 500_000, blocks: 977 })).toBe('local')
    expect(placeholderSuspicion({ size: 300, blocks: 0 })).toBe('local')
    expect(placeholderSuspicion({ size: 0, blocks: 0 })).toBe('local')
    expect(placeholderSuspicion({ size: 5000 })).toBe('local') // platform without block counts
  })

  it('resolves suspects: Windows uses the attributes, elsewhere (or unknown) errs on the safe side', () => {
    expect(resolveSuspect('win32', FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS)).toBe(true)
    expect(resolveSuspect('win32', 0x20)).toBe(false)
    expect(resolveSuspect('win32', null)).toBe(true)
    expect(resolveSuspect('darwin', null)).toBe(true)
    expect(resolveSuspect('linux', null)).toBe(true)
  })

  it('recognises iCloud stub names', () => {
    expect(icloudStubName('.Report.pdf.icloud')).toBe('Report.pdf')
    expect(icloudStubName('.notes.txt.icloud')).toBeNull()
    expect(icloudStubName('Report.pdf')).toBeNull()
  })
})

const entry = (path: string, over: Partial<ScanEntry> = {}): ScanEntry => ({ path, relDir: '', name: path.split('/').pop()!, size: 100, mtime: 1000, cloud: false, ...over })
const known = (id: number, path: string, over: Partial<KnownFile> = {}): KnownFile => ({ id, path, size: 100, mtime: 1000, hash: 'h', state: 'indexed', cloud: false, indexVersion: INDEX_VERSION, hidden: false, ...over })
const MB = 1024 * 1024

describe('incremental sync planner', () => {
  it('leaves unchanged files alone, indexes new ones, notices changed and deleted ones', () => {
    const plan = planSync(
      [entry('/r/a.pdf'), entry('/r/b.pdf', { mtime: 2000 }), entry('/r/new.pdf'), entry('/r/c.pdf', { size: 101 })],
      [known(1, '/r/a.pdf'), known(2, '/r/b.pdf'), known(3, '/r/c.pdf'), known(4, '/r/gone.pdf')],
      { maxBytes: 100 * MB }
    )
    expect(plan.unchanged).toBe(1)
    expect(plan.toIndex.map((i) => [i.entry.path, i.reason])).toEqual([
      ['/r/b.pdf', 'changed'],
      ['/r/new.pdf', 'new'],
      ['/r/c.pdf', 'changed']
    ])
    expect(plan.missing.map((m) => m.path)).toEqual(['/r/gone.pdf'])
  })

  it('retries pending files and files indexed by an older extractor', () => {
    const plan = planSync([entry('/r/a.pdf'), entry('/r/b.pdf')], [known(1, '/r/a.pdf', { state: 'pending', indexVersion: 0 }), known(2, '/r/b.pdf', { indexVersion: INDEX_VERSION - 1 })], { maxBytes: 100 * MB })
    expect(plan.toIndex.map((i) => i.reason)).toEqual(['retry', 'retry'])
  })

  it('records cloud placeholders and oversized files without reading them', () => {
    const plan = planSync([entry('/r/cloud.pdf', { cloud: true }), entry('/r/huge.pdf', { size: 300 * MB })], [], { maxBytes: 200 * MB })
    expect(plan.toIndex).toEqual([])
    expect(plan.toRecord.map((r) => [r.entry.name, r.state])).toEqual([
      ['cloud.pdf', 'cloud'],
      ['huge.pdf', 'too_large']
    ])
  })

  it('indexes a placeholder once it has been downloaded, and only flags a freed-up indexed file', () => {
    const p1 = planSync([entry('/r/a.pdf')], [known(1, '/r/a.pdf', { state: 'cloud', cloud: true, hash: null })], { maxBytes: 100 * MB })
    expect(p1.toIndex.map((i) => i.reason)).toEqual(['hydrated'])
    const p2 = planSync([entry('/r/a.pdf', { cloud: true })], [known(1, '/r/a.pdf')], { maxBytes: 100 * MB })
    expect(p2.toIndex).toEqual([])
    expect(p2.toRecord).toEqual([])
    expect(p2.toFlag).toEqual([{ known: expect.objectContaining({ id: 1 }), cloud: true }])
  })

  it('honours "index anyway" and a raised size limit for oversized files', () => {
    const k = [known(1, '/r/huge.pdf', { state: 'too_large', size: 300 * MB, hash: null })]
    const e = [entry('/r/huge.pdf', { size: 300 * MB })]
    expect(planSync(e, k, { maxBytes: 200 * MB }).toIndex).toEqual([])
    expect(planSync(e, k, { maxBytes: 200 * MB, forceIds: new Set([1]) }).toIndex.map((i) => i.reason)).toEqual(['forced'])
    expect(planSync(e, k, { maxBytes: 400 * MB }).toIndex.map((i) => i.reason)).toEqual(['limit'])
  })

  it('never touches files the user removed from the library', () => {
    const plan = planSync([entry('/r/a.pdf', { mtime: 5 })], [known(1, '/r/a.pdf', { hidden: true })], { maxBytes: 100 * MB })
    expect(plan.toIndex).toEqual([])
    expect(plan.unchanged).toBe(1)
    expect(planSync([], [known(1, '/r/a.pdf', { hidden: true })], { maxBytes: 1 }).missing).toEqual([])
  })
})

describe('path helpers', () => {
  it('isInside is separator- and (optionally) case-insensitive and rejects sibling prefixes', () => {
    expect(isInside('C:\\Docs', 'C:\\Docs\\a\\b.pdf', true)).toBe(true)
    expect(isInside('C:\\Docs', 'c:/docs/a.pdf', true)).toBe(true)
    expect(isInside('C:\\Docs', 'c:/docs/a.pdf', false)).toBe(false)
    expect(isInside('/a/b', '/a/bc/x.pdf', false)).toBe(false)
    expect(isInside('/a/b', '/a/b', false)).toBe(true)
  })
  it('relativeDir', () => {
    expect(relativeDir('C:\\Docs', 'C:\\Docs\\a\\b')).toBe('a/b')
    expect(relativeDir('/r', '/r')).toBe('')
  })
})
