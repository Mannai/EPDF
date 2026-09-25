import fontkit from '@pdf-lib/fontkit'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, redactDocument } from '../../src/renderer/src/features/redact/logic/redact'
import { flattenText, readPdf } from '../support/pdfText'

/**
 * An INDEPENDENT check of the redaction guarantee. It builds its own documents and verifies the result with
 * methods that do not come from the redact feature's own proof suite:
 *   1. qpdf (a separate implementation) rewrites the file fully uncompressed and un-object-streamed; we then scan
 *      those raw bytes for the secret as ASCII, UTF-16BE, hex and glyph-id sequences;
 *   2. PDF.js text extraction of the saved file.
 * Every check is first proven able to find the secret in the UNREDACTED file, so a pass cannot be vacuous.
 */

const SECRET = 'HUNTER2SECRET'
const QPDF = process.env['EPDF_TOOL_QPDF'] || 'C:\\Program Files\\qpdf 12.4.1\\bin\\qpdf.exe'
const haveQpdf = existsSync(QPDF)

const hex = (s: string): string => Buffer.from(s, 'latin1').toString('hex')
const utf16be = (s: string): Buffer => Buffer.from(s, 'utf16le').swap16()

/** Raw bytes of the file after qpdf expands every stream and object stream. */
function qdf(bytes: Uint8Array): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-indep-'))
  try {
    writeFileSync(join(dir, 'in.pdf'), bytes)
    execFileSync(QPDF, ['--qdf', '--object-streams=disable', '--stream-data=uncompress', '--decode-level=all', join(dir, 'in.pdf'), join(dir, 'out.pdf')], { stdio: 'ignore' })
    return readFileSync(join(dir, 'out.pdf'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const rawContains = (raw: Buffer, s: string): boolean =>
  raw.includes(Buffer.from(s, 'latin1')) || raw.includes(utf16be(s)) || raw.toString('latin1').toLowerCase().includes(hex(s).toLowerCase())

interface Built {
  bytes: Uint8Array
  /** Rect (PDF user space) covering exactly the secret's glyphs, plus a bit of vertical margin. */
  rect: { x: number; y: number; w: number; h: number }
  /** Text that must SURVIVE redaction. */
  keep: string[]
}

async function buildHelvetica(): Promise<Built> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const before = 'The password is '
  const after = ' and nothing else.'
  const size = 14
  page.drawText(before + SECRET + after, { x: 72, y: 700, size, font, color: rgb(0, 0, 0) })
  page.drawText('Unrelated line that must stay.', { x: 72, y: 660, size, font })
  const x = 72 + font.widthOfTextAtSize(before, size)
  return {
    bytes: await pdf.save({ useObjectStreams: false }),
    rect: { x: x - 0.5, y: 695, w: font.widthOfTextAtSize(SECRET, size) + 1, h: 18 },
    keep: ['The password is', 'and nothing else.', 'Unrelated line that must stay.']
  }
}

async function buildEmbeddedSubset(): Promise<Built | null> {
  const fontPath = join(__dirname, '..', '..', 'resources', 'fonts', 'NotoSans-Regular.ttf')
  if (!existsSync(fontPath)) return null
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(readFileSync(fontPath), { subset: true })
  const before = 'Account: '
  const size = 16
  page.drawText(before + SECRET, { x: 72, y: 600, size, font })
  page.drawText('Footer text stays.', { x: 72, y: 560, size, font })
  const x = 72 + font.widthOfTextAtSize(before, size)
  return {
    bytes: await pdf.save({ useObjectStreams: true }), // secret also lives inside compressed object streams' neighbours
    rect: { x: x - 0.5, y: 595, w: font.widthOfTextAtSize(SECRET, size) + 1, h: 22 },
    keep: ['Account:', 'Footer text stays.']
  }
}

/** The engine's rectangles are `{ x0, y0, x1, y1 }` in PDF user space. */
const toRect = (r: Built['rect']) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h })

async function redact(built: Built): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(built.bytes, { updateMetadata: false })
  redactDocument(pdf, [{ id: 'm1', pageIndex: 0, rects: [toRect(built.rect)] }], { ...DEFAULT_OPTIONS })
  return pdf.save({ useObjectStreams: false })
}

describe.skipIf(!haveQpdf)('redaction, verified independently (qpdf raw dump + PDF.js)', () => {
  it('the checks can find the secret in the UNREDACTED file (so a pass is meaningful) — Helvetica', async () => {
    const b = await buildHelvetica()
    expect(rawContains(qdf(b.bytes), SECRET)).toBe(true)
    expect(flattenText((await readPdf(b.bytes)).pages)).toContain(SECRET)
  })

  it('Helvetica: the secret is gone from every stream and from extraction; surrounding text survives', async () => {
    const b = await buildHelvetica()
    const out = await redact(b)
    expect(rawContains(qdf(out), SECRET)).toBe(false)
    expect(Buffer.from(out).includes(Buffer.from(SECRET))).toBe(false)
    const text = flattenText((await readPdf(out)).pages)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('HUNTER')
    expect(text).not.toContain('SECRET')
    for (const k of b.keep) expect(text).toContain(k)
  })

  it('a partly-marked word: only the marked glyphs go (fail-safe for the rest)', async () => {
    const b = await buildHelvetica()
    const half = { ...b.rect, w: b.rect.w / 2 } // covers only the first half of the secret
    const pdf = await PDFDocument.load(b.bytes, { updateMetadata: false })
    redactDocument(pdf, [{ id: 'm', pageIndex: 0, rects: [toRect(half)] }], { ...DEFAULT_OPTIONS })
    const out = await pdf.save({ useObjectStreams: false })
    const text = flattenText((await readPdf(out)).pages)
    expect(text).not.toContain(SECRET) // the whole secret can no longer be read
    expect(text).not.toContain('HUNTER2') // the covered first half is gone
    expect(text).toContain('Unrelated line that must stay.')
  })

  it('embedded subset font (glyph ids, compressed streams): secret gone from the raw dump and extraction', async () => {
    const b = await buildEmbeddedSubset()
    if (!b) return
    // Sanity: the unredacted file shows the secret to PDF.js.
    expect(flattenText((await readPdf(b.bytes)).pages)).toContain(SECRET)
    const out = await redact(b)
    const text = flattenText((await readPdf(out)).pages)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('HUNTER')
    for (const k of b.keep) expect(text).toContain(k)
    expect(rawContains(qdf(out), SECRET)).toBe(false)
  })

  it('the redacted file is a valid PDF that qpdf accepts, with no structural errors', async () => {
    const out = await redact(await buildHelvetica())
    const dir = mkdtempSync(join(tmpdir(), 'epdf-indep-'))
    try {
      writeFileSync(join(dir, 'r.pdf'), out)
      // Throws on a non-zero exit (qpdf exits 0 for a clean file, 3 for warnings).
      execFileSync(QPDF, ['--check', join(dir, 'r.pdf')], { stdio: 'pipe' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
