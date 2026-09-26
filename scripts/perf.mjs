// Measures cold-start performance of the real app and prints median / p90 / max per scenario.
//
//   node scripts/perf.mjs                       # dev build (out/), 7 runs each
//   node scripts/perf.mjs --exe dist/win-unpacked/Epdf.exe --runs 9
//
// All times are milliseconds since the OPERATING-SYSTEM PROCESS STARTED (not since Playwright attached), taken from
// the app's own marks: `epdf:interactive` (UI ready, documents can be delivered) and `epdf:first-page-painted`
// (first page of the opened document is on screen). Every run uses a fresh profile (cold database, cold caches) and,
// unless --warm is given, no prior run's profile. Requirements from the spec: launch < 3000 ms, open a typical PDF
// < 1000 ms (measured here as first page painted, from process start when the file is passed on the command line).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const args = process.argv.slice(2)
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def)
const exe = opt('--exe', null)
const runs = Number(opt('--runs', 7))
const warm = args.includes('--warm')

async function makeDoc(dir, name, pages, textPerPage = 40) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = pdf.addPage([612, 792])
    for (let l = 0; l < textPerPage; l++) p.drawText(`Page ${i} line ${l}: the quick brown fox jumps over the lazy dog.`, { x: 50, y: 750 - l * 16, size: 10, font })
  }
  const path = join(dir, name)
  writeFileSync(path, await pdf.save())
  return path
}

// (Very large documents are measured by scripts/perf-huge.mjs.)
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { median: Math.round(q(0.5)), p90: Math.round(q(0.9)), max: Math.round(s[s.length - 1]), min: Math.round(s[0]) }
}

async function once(label, file, userData) {
  const app = await electron.launch({
    ...(exe ? { executablePath: resolve(exe), args: file ? [file] : [] } : { args: ['.', ...(file ? [file] : [])] }),
    env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '' }
  })
  try {
    const page = await app.firstWindow()
    const startEpoch = await app.evaluate(() => Date.now() - process.uptime() * 1000)
    await page.waitForFunction(() => performance.getEntriesByName('epdf:interactive').length > 0, null, { timeout: 30000 })
    if (file) await page.waitForFunction(() => performance.getEntriesByName('epdf:first-page-painted').length > 0, null, { timeout: 30000 })
    return await page.evaluate((start) => {
      const t = (n) => { const e = performance.getEntriesByName(n)[0]; return e ? performance.timeOrigin + e.startTime - start : null }
      return { interactive: t('epdf:interactive'), firstPage: t('epdf:first-page-painted') }
    }, startEpoch)
  } finally {
    await app.close().catch(() => undefined)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'epdf-perf-'))
const typical = await makeDoc(dir, 'typical-10p.pdf', 10)
const big = await makeDoc(dir, 'big-500p.pdf', 500, 30)
const sharedProfile = warm ? mkdtempSync(join(tmpdir(), 'epdf-perf-profile-')) : null
console.log(`# ${exe ? 'packaged: ' + exe : 'dev build (out/)'} — ${runs} runs each, ${warm ? 'warm' : 'cold'} profile\n`)

const scenarios = [
  ['launch (no file) → interactive', null, 'interactive'],
  ['open 10-page PDF from command line → first page painted', typical, 'firstPage'],
  ['open 500-page PDF from command line → first page painted', big, 'firstPage']
]
let failed = false
for (const [label, file, key] of scenarios) {
  const xs = []
  for (let i = 0; i < runs; i++) {
    const ud = sharedProfile ?? mkdtempSync(join(dir, 'p-'))
    const r = await once(label, file, ud)
    if (r[key] != null) xs.push(r[key])
  }
  const s = stats(xs)
  const budget = key === 'interactive' ? 3000 : 1000 // the spec's budgets (first page of a file passed at launch is the strictest reading)
  const ok = s.median <= budget
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'OVER'}  ${label.padEnd(62)} median ${String(s.median).padStart(5)}  p90 ${String(s.p90).padStart(5)}  min ${String(s.min).padStart(5)}  max ${String(s.max).padStart(5)}   (budget ${budget})`)
}
process.exit(failed ? 1 : 0)
