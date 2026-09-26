// Run with Electron: prints the fixture HTML with Chromium's own PDF backend (Skia) and records the box of every word
// span (CSS px -> PDF points, top-left origin) as independent ground truth for geometry checks.
//   electron tests/fixtures/pagetext/chromium.cjs <outDir>
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const html = require('./html.cjs')

const outDir = process.argv[process.argv.length - 1]
const PX_TO_PT = 72 / 96

const tmp = mkdtempSync(join(tmpdir(), 'epdf-pagetext-chromium-'))

let w = null

async function print(name, doc) {
  w ??= new BrowserWindow({ show: false, width: 794, height: 1123 })
  const file = join(tmp, `${name}.html`)
  writeFileSync(file, doc)
  await w.loadFile(file)
  await w.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  // A word split by the bidi algorithm (a date in Arabic text, "(Epdf)") has one client rect per fragment: the box
  // is their union.
  const boxes = await w.webContents.executeJavaScript(`[...document.querySelectorAll('span.w')].map((s) => {
    const rs = [...s.getClientRects()]
    return { line: s.dataset.line, k: Number(s.dataset.k), text: s.textContent, fragments: rs.length,
      x0: Math.min(...rs.map((r) => r.left)), y0: Math.min(...rs.map((r) => r.top)), x1: Math.max(...rs.map((r) => r.right)), y1: Math.max(...rs.map((r) => r.bottom)) }
  })`)
  const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: false, margins: { marginType: 'none' }, preferCSSPageSize: true })
  writeFileSync(join(outDir, `chromium-${name}.pdf`), pdf)
  const pts = boxes.map((b) => ({ ...b, x0: b.x0 * PX_TO_PT, y0: b.y0 * PX_TO_PT, x1: b.x1 * PX_TO_PT, y1: b.y1 * PX_TO_PT }))
  writeFileSync(join(outDir, `chromium-${name}.boxes.json`), JSON.stringify(pts, null, 1))
}

app.whenReady().then(async () => {
  try {
    await print('lines', html.lines(true))
    await print('para', html.paragraphs(true))
    await print('columns', html.columns(true))
    await print('rotated', html.rotated())
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  rmSync(tmp, { recursive: true, force: true })
  app.quit()
})
