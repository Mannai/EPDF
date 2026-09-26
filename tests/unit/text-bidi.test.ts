import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeBidi, bidiClassOf, detectParagraphLevel, hasRtl, lineLevels, mirroredCodePoint, reorderVisual } from '../../src/shared/text/bidi'

/**
 * Bidi conformance: the vendored samples of the official Unicode 13.0.0 BidiTest.txt and BidiCharacterTest.txt
 * (tests/fixtures/unicode, see scripts/sample-unicode-tests.mjs for provenance) are run through our own module:
 * embedding levels from analyzeBidi(), rules L1/L2 from lineLevels()/reorderVisual().
 */

const REPRESENTATIVE: Record<string, string> = {
  L: 'a',
  R: 'א',
  AL: 'ا',
  EN: '0',
  ES: '+',
  ET: '#',
  AN: '٠',
  CS: ',',
  B: ' ',
  S: '\t',
  WS: ' ',
  ON: '!',
  BN: '­',
  NSM: '̀',
  LRE: '‪',
  RLE: '‫',
  PDF: '‬',
  LRO: '‭',
  RLO: '‮',
  LRI: '⁦',
  RLI: '⁧',
  FSI: '⁨',
  PDI: '⁩'
}
const REMOVED = new Set(['LRE', 'RLE', 'PDF', 'LRO', 'RLO', 'BN'])

/** Full L1+L2 for a single-line paragraph, skipping characters removed by X9; returns visual order of kept indices. */
function visualOrderOf(text: string, dir: 'ltr' | 'rtl' | 'auto', removed: boolean[]): { levels: (number | 'x')[]; order: number[]; paraLevel: number } {
  const info = analyzeBidi(text, dir)
  const paraLevel = info.paragraphs[0]!.level
  const lv = lineLevels(info, 0, text.length, paraLevel)
  const kept: number[] = []
  for (let i = 0; i < text.length; i++) if (!removed[i]) kept.push(i)
  const perm = reorderVisual(kept.map((i) => lv[i]!))
  return { levels: Array.from(info.levels, (l, i) => (removed[i] ? 'x' : l)), order: perm.map((k) => kept[k]!), paraLevel }
}

describe('BidiTest.txt sample (class sequences)', () => {
  const lines = readFileSync('tests/fixtures/unicode/BidiTest.sample.txt', 'utf8').split('\n')
  let levels: string[] = []
  let reorder: number[] = []
  let checked = 0
  const failures: string[] = []
  for (const line of lines) {
    if (line.startsWith('@Levels:')) levels = line.slice(8).trim().split(/\s+/)
    else if (line.startsWith('@Reorder:')) reorder = line.slice(9).trim() === '' ? [] : line.slice(9).trim().split(/\s+/).map(Number)
    else if (line.startsWith('#') || !line.trim()) continue
    else {
      const [cls, bits] = line.split(';')
      const types = cls!.trim().split(/\s+/)
      if (types.includes('B') && types.indexOf('B') !== types.length - 1) continue // multi-paragraph lines are out of scope for single-line reordering
      const text = types.map((t) => REPRESENTATIVE[t]!).join('')
      const removed = types.map((t) => REMOVED.has(t))
      const mask = Number(bits!.trim())
      for (const [bit, dir] of [[1, 'auto'], [2, 'ltr'], [4, 'rtl']] as const) {
        if (!(mask & bit)) continue
        const r = visualOrderOf(text, dir, removed)
        checked++
        const gotLevels = r.levels.map(String)
        if (gotLevels.join(' ') !== levels.join(' ') || r.order.join(' ') !== reorder.join(' ')) {
          if (failures.length < 8) failures.push(`${types.join(' ')} [${dir}] expected levels ${levels.join(' ')} order ${reorder.join(' ')}, got ${gotLevels.join(' ')} / ${r.order.join(' ')}`)
        }
      }
    }
  }
  it('checks thousands of official cases', () => {
    expect(checked).toBeGreaterThan(5000)
  })
  it('matches every official level and reordering', () => {
    expect(failures).toEqual([])
  })
})

