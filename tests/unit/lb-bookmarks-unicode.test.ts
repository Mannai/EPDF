import { PDFDict, PDFHexString, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { BmNode } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { addBookmark, addBookmarkTree, renameBookmark } from '../../src/renderer/src/features/bookmarks/pdf/ops'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import { allNodes, ancestorsOf, currentBookmark, flatten, searchKey, visibleAncestor } from '../../src/renderer/src/features/bookmarks/rows'
import { pdfjsOutline } from './helpers/lbPdfjs'
import { makeDoc, reload } from './pdfTestUtils'

const cc = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('')

const TITLES: Record<string, string> = {
  arabicTashkeel: 'اَلْفَصْلُ الْأَوَّلُ: مُقَدِّمَةٌ',
  arabicPlain: 'الفصل الثاني - المفاهيم الأساسية',
  hebrewNiqqud: 'שָׁלוֹם עוֹלָם',
  hebrewPlain: 'תוכן עניינים',
  chinese: '第一章 概述与背景',
  japanese: 'はじめに ＆ 概要',
  korean: '서론 및 개요',
  emoji: 'Roadmap 🚀🔥 2025 👩‍💻',
  combining: `Cafe${cc(0x301)} nai${cc(0x308)}ve`,
  mixedBidi: 'Section ٣: الأمن (Security) 2024 — ملخص',
  mixedBidi2: 'תוכן – Contents – 목차 – 目录',
  rtlMarks: `${cc(0x202b)}עברית${cc(0x202c)} and ${cc(0x2067)}عربى${cc(0x2069)}`,
  latin1: 'Résumé – “quoted” € 5™',
  parens: 'f(x) = (a \\ b) )('
}

describe('bookmark titles in every script: written, saved, re-read by pdf-lib, and read by PDF.js', () => {
  it('round trips all of them through the outline operations', async () => {
    const doc = await makeDoc(3)
    addBookmarkTree(
      doc,
      Object.values(TITLES).map((title, i) => ({ title, page: { pageIndex: i % 3, tail: ['Fit'] } })),
      'replace'
    )
    const bytes = await doc.save()
    const pdf = await reload(bytes)
    expect(validateOutline(pdf)).toEqual([])
    expect(readBookmarks(pdf).roots.map((n) => n.title)).toEqual(Object.values(TITLES))
    // PDF.js decodes the same strings (it normalises nothing we care about here).
    const pjs = await pdfjsOutline(bytes)
    expect(pjs!.map((i) => i.title)).toEqual(Object.values(TITLES))
  })

  it('renaming to another script rewrites the string correctly', async () => {
    const doc = await makeDoc(2)
    const id = addBookmark(doc, { title: 'Plain ASCII', page: { pageIndex: 0, tail: ['Fit'] } })
    const bytes1 = await doc.save()
    expect((await pdfjsOutline(bytes1))![0].title).toBe('Plain ASCII')
    renameBookmark(doc, id, TITLES.arabicTashkeel)
    expect((await pdfjsOutline(await doc.save()))![0].title).toBe(TITLES.arabicTashkeel)
    renameBookmark(doc, id, 'Back to Latin é')
    expect((await pdfjsOutline(await doc.save()))![0].title).toBe('Back to Latin é')
  })

  it('uses PDFDocEncoding for Latin text and UTF-16BE (BOM FE FF) otherwise', async () => {
    const doc = await makeDoc(1)
    addBookmarkTree(doc, [{ title: 'Résumé', page: { pageIndex: 0, tail: ['Fit'] } }, { title: 'مرحبا', page: { pageIndex: 0, tail: ['Fit'] } }], 'replace')
    const pdf = await reload(await doc.save())
    const root = pdf.catalog.lookup(N('Outlines'), PDFDict)
    const first = pdf.context.lookup(root.get(N('First')) as never, PDFDict)
    const second = pdf.context.lookup(first.get(N('Next')) as never, PDFDict)
    const bytesOf = (d: PDFDict): number[] => [...(d.lookup(N('Title')) as PDFHexString).asBytes()]
    expect(bytesOf(first)).toEqual([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9]) // "Résumé" in PDFDocEncoding
    expect(bytesOf(second).slice(0, 2)).toEqual([0xfe, 0xff])
  })

  it('lone surrogates never reach the file: they become U+FFFD', async () => {
    const doc = await makeDoc(1)
    addBookmark(doc, { title: `bad ${cc(0xd83d)} half and ${cc(0xde80)} half`, page: { pageIndex: 0, tail: ['Fit'] } })
    const bytes = await doc.save()
    const title = readBookmarks(await reload(bytes)).roots[0].title
    expect(title).toBe('bad � half and � half')
    expect((await pdfjsOutline(bytes))![0].title).toBe(title)
  })

  it('control characters and line breaks in a title are cleaned; over-long titles are cut without splitting an emoji', async () => {
    const doc = await makeDoc(1)
    addBookmark(doc, { title: `one${cc(9)}two${cc(10)}three${cc(0)}four`, page: { pageIndex: 0, tail: ['Fit'] } })
    expect(readBookmarks(doc).roots[0].title).toBe('one two threefour')
    addBookmark(doc, { title: 'a' + '🚀'.repeat(700), page: { pageIndex: 0, tail: ['Fit'] } })
    const t = readBookmarks(doc).roots[1].title
    expect(t.length).toBeLessThanOrEqual(1000)
    expect(t).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('reads titles that other software wrote as UTF-8 with a BOM, UTF-16LE, or with language escapes', async () => {
    const doc = await makeDoc(1)
    addBookmarkTree(doc, [{ title: 'placeholder one', page: { pageIndex: 0, tail: ['Fit'] } }, { title: 'placeholder two', page: { pageIndex: 0, tail: ['Fit'] } }, { title: 'placeholder three', page: { pageIndex: 0, tail: ['Fit'] } }], 'replace')
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const items: PDFDict[] = []
    let cur = root.get(N('First'))
    while (cur) {
      const d = doc.context.lookup(cur as never, PDFDict)
      items.push(d)
      cur = d.get(N('Next'))
    }
    const hex = (bytes: number[]): PDFHexString => PDFHexString.of(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''))
    items[0].set(N('Title'), hex([0xef, 0xbb, 0xbf, ...Buffer.from('日本語 – ملخص', 'utf8')]))
    items[1].set(N('Title'), hex([0xff, 0xfe, 0x45, 0x06, 0x41, 0x00])) // UTF-16LE: م A
    items[2].set(N('Title'), hex([0xfe, 0xff, 0x00, 0x1b, 0x00, 0x65, 0x00, 0x6e, 0x00, 0x1b, 0x00, 0x48, 0x00, 0x69])) // ESC en ESC "Hi"
    expect(readBookmarks(doc).roots.map((n) => n.title)).toEqual(['日本語 – ملخص', 'مA', 'Hi'])
  })
})

const N = (s: string): PDFName => PDFName.of(s)

// ---------------------------------------------------------------- the panel's view logic

const node = (title: string, page: number | null, children: BmNode[] = [], open = true): BmNode => ({
  id: title,
  title,
  target: page === null ? { kind: 'none' } : { kind: 'page', dest: { pageIndex: page, tail: ['Fit'] }, via: 'dest' },
  targetChanged: false,
  open,
  bold: false,
  italic: false,
  color: null,
  children
})

describe('bookmark panel view logic', () => {
  const roots = [
    node('Intro', 0, [node('Background', 1), node(TITLES.arabicTashkeel, 1), node('Scope', 2)]),
    node(TITLES.hebrewNiqqud, 3),
    node('Part 3', 4, [node('Deep', 5, [node('Deeper', 6)], false)], false),
    node('Heading only', null, [node('Child of heading', 8)]),
    node('Last', 9)
  ]

  it('flattens by expand state with correct levels, set sizes and positions', () => {
    const rows = flatten(roots, { isOpen: (n) => n.open })
    expect(rows.map((r) => [r.node.title, r.depth, r.posInSet, r.setSize])).toEqual([
      ['Intro', 0, 1, 5],
      ['Background', 1, 1, 3],
      [TITLES.arabicTashkeel, 1, 2, 3],
      ['Scope', 1, 3, 3],
      [TITLES.hebrewNiqqud, 0, 2, 5],
      ['Part 3', 0, 3, 5],
      ['Heading only', 0, 4, 5],
      ['Child of heading', 1, 1, 1],
      ['Last', 0, 5, 5]
    ])
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: true, parentId: null })
    expect(rows[5]).toMatchObject({ hasChildren: true, expanded: false })
    expect(flatten(roots, { isOpen: () => true }).length).toBe(11)
    expect(flatten(roots, { isOpen: () => false }).map((r) => r.node.title)).toEqual(['Intro', TITLES.hebrewNiqqud, 'Part 3', 'Heading only', 'Last'])
  })

  it('the filter matches regardless of case and diacritics, shows ancestors of matches, and renumbers siblings', () => {
    const q = (s: string): string[] => flatten(roots, { isOpen: () => false, filter: s }).map((r) => r.node.title)
    expect(q('DEEP')).toEqual(['Part 3', 'Deep', 'Deeper'])
    expect(q('الفصل الاول')).toEqual(['Intro', TITLES.arabicTashkeel]) // no tashkeel, plain alef
    expect(q('שלום')).toEqual([TITLES.hebrewNiqqud])
    expect(q('cafe')).toEqual([])
    expect(q('  scope ')).toEqual(['Intro', 'Scope'])
    const rows = flatten(roots, { isOpen: () => false, filter: 'deep' })
    expect(rows.map((r) => [r.node.title, r.posInSet, r.setSize, r.matches])).toEqual([['Part 3', 1, 1, false], ['Deep', 1, 1, true], ['Deeper', 1, 1, true]])
    expect(flatten(roots, { isOpen: () => false, filter: 'nothing like this' })).toEqual([])
  })

  it('search keys ignore combining marks, case, compatibility forms', () => {
    expect(searchKey(TITLES.arabicTashkeel)).toBe(searchKey('الفصل الأول: مقدمة'))
    expect(searchKey(TITLES.hebrewNiqqud)).toBe('שלום עולם')
    expect(searchKey('Résumé')).toBe('resume')
    expect(searchKey(TITLES.combining)).toBe('cafe naive')
    expect(searchKey('ﻻ')).toBe(searchKey('لا')) // Arabic ligature presentation form
    expect(searchKey('ＡＢＣ')).toBe('abc')
  })

  it('the current-position bookmark: first on the current page, else the last before it', () => {
    const cur = (p: number): string | undefined => currentBookmark(roots, p)?.title
    expect(cur(0)).toBe('Intro')
    expect(cur(1)).toBe('Background')
    expect(cur(2)).toBe('Scope')
    expect(cur(3)).toBe(TITLES.hebrewNiqqud)
    expect(cur(6)).toBe('Deeper')
    expect(cur(7)).toBe('Deeper') // between bookmarks: the last one before
    expect(cur(9)).toBe('Last')
    expect(currentBookmark([node('Later', 5)], 2)).toBeNull() // the outline starts after the current page
  })

  it('a bookmark inside a collapsed branch is shown on its nearest visible ancestor', () => {
    const rows = flatten(roots, { isOpen: (n) => n.open })
    expect(visibleAncestor(roots, rows, 'Deeper')).toBe('Part 3')
    expect(visibleAncestor(roots, rows, 'Scope')).toBe('Scope')
    expect(visibleAncestor(roots, rows, 'missing')).toBeNull()
    expect(ancestorsOf(roots, 'Deeper')).toEqual(['Part 3', 'Deep'])
    expect(allNodes(roots).length).toBe(11)
  })
})
