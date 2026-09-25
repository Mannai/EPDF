// A stand-in for LibreOffice's `soffice` used by tests (select it with EPDF_TOOL_SOFFICE=<this file>).
// It understands only what Epdf passes: --outdir <dir>, -env:UserInstallation=file:///<profile>, and the input file
// as the last argument. Behaviour is controlled by environment variables:
//   EPDF_STUB_MODE   ok (default) | sleep | fail | nopdf
//   EPDF_STUB_SLEEP_MS  how long `sleep` mode waits (default 60000)
//   EPDF_STUB_LOG    file to write {argv, cwd} JSON into (each call appends a line)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--outdir')
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined
const input = args[args.length - 1]
const profileArg = args.find((a) => a.startsWith('-env:UserInstallation='))
if (process.env.EPDF_STUB_LOG) appendFileSync(process.env.EPDF_STUB_LOG, JSON.stringify({ argv: args, cwd: process.cwd() }) + '\n')

if (profileArg) {
  const url = profileArg.slice('-env:UserInstallation='.length)
  const dir = fileURLToPath(url)
  mkdirSync(join(dir, 'user'), { recursive: true })
  writeFileSync(join(dir, 'user', 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items/>')
}

const mode = process.env.EPDF_STUB_MODE ?? 'ok'
if (mode === 'sleep') {
  await new Promise((r) => setTimeout(r, Number(process.env.EPDF_STUB_SLEEP_MS ?? 60000)))
}
if (mode === 'fail') {
  console.error('Error: source file could not be loaded')
  process.exit(1)
}
if (!outDir || !existsSync(input)) {
  console.error('stub-soffice: missing --outdir or input file')
  process.exit(2)
}
if (mode === 'nopdf') process.exit(0)

const text = readFileSync(input).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').slice(0, 80).replace(/[()\\]/g, ' ')
const stream = `BT /F1 18 Tf 72 700 Td (STUB:${text}) Tj ET`
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
]
let pdf = '%PDF-1.4\n'
const offsets = []
objs.forEach((o, i) => {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
})
const xref = pdf.length
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const stem = basename(input).replace(/\.[^.]+$/, '')
writeFileSync(join(outDir, `${stem}.pdf`), pdf, 'latin1')
