import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { launch as rawLaunch, menuClick, quitDiscarding } from './helpers'
import { buildPageText } from '../../src/shared/pagetext'
import { docxDocument, T, TXT, xlsxDocument, SHEET } from '../support/arabicCorpus'

/**
 * Arabic Office documents through the real app: File > Create PDF from File… with the built-in converter (worker
 * thread, bundled fonts and HarfBuzz from the built app). The saved PDF is read back with the page text model, and the
 * viewer's text layer (the model-based layer for right-to-left pages) shows the logical text.
 */

let work: string
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-rtl-'))
})
test.afterAll(() => rmSync(work, { recursive: true, force: true }))

async function stubDialogs(app: ElectronApplication, files: string[], saves: string[]): Promise<void> {
  await app.evaluate(({ dialog }, c) => {
    const saves = [...c.saves]
    ;(dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: c.files })
    ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async () => {
      const next = saves.shift()
      return { canceled: !next, filePath: next }
    }
  }, { files, saves })
}

const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

async function modelLines(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(new Uint8Array(readFileSync(path)), { updateMetadata: false })
  const out: string[] = []
  pdf.getPages().forEach((_, i) => {
    const m = buildPageText(pdf, i)
    for (const l of m.lines) out.push(norm(m.text.slice(l.start, l.end)))
  })
  return out
}

test('Arabic DOCX, XLSX and TXT become PDFs that read back in logical order, and the viewer shows the logical text', async () => {
  test.setTimeout(240_000)
  const dir = join(work, 'in')
  mkdirSync(dir, { recursive: true })
  const cases = [
    { name: 'arabic.docx', bytes: docxDocument().bytes, lines: [T.title, T.p2a + T.p2b + T.p2c, `1. ${T.steps[0]}`, T.header], layer: T.title },
    { name: 'arabic.xlsx', bytes: xlsxDocument().bytes, lines: [SHEET.header[0]!, SHEET.note], layer: SHEET.header[0]! },
    { name: 'arabic.txt', bytes: new TextEncoder().encode(TXT.join('\n')), lines: [TXT[0]!, TXT[2]!, TXT[3]!], layer: TXT[0]! }
  ]
  const { app, page } = await rawLaunch({ env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } })
  try {
    await expect(page.getByRole('button', { name: 'Open PDF', exact: true }).first()).toBeVisible({ timeout: 30_000 })
    for (const c of cases) {
      const src = join(dir, c.name)
      writeFileSync(src, c.bytes)
      const target = join(work, `${c.name}.pdf`)
      await stubDialogs(app, [src], [target])
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = page.getByRole('dialog', { name: 'Create PDF from files' })
      await expect(dlg).toBeVisible()
      await expect(dlg.getByLabel(/Built-in converter/)).toBeChecked()
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('tab', { name: new RegExp(`${c.name.replace('.', '\\.')}\\.pdf`) })).toBeVisible({ timeout: 90_000 })
      const lines = await modelLines(target)
      for (const l of c.lines) expect(lines, `${c.name}: ${l}`).toContain(norm(l))
      // the viewer: right-to-left pages get the logical-order text layer
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText(c.layer, { timeout: 30_000 })
    }
  } finally {
    await quitDiscarding(app, page)
  }
})
