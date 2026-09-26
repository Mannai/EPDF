import { _electron as electron } from '@playwright/test'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomFillSync } from 'node:crypto'
import { PDFDocument, PDFName, PDFNumber, PDFOperator, StandardFonts } from 'pdf-lib'

const dir = mkdtempSync(join(tmpdir(), 'epdf-huge-'))
const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const side = 400 // 400x400 RGB = 480 KB of random data per page
for (let i = 1; i <= 320; i++) {
  const page = pdf.addPage([612, 792])
  const data = new Uint8Array(side * side * 3); randomFillSync(data)
  const ref = pdf.context.register(pdf.context.stream(data, { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }))
  page.node.setXObject(PDFName.of('Im0'), ref)
  page.drawText(`Huge document page ${i}`, { x: 50, y: 740, size: 14, font })
  page.pushOperators(PDFOperator.of('q'), PDFOperator.of('cm', [PDFNumber.of(500), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(600), PDFNumber.of(56), PDFNumber.of(60)]), PDFOperator.of('Do', [PDFName.of('Im0')]), PDFOperator.of('Q'))
}
const file = join(dir, 'huge.pdf')
writeFileSync(file, await pdf.save({ useObjectStreams: false }))
console.log('generated', (statSync(file).size / 1048576).toFixed(0), 'MB,', 320, 'pages')

const exe = process.argv[2] ? resolve(process.argv[2]) : null
for (let run = 1; run <= 3; run++) {
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [file] } : { args: ['.', file] }), env: { ...process.env, EPDF_USER_DATA: mkdtempSync(join(dir, 'p-')), ELECTRON_RENDERER_URL: '' } })
  const page = await app.firstWindow()
  const start = await app.evaluate(() => Date.now() - process.uptime() * 1000)
  await page.waitForFunction(() => performance.getEntriesByName('epdf:first-page-painted').length > 0, null, { timeout: 60000 })
  const t = await page.evaluate((s) => performance.timeOrigin + performance.getEntriesByName('epdf:first-page-painted')[0].startTime - s, start)
  // scroll far into the document and wait for a far page to paint
  await page.getByLabel('Page number').fill('300'); await page.getByLabel('Page number').press('Enter')
  const t1 = Date.now(); await page.locator('[data-page="300"] canvas').waitFor({ timeout: 30000 }); const jump = Date.now() - t1
  await page.waitForTimeout(1500)
  const mem = await app.evaluate(({ app }) => app.getAppMetrics().reduce((n, m) => n + (m.memory.workingSetSize || 0), 0) / 1024)
  console.log(`run ${run}: first page ${Math.round(t)} ms | jump to page 300 painted in ${jump} ms | total app memory ${mem.toFixed(0)} MB`)
  await app.close().catch(() => {})
}
