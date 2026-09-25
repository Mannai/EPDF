import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { flattenText, readPdf } from '../support/pdfText'

/**
 * Real-world check of the DOCX reader: documents WRITTEN BY REAL LibreOffice (HTML -> docx) are converted by our
 * built-in engine and by LibreOffice itself; page count and text should broadly match. Skipped when LibreOffice
 * is not installed. One soffice at a time (shared cross-process lock), throw-away profile per run, temp files removed.
 */

const SOFFICE = process.env['EPDF_TOOL_SOFFICE'] || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'
const HAVE = existsSync(SOFFICE)
const fontsDir = resolve('resources/fonts')
const LOCK = join(tmpdir(), 'epdf-soffice.lock')

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(LOCK)
      break
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60_000) rmSync(LOCK, { recursive: true, force: true })
      } catch {
        /* raced with the owner */
      }
      if (Date.now() - start > 8 * 60_000) throw new Error('timed out waiting for the soffice lock')
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(LOCK, { recursive: true, force: true })
  }
}

async function soffice(name: string, bytes: Uint8Array, args: string[], outExt: string): Promise<Uint8Array> {
  return withLock(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lo-docx-'))
    try {
      const input = join(dir, name)
      writeFileSync(input, bytes)
      const out = join(dir, 'out')
      mkdirSync(out)
      await new Promise<void>((res, rej) =>
        execFile(SOFFICE, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, ...args, '--outdir', out, input], { timeout: 120_000, windowsHide: true }, (err) => (err ? rej(err) : res()))
      )
      return new Uint8Array(readFileSync(join(out, `${name.replace(/\.[^.]+$/, '')}.${outExt}`)))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  })
}

const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter || 1)
}

const sentence = (i: number): string => `Paragraph ${i} discusses topic ${i % 9} with ordinary words, the number ${i * 17}, and enough length to wrap across more than a single line of the page.`

const html = (): string =>
  `<html><head><meta charset="utf-8"><title>Report</title></head><body>
<h1>Quarterly Report</h1>
<p>Intro with <b>bold</b>, <i>italic</i>, <u>underline</u> and <span style="color:#c00000">red</span> text that is long enough to wrap onto a second line so wrapping is exercised properly.</p>
<h2>Highlights</h2>
<ul><li>First bullet</li><li>Second bullet<ul><li>Nested bullet</li></ul></li></ul>
<ol><li>Step one</li><li>Step two</li><li>Step three</li></ol>
<table border="1" cellpadding="4"><tr><th>Region</th><th>Q1</th><th>Q2</th></tr><tr><td>North</td><td>120</td><td>135</td></tr><tr><td>South</td><td>98</td><td>110</td></tr><tr><td colspan="2">Total</td><td>245</td></tr></table>
<p align="center">Centered paragraph</p><p align="right">Right aligned</p>
${Array.from({ length: 60 }, (_, i) => `<p>${sentence(i + 1)}</p>`).join('\n')}
<p>The end.</p>
</body></html>`

describe.skipIf(!HAVE)('DOCX written by real LibreOffice, converted by the built-in engine and by LibreOffice', () => {
  it('page count and text broadly match', async () => {
    const docx = await soffice('report.html', new TextEncoder().encode(html()), ['--infilter=HTML (StarWriter)', '--convert-to', 'docx'], 'docx')
    expect(docx.length).toBeGreaterThan(2000)
    const ours = await convertOffice({ name: 'report.docx', bytes: docx }, { fontsDir })
    const lo = await soffice('report.docx', docx, ['--convert-to', 'pdf'], 'pdf')
    const a = await readPdf(ours.bytes)
    const b = await readPdf(lo)
    const ta = flattenText(a.pages)
    const tb = flattenText(b.pages)
    expect(Math.abs(a.pages.length - b.pages.length)).toBeLessThanOrEqual(1)
    expect(jaccard(words(ta), words(tb))).toBeGreaterThan(0.95)
    for (const needle of ['Quarterly Report', 'Highlights', 'First bullet', 'Nested bullet', 'Step three', 'Region', 'South', 'Centered paragraph', 'The end.']) {
      expect(ta, needle).toContain(needle)
      expect(tb, needle).toContain(needle)
    }
    expect(a.pages[0].width).toBeCloseTo(b.pages[0].width, 0)
    expect(a.pages[0].height).toBeCloseTo(b.pages[0].height, 0)
    // nothing lost: every paragraph number of the long body made it into our PDF
    for (let i = 1; i <= 60; i++) expect(ta, `Paragraph ${i}`).toContain(`Paragraph ${i} discusses topic`)
  }, 300_000)
})

it.skipIf(HAVE)('LibreOffice comparison is skipped: soffice is not installed here', () => {
  expect(HAVE).toBe(false)
})
