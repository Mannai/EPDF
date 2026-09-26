import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { flattenText, readPdf } from '../support/pdfText'
import { logFidelity } from '../support/fidelity'
import { XF, buildXlsx, row, worksheet } from '../support/xlsxBuilder'
import { buildOds, tcell, trow } from '../support/odsBuilder'

/**
 * Optional cross-check against a real LibreOffice: the same fixtures are converted by soffice and by the
 * built-in engine, and page counts / text are compared broadly. Skipped when LibreOffice is not installed.
 */
const SOFFICE = process.env['EPDF_TOOL_SOFFICE'] || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
const have = existsSync(SOFFICE)

async function withSoffice(name: string, bytes: Uint8Array): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-lo-'))
  try {
    const file = join(dir, name)
    writeFileSync(file, bytes)
    const out = join(dir, 'out')
    execFileSync(SOFFICE, [`-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', out, file], { timeout: 120000, windowsHide: true })
    return new Uint8Array(readFileSync(join(out, name.replace(/\.[^.]+$/, '.pdf'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const words = (t: string): string[] => t.split(/\s+/).filter(Boolean)

describe.skipIf(!have)('built-in spreadsheet conversion vs real LibreOffice', () => {
  it('xlsx: same text and a similar page count', async () => {
    const rows = [row(1, [{ ref: 'A1', v: 'Item', s: XF.bold }, { ref: 'B1', v: 'Amount', s: XF.bold }])]
    for (let r = 2; r <= 150; r++) rows.push(row(r, [{ ref: `A${r}`, v: `Product ${r}` }, { ref: `B${r}`, v: r * 12.5, s: XF.usd }]))
    const bytes = buildXlsx({ sheets: [{ name: 'Data', xml: worksheet({ cols: '<cols><col min="1" max="2" width="16" customWidth="1"/></cols>', rows: rows.join('') }) }] })
    const lo = await readPdf(await withSoffice('cmp.xlsx', bytes))
    const mine = await readPdf((await convertOffice({ name: 'cmp.xlsx', bytes }, { fontsDir: resolve('resources/fonts'), page: { width: 612, height: 792 } })).bytes)
    const loWords = new Set(words(flattenText(lo.pages)))
    const myWords = new Set(words(flattenText(mine.pages)))
    const missing = [...loWords].filter((w) => !myWords.has(w) && !/^\d+$/.test(w) && w !== 'Data')
    // LibreOffice adds its own header/footer ("Page 1", sheet name) by default; everything else must be present
    expect(missing.filter((w) => !/^(Page|of|Data)$/.test(w))).toEqual([])
    expect(Math.abs(lo.pages.length - mine.pages.length)).toBeLessThanOrEqual(1)
    console.log(`[LibreOffice comparison] xlsx pages: LibreOffice=${lo.pages.length} built-in=${mine.pages.length}`)
    logFidelity('xlsx', mine.pages, lo.pages)
  }, 180000)

  it('ods: same text and a similar page count', async () => {
    const rows = Array.from({ length: 140 }, (_, i) => trow(tcell(`Line ${i + 1}`) + tcell(i * 3))).join('')
    const bytes = buildOds({ tables: [{ name: 'Sheet1', xml: '<table:table-column table:style-name="co1" table:number-columns-repeated="2"/>' + rows }] })
    const lo = await readPdf(await withSoffice('cmp.ods', bytes))
    const mine = await readPdf((await convertOffice({ name: 'cmp.ods', bytes }, { fontsDir: resolve('resources/fonts') })).bytes)
    const myFlat = flattenText(mine.pages)
    for (const i of [1, 70, 140]) expect(myFlat).toContain(`Line ${i}`)
    expect(flattenText(lo.pages)).toContain('Line 70')
    console.log(`[LibreOffice comparison] ods pages: LibreOffice=${lo.pages.length} built-in=${mine.pages.length}`)
    logFidelity('ods', mine.pages, lo.pages)
    expect(Math.abs(lo.pages.length - mine.pages.length)).toBeLessThanOrEqual(2)
  }, 180000)

  it('csv: same text and a similar page count', async () => {
    const csv = ['id,name,value', ...Array.from({ length: 160 }, (_, i) => `${i + 1},item ${i + 1},${(i + 1) * 7}`)].join('\n')
    const bytes = new TextEncoder().encode(csv)
    const lo = await readPdf(await withSoffice('cmp.csv', bytes))
    const mine = await readPdf((await convertOffice({ name: 'cmp.csv', bytes }, { fontsDir: resolve('resources/fonts') })).bytes)
    for (const i of [1, 80, 160]) expect(flattenText(mine.pages)).toContain(`item ${i}`)
    expect(flattenText(lo.pages)).toContain('item 80')
    console.log(`[LibreOffice comparison] csv pages: LibreOffice=${lo.pages.length} built-in=${mine.pages.length}`)
    logFidelity('csv', mine.pages, lo.pages)
  }, 180000)
})
