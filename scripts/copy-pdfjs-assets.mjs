// Copies the PDF.js runtime assets (fonts, CMaps, WASM decoders, ICC profiles) into the
// renderer's public dir so the app works fully offline. The JS-in-PDF sandbox is deliberately omitted.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const src = resolve('node_modules/pdfjs-dist')
const dest = resolve('src/renderer/public/pdfjs')
rmSync(dest, { recursive: true, force: true })
for (const dir of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  mkdirSync(resolve(dest, dir), { recursive: true })
  cpSync(resolve(src, dir), resolve(dest, dir), {
    recursive: true,
    filter: (p) => !/quickjs/i.test(p)
  })
}
console.log('pdfjs assets copied to', dest)
