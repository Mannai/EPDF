// Regenerates the page text fixtures in tests/fixtures/pagetext (developer tool; the outputs are committed so that
// no test needs LibreOffice):
//   node tests/fixtures/pagetext/generate.mjs [--lo] [--chromium] [--engine]      (default: all that are available)
//
//   lo-*.pdf         LibreOffice (writer_web_pdf_Export from HTML)        - needs LibreOffice on this machine
//   chromium-*.pdf   Chromium printToPDF (Skia) + *.boxes.json word boxes   - runs Electron from node_modules
//   engine-*.pdf     Epdf's text engine; pdflib-*.pdf: legacy visual-order presentation forms with pdf-lib
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const require = createRequire(import.meta.url)
const args = new Set(process.argv.slice(2))
const all = !args.has('--lo') && !args.has('--chromium') && !args.has('--engine')
const SOFFICE = process.env.EPDF_TOOL_SOFFICE || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'

function write(name, bytes) {
  writeFileSync(join(here, name), bytes)
  console.log('wrote', name, bytes.length, 'bytes')
}

if (all || args.has('--lo')) {
  if (!existsSync(SOFFICE)) console.log('LibreOffice not found: lo-*.pdf left as they are')
  else {
    const html = require('./html.cjs')
    const dir = mkdtempSync(join(tmpdir(), 'epdf-pagetext-lo-'))
    try {
      for (const [name, doc] of [['lines', html.lines(false)], ['para', html.paragraphs(false)], ['columns', html.columns(false)]]) {
        writeFileSync(join(dir, `${name}.html`), doc)
        execFileSync(SOFFICE, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', join(dir, 'out'), join(dir, `${name}.html`)], { stdio: 'inherit', timeout: 180_000 })
        write(`lo-${name}.pdf`, readFileSync(join(dir, 'out', `${name}.pdf`)))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  }
}

if (all || args.has('--chromium')) {
  const electron = require('electron') // path to the Electron binary
  execFileSync(electron, [join(here, 'chromium.cjs'), here], { stdio: 'inherit', timeout: 180_000 })
}

if (all || args.has('--engine')) {
  const { build } = await import('esbuild')
  const out = join(mkdtempSync(join(tmpdir(), 'epdf-pagetext-engine-')), 'engine.mjs')
  const entry = join(here, '_entry.ts')
  writeFileSync(
    entry,
    `import { useNodeResources } from '../../../src/main/features/textengine/nodeResources'
import { withRotation, writeAll } from './engine'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export async function run(dir: string, resources: string) {
  useNodeResources(resources)
  await writeAll(dir, resources, (n, b) => { writeFileSync(join(dir, n), b); console.log('wrote', n, b.length, 'bytes') })
  // a real producer's page shown rotated
  const lo = join(dir, 'lo-lines.pdf')
  if (existsSync(lo)) { const b = await withRotation(new Uint8Array(readFileSync(lo)), 270); writeFileSync(join(dir, 'lo-rotated-page.pdf'), b); console.log('wrote lo-rotated-page.pdf') }
}
`
  )
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: out,
      alias: { '@shared': join(root, 'src/shared') },
      banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
      logLevel: 'error'
    })
    const mod = await import(pathToFileURL(out).href)
    await mod.run(here, join(root, 'resources'))
  } finally {
    rmSync(entry, { force: true })
    rmSync(dirname(out), { recursive: true, force: true })
  }
}
mkdirSync(here, { recursive: true })