describe('BidiCharacterTest.txt sample (real code points, brackets, isolates)', () => {
  const lines = readFileSync('tests/fixtures/unicode/BidiCharacterTest.sample.txt', 'utf8').split('\n')
  const failures: string[] = []
  let checked = 0
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue
    const [cps, dirCode, paraLevel, lvls, ord] = line.split(';')
    const text = String.fromCodePoint(...cps!.trim().split(/\s+/).map((h) => parseInt(h, 16)))
    const expectedLevels = lvls!.trim().split(/\s+/)
    const expectedOrder = ord!.trim() === '' ? [] : ord!.trim().split(/\s+/).map(Number)
    const dir = dirCode === '0' ? 'ltr' : dirCode === '1' ? 'rtl' : 'auto'
    const info = analyzeBidi(text, dir)
    // Levels are per UTF-16 unit for us; the vectors are per code point.
    const cpIndex: number[] = [] // unit index of each code point start
    for (let i = 0; i < text.length; i++) {
      cpIndex.push(i)
      const c = text.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) i++
    }
    const removed = cpIndex.map((_, k) => expectedLevels[k] === 'x')
    const lv = lineLevels(info, 0, text.length, info.paragraphs[0]!.level)
    const keptIdx = cpIndex.map((_, k) => k).filter((k) => !removed[k])
    const perm = reorderVisual(keptIdx.map((k) => lv[cpIndex[k]!]!))
    const order = perm.map((p) => keptIdx[p]!)
    const gotLevels = cpIndex.map((u, k) => (removed[k] ? 'x' : String(info.levels[u])))
    checked++
    if (
      String(info.paragraphs[0]!.level) !== paraLevel!.trim() ||
      gotLevels.join(' ') !== expectedLevels.join(' ') ||
      order.join(' ') !== expectedOrder.join(' ')
    ) {
      if (failures.length < 8) failures.push(`${cps!.trim()} dir=${dirCode}: expected p${paraLevel} ${expectedLevels.join(' ')} / ${expectedOrder.join(' ')}, got p${info.paragraphs[0]!.level} ${gotLevels.join(' ')} / ${order.join(' ')}`)
    }
  }
  it('checks hundreds of official cases', () => {
    expect(checked).toBeGreaterThan(2000)
  })
  it('matches every official paragraph level, level and reordering', () => {
    expect(failures).toEqual([])
  })
})

describe('bidi helpers', () => {
  it('auto direction follows the first strong character', () => {
    expect(detectParagraphLevel('hello مرحبا')).toBe(0)
    expect(detectParagraphLevel('مرحبا hello')).toBe(1)
    expect(detectParagraphLevel('123 مرحبا')).toBe(1)
    expect(detectParagraphLevel('   ')).toBe(0)
  })
  it('reorders a mixed line visually', () => {
    // "abc אבג def" in an LTR paragraph: the Hebrew run reads right to left.
    const info = analyzeBidi('abc אבג def', 'ltr')
    const perm = reorderVisual(lineLevels(info, 0, 11, 0))
    expect(perm.map((i) => 'abc אבג def'[i]).join('')).toBe('abc גבא def')
  })
  it('numbers keep their order inside right-to-left text', () => {
    const t = 'مرحبا 123 عالم'
    const info = analyzeBidi(t, 'auto')
    expect(info.paragraphs[0]!.level).toBe(1)
    const perm = reorderVisual(lineLevels(info, 0, t.length, 1))
    const visual = perm.map((i) => t[i]).join('')
    expect(visual).toBe('ملاع 123 ابحرم')
  })
  it('trailing whitespace goes back to the paragraph level (rule L1)', () => {
    const t = 'אב  '
    const info = analyzeBidi(t, 'ltr')
    expect(Array.from(lineLevels(info, 0, t.length, 0))).toEqual([1, 1, 0, 0])
  })
  it('classifies astral characters instead of treating surrogates as strong LTR', () => {
    // U+1E900 ADLAM CAPITAL LETTER ALIF is right-to-left (R); an emoji is neutral (ON).
    const adlam = analyzeBidi('\u{1e900}\u{1e901}', 'auto')
    expect(adlam.paragraphs[0]!.level).toBe(1)
    const emoji = analyzeBidi('\u{1f600} א', 'auto')
    expect(emoji.paragraphs[0]!.level).toBe(1)
  })
  it('mirrors paired punctuation and reports bidi classes', () => {
    expect(mirroredCodePoint(0x28)).toBe(0x29)
    expect(mirroredCodePoint(0xbb)).toBe(0xab)
    expect(mirroredCodePoint(0x41)).toBeNull()
    expect(bidiClassOf('aا ', 1)).toBe('AL')
    expect(hasRtl('abc')).toBe(false)
    expect(hasRtl('abc א')).toBe(true)
  })
  it('honours explicit isolates and embeddings', () => {
    const t = 'a ⁧אב⁩ b'
    const info = analyzeBidi(t, 'ltr')
    expect(Array.from(info.levels)).toEqual([0, 0, 0, 1, 1, 0, 0, 0])
  })
})
