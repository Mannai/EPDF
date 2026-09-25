import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { odtPackage, p } from '../support/odt'
import { flattenText, readPdf } from '../support/pdfText'

/**
 * Comparison of our built-in RTF/ODT conversion with real LibreOffice (page count and text should broadly match).
 * Skipped when LibreOffice is not installed. Only one soffice runs at a time (cross-process lock), each with its
 * own throw-away profile directory, and every temp file is removed.
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

async function libreOfficeToPdf(name: string, bytes: Uint8Array): Promise<Uint8Array> {
  return withLock(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lo-cmp-'))
    try {
      const input = join(dir, name)
      writeFileSync(input, bytes)
      const out = join(dir, 'out')
      mkdirSync(out)
      await new Promise<void>((res, rej) =>
        execFile(
          SOFFICE,
          ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'pdf', '--outdir', out, input],
          { timeout: 120_000, windowsHide: true },
          (err) => (err ? rej(err) : res())
        )
      )
      return new Uint8Array(readFileSync(join(out, name.replace(/\.[^.]+$/, '.pdf'))))
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

const sentence = (i: number): string => `Paragraph ${i} explains topic ${i % 7} using ordinary words, numbers like ${i * 31} and enough length to wrap over more than one line of the page.`

const rtfDoc = (): string => {
  const paras = Array.from({ length: 70 }, (_, i) => `\\pard\\plain\\f0\\fs22\\sa120 ${sentence(i + 1)}\\par`).join('\n')
  const table =
    '\\trowd\\trgaph108\\trleft-108\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx3000\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx6000' +
    '\\pard\\intbl\\f0\\fs22 Alpha\\cell\\pard\\intbl Beta\\cell\\row'
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\sectd \\pard\\plain\\f1\\fs36\\b Comparison report\\b0\\par ${paras}\n${table}\\pard\\plain\\f0\\fs22 The end.\\par}`
}

describe.skipIf(!HAVE)('built-in RTF/ODT conversion compared with real LibreOffice', () => {
  it('RTF: page count and text broadly match', async () => {
    const bytes = Buffer.from(rtfDoc(), 'latin1')
    const ours = await convertOffice({ name: 'cmp.rtf', bytes }, { fontsDir })
    const lo = await libreOfficeToPdf('cmp.rtf', bytes)
    const a = await readPdf(ours.bytes)
    const b = await readPdf(lo)
    expect(Math.abs(a.pages.length - b.pages.length)).toBeLessThanOrEqual(1)
    expect(jaccard(words(flattenText(a.pages)), words(flattenText(b.pages)))).toBeGreaterThan(0.95)
    expect(flattenText(a.pages)).toContain('The end.')
    expect(flattenText(b.pages)).toContain('The end.')
  }, 240_000)

  it('ODT: page count and text broadly match', async () => {
    const body =
      '<text:h text:style-name="Heading_20_1" text:outline-level="1">Comparison report</text:h>' +
      Array.from({ length: 70 }, (_, i) => p(sentence(i + 1), 'Text_20_body')).join('') +
      p('The end.', 'Text_20_body')
    const bytes = odtPackage({ body })
    const ours = await convertOffice({ name: 'cmp.odt', bytes }, { fontsDir })
    const lo = await libreOfficeToPdf('cmp.odt', bytes)
    const a = await readPdf(ours.bytes)
    const b = await readPdf(lo)
    expect(Math.abs(a.pages.length - b.pages.length)).toBeLessThanOrEqual(1)
    expect(jaccard(words(flattenText(a.pages)), words(flattenText(b.pages)))).toBeGreaterThan(0.95)
    // page size follows the document
    expect(a.pages[0].width).toBeCloseTo(b.pages[0].width, 0)
    expect(a.pages[0].height).toBeCloseTo(b.pages[0].height, 0)
  }, 240_000)
})

/** Runs soffice --convert-to <target> on `bytes` and returns the produced file. */
async function libreOfficeConvert(name: string, bytes: Uint8Array, target: string): Promise<Uint8Array> {
  return withLock(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lo-gen-'))
    try {
      const input = join(dir, name)
      writeFileSync(input, bytes)
      const out = join(dir, 'out')
      mkdirSync(out)
      await new Promise<void>((res, rej) =>
        execFile(
          SOFFICE,
          ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', target, '--outdir', out, input],
          { timeout: 120_000, windowsHide: true },
          (err) => (err ? rej(err) : res())
        )
      )
      return new Uint8Array(readFileSync(join(out, `${name.replace(/\.[^.]+$/, '')}.${target.split(':')[0]}`)))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  })
}

describe.skipIf(!HAVE)('files written by real LibreOffice are read correctly', () => {
  const html = `<html><head><meta charset="utf-8"><title>Genuine</title></head><body>
<h1>Genuine LibreOffice output</h1>
<p>Plain paragraph with <b>bold</b>, <i>italic</i>, <u>underlined</u> text and a <a href="https://example.com/">link</a>.</p>
<h2>Lists</h2><ul><li>First bullet</li><li>Second bullet<ul><li>Nested bullet</li></ul></li></ul>
<ol><li>Step one</li><li>Step two</li><li>Step three</li></ol>
<h2>A table</h2>
<table border="1" cellpadding="4"><tr><th>Name</th><th>Qty</th><th>Price</th></tr><tr><td>Apples</td><td>3</td><td>1.20</td></tr><tr><td>Pears</td><td>5</td><td>2.75</td></tr><tr><td colspan="2">Total spans two</td><td>3.95</td></tr></table>
${Array.from({ length: 40 }, (_, i) => `<p>${sentence(i + 1)}</p>`).join('\n')}
<p>Ümlauts, accents (café, naïve) and symbols: € £ © ™ and the end marker ENDMARK.</p>
</body></html>`

  for (const target of ['odt', 'rtf'] as const) {
    it(`${target.toUpperCase()} produced by LibreOffice: text, structure and page count match LibreOffice's own PDF`, async () => {
      // (HTML opens in Writer/Web, which has no RTF export: go HTML -> ODT -> RTF)
      const odt = await libreOfficeConvert('gen.html', new TextEncoder().encode(html), 'odt:writer8')
      const file = target === 'odt' ? odt : await libreOfficeConvert('gen.odt', odt, 'rtf:Rich Text Format')
      const ours = await convertOffice({ name: `gen.${target}`, bytes: file }, { fontsDir })
      const lo = await libreOfficeToPdf(`gen.${target}`, file)
      const a = await readPdf(ours.bytes)
      const b = await readPdf(lo)
      const ta = flattenText(a.pages)
      expect(ta).toContain('Genuine LibreOffice output')
      expect(ta).toContain('Nested bullet')
      expect(ta).toMatch(/Step two/)
      expect(ta).toContain('Total spans two')
      expect(ta).toContain('ENDMARK')
      expect(ta).toContain('café')
      expect(Math.abs(a.pages.length - b.pages.length)).toBeLessThanOrEqual(1)
      expect(jaccard(words(ta), words(flattenText(b.pages)))).toBeGreaterThan(0.9)
      // bold text is set in a bold face
      expect(a.pages[0].items.find((i) => i.str.includes('bold'))?.font ?? '').toMatch(/Bold/)
      expect(a.pages[0].width).toBeCloseTo(b.pages[0].width, 0)
    }, 300_000)
  }
})

it.skipIf(HAVE)('LibreOffice comparison is skipped: soffice is not installed here', () => {
  expect(HAVE).toBe(false)
})
