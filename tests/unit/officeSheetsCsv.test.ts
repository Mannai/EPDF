import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { detectDelimiter, parseCsv } from '../../src/main/features/create/office/csv'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const conv = (name: string, text: string | Uint8Array, page?: { width: number; height: number }) =>
  convertOffice({ name, bytes: typeof text === 'string' ? enc(text) : text }, { fontsDir, page })

describe('csv parsing', () => {
  it('handles quotes, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b,c\r\n1,"x,y","he said ""hi"""\r\n"multi\nline",2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x,y', 'he said "hi"'],
      ['multi\nline', '2', '3']
    ])
    expect(parseCsv('a,,c\n', ',')).toEqual([['a', '', 'c']])
    expect(parseCsv('"",x', ',')).toEqual([['', 'x']])
    expect(parseCsv('', ',')).toEqual([])
  })
  it('detects the delimiter', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a|b\n1|2\n3|4')).toBe('|')
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('one column\nonly')).toBe(',')
  })
})

describe('csv conversion', () => {
  it('renders a bold header and right-aligned numbers, all text in row order', async () => {
    const r = await conv('data.csv', 'Name,Qty,Price\nApple,3,1.25\nPear,12,0.5\n"Big, ""quoted"" cell",7,100')
    expect(r.pages).toBe(1)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    expect(pages[0].text).toContain('Name')
    const flat = flattenText(pages)
    expect(flat).toContain('Name Qty Price Apple 3 1.25 Pear 12 0.5')
    expect(flat).toContain('Big, "quoted" cell')
    expect(embeddedFonts.some((x) => /Liberation/.test(x))).toBe(true)
    const qty3 = pages[0].items.find((i) => i.str === '3')!
    const qty12 = pages[0].items.find((i) => i.str === '12')!
    // numbers are right aligned: their right edges line up
    const right = (i: { x: number; str: string; size: number }): number => i.x + i.str.length * i.size * 0.55
    expect(Math.abs(right(qty3) - right(qty12))).toBeLessThan(qty12.size)
    const header = pages[0].items.find((i) => i.str === 'Name')!
    expect(/Bold/i.test(header.font)).toBe(true)
  })

  it('repeats the header row on every page and never loses a cell on long files', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `row${i + 1},value ${i + 1},${(i + 1) * 3}`)
    const r = await conv('long.csv', ['Key,Label,Amount', ...rows].join('\n'), { width: 612, height: 792 })
    expect(r.pages).toBeGreaterThan(20)
    const { pages } = await readPdf(r.bytes)
    for (const p of pages) expect(p.text).toContain('Key')
    const flat = flattenText(pages)
    for (const i of [1, 2, 777, 1500, 2000]) {
      expect(flat).toContain(`row${i} value ${i} ${i * 3}`)
    }
    // every data row appears exactly once
    const seen = flat.match(/row\d+/g) ?? []
    expect(seen.length).toBe(2000)
    expect(new Set(seen).size).toBe(2000)
  }, 60000)

  it('uses landscape and shrinks (down to 60%) for wide tables, paginating columns beyond that', async () => {
    const cols = Array.from({ length: 6 }, (_, i) => `Column ${i + 1}`)
    const wide = [cols.join(','), cols.map((_, i) => `cell number ${i + 1} with some text`).join(',')].join('\n')
    const r = await conv('wide.csv', wide)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeGreaterThan(pages[0].height) // landscape
    expect(pages.length).toBe(1)
    const many = Array.from({ length: 40 }, (_, i) => `Heading ${i + 1}`)
    const veryWide = [many.join(','), many.map((_, i) => `value ${i + 1}`).join(',')].join('\n')
    const r2 = await conv('verywide.csv', veryWide)
    expect(r2.pages).toBeGreaterThan(1)
    const flat = flattenText((await readPdf(r2.bytes)).pages)
    for (let i = 1; i <= 40; i++) expect(flat).toContain(`Heading ${i}`)
  })

  it('wraps long cells instead of cutting them, and handles ragged rows, semicolons and a BOM', async () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(30).trim()
    const r = await conv('mixed.csv', `﻿a;b;c\n${long};2\nshort`)
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    // lines of a wrapped cell interleave with other cells of the same row in text order, so count words
    expect((flat.match(/lorem/g) ?? []).length).toBe(30)
    expect((flat.match(/amet/g) ?? []).length).toBe(30)
    expect(flat).toContain('short')
    expect(flat).toContain('a b c')
  })

  it('rejects an empty file with a clear message', async () => {
    await expect(conv('empty.csv', '  \n')).rejects.toThrow(/empty/)
  })

  it('shows page numbers in the footer', async () => {
    const r = await conv('pn.csv', ['h1,h2', ...Array.from({ length: 200 }, (_, i) => `${i},x`)].join('\n'))
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].text).toContain(`1 / ${pages.length}`)
    expect(pages[pages.length - 1].text).toContain(`${pages.length} / ${pages.length}`)
  })
})
