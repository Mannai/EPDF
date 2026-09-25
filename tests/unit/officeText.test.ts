import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice, legacyMessage } from '../../src/main/features/create/office'
import { mapFontFamily } from '../../src/main/features/create/office/fonts'
import { decodeText } from '../../src/main/features/create/office/text'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const convert = (name: string, text: string | Uint8Array, extra: Partial<Parameters<typeof convertOffice>[1]> = {}) =>
  convertOffice({ name, bytes: typeof text === 'string' ? enc(text) : text }, { fontsDir, ...extra })

describe('font mapping', () => {
  it('maps common document fonts onto the bundled metric-compatible families', () => {
    expect(mapFontFamily('Arial')).toBe('LiberationSans')
    expect(mapFontFamily('Helvetica-Bold')).toBe('LiberationSans')
    expect(mapFontFamily('Times New Roman')).toBe('LiberationSerif')
    expect(mapFontFamily('ABCDEF+TimesNewRomanPS-BoldMT')).toBe('LiberationSerif')
    expect(mapFontFamily('Courier New')).toBe('LiberationMono')
    expect(mapFontFamily('Consolas')).toBe('LiberationMono')
    expect(mapFontFamily('Calibri')).toBe('Carlito')
    expect(mapFontFamily('Cambria')).toBe('Caladea')
    expect(mapFontFamily('Georgia')).toBe('LiberationSerif')
    expect(mapFontFamily('Some Unknown Font')).toBe('LiberationSans')
    expect(mapFontFamily(undefined)).toBe('LiberationSans')
  })
})

describe('plain text conversion', () => {
  it('produces a valid PDF with the text in order and embedded subset fonts', async () => {
    const r = await convert('notes.txt', 'Hello world\nSecond line\n\nAfter a blank line')
    expect(r.pages).toBe(1)
    expect(r.warnings).toEqual([])
    const doc = await PDFDocument.load(r.bytes)
    expect(doc.getPageCount()).toBe(1)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('Hello world\nSecond line\nAfter a blank line')
    expect(embeddedFonts.some((f) => /LiberationMono/.test(f))).toBe(true)
    // the blank line leaves a gap: three line pitches between line 2 and line 4
    const ys = pages[0].items.filter((i) => i.str).map((i) => i.y)
    expect(ys[3] - ys[2]).toBeGreaterThan((ys[1] - ys[0]) * 1.8)
  })

  it('never loses text across many pages, and page size follows the request', async () => {
    const lines = Array.from({ length: 900 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog`)
    const r = await convert('long.txt', lines.join('\n'), { page: { width: 612, height: 792 } })
    expect(r.pages).toBeGreaterThan(10)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(612)
    expect(pages[0].height).toBeCloseTo(792)
    expect(flattenText(pages)).toBe(lines.join(' '))
  })

  it('wraps long paragraphs and breaks over-long words instead of dropping them', async () => {
    const long = 'word '.repeat(300).trim()
    const unbroken = 'x'.repeat(400)
    const r = await convert('wrap.txt', `${long}\n${unbroken}`)
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat.replace(/ /g, '')).toBe((long + unbroken).replace(/ /g, ''))
    for (const p of pages) for (const it of p.items) expect(it.x).toBeLessThan(p.width - 40)
  })

  it('handles tabs, form feeds, CRLF and a UTF-8 BOM', async () => {
    const r = await convert('mix.txt', '﻿col1\tcol2\r\nnext\fnew page')
    expect(r.pages).toBe(2)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].items.map((i) => i.str).join('|')).toContain('col1')
    const col2 = pages[0].items.find((i) => i.str.includes('col2'))!
    const col1 = pages[0].items.find((i) => i.str.includes('col1'))!
    expect(col2.x - col1.x).toBeGreaterThan(40) // moved to the next tab stop
    expect(pages[1].text).toBe('new page')
    expect(flattenText(pages)).toContain('col1 col2 next')
  })

  it('draws non-Latin text from the fallback fonts and warns about characters no bundled font has', async () => {
    const r = await convert('uni.txt', 'Grüße — Ελληνικά — Кириллица — € — 日本語')
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].text
    expect(t).toContain('Grüße')
    expect(t).toContain('Ελληνικά')
    expect(t).toContain('Кириллица')
    expect(t).toContain('€')
    expect(t).toContain('???')
    expect(r.warnings.join(' ')).toMatch(/not available in Epdf’s built-in fonts/)
  })

  it('an empty file still yields one blank page', async () => {
    const r = await convert('empty.txt', '')
    expect(r.pages).toBe(1)
  })

  it('decodes legacy Windows-1252 text and UTF-16', () => {
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('hi')
  })

  it('refuses old binary formats with an actionable message', async () => {
    expect(legacyMessage('old.doc')).toMatch(/save it as \.docx/)
    expect(legacyMessage('old.xls')).toMatch(/\.xlsx/)
    expect(legacyMessage('old.ppt')).toMatch(/\.pptx/)
    expect(legacyMessage('new.docx')).toBeNull()
    await expect(convert('old.doc', 'x')).rejects.toThrow(/old binary \.doc file/)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(convert('a.txt', 'hello\n'.repeat(10000), { signal: ac.signal })).rejects.toThrow('Cancelled')
  })
})
