import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'

/** PDF fixtures for the library tests: many small documents with varied text, plus damaged/protected/empty ones. */

const LINE_HEIGHT = 18

/** Text PDF, one string per page (`\n` starts a new line). Helvetica, so Latin text with accents (WinAnsi) works. */
export async function makeTextPdf(pages: string[], opts: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = doc.addPage([612, 792])
    text.split('\n').forEach((line, i) => page.drawText(line, { x: 56, y: 730 - i * LINE_HEIGHT, size: 12, font, color: rgb(0, 0, 0) }))
  }
  if (opts.title) doc.setTitle(opts.title)
  doc.setProducer('Epdf library fixtures')
  return doc.save()
}

/**
 * A PDF whose *extracted* text is CJK. pdf-lib cannot embed a CJK font here, so each character is drawn with a
 * Latin glyph and the font's /ToUnicode map says which CJK character that code stands for: pdf.js reports exactly
 * what a real Japanese/Chinese PDF would (the picture is irrelevant for text indexing).
 */
export async function makeCjkPdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const codeOf = new Map<string, number>()
  const chars = (s: string): string[] => Array.from(s)
  const usable = Array.from({ length: 94 }, (_, i) => 33 + i).filter((c) => ![40, 41, 92].includes(c)) // printable ASCII except ( ) \
  for (const t of pages) for (const ch of chars(t)) if (!codeOf.has(ch) && ch !== ' ') codeOf.set(ch, usable[codeOf.size])
  if (codeOf.size > usable.length) throw new Error('Too many distinct characters for the fixture')
  const encode = (s: string): string => chars(s).map((ch) => (ch === ' ' ? ' ' : String.fromCharCode(codeOf.get(ch)!))).join('')
  for (const t of pages) {
    const page = doc.addPage([612, 792])
    page.drawText(encode(t), { x: 56, y: 700, size: 14, font })
  }
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')
  const entries = [...codeOf].map(([ch, code]) => `<${code.toString(16).toUpperCase().padStart(2, '0')}> <${hex(ch.codePointAt(0)!)}>`)
  entries.push('<20> <0020>')
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def ' +
    '1 begincodespacerange <00> <FF> endcodespacerange ' +
    `${entries.length} beginbfchar ${entries.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`
  const stream = doc.context.flateStream(cmap)
  await doc.flush() // writes the pending font dictionary so it can be amended
  const fontDict = doc.context.lookup(font.ref) as unknown as { set(k: PDFName, v: unknown): void }
  fontDict.set(PDFName.of('ToUnicode'), doc.context.register(stream))
  return doc.save()
}

// A 1x1 white PNG.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')

/** A "scanned" document: a page made of an image only, with no text at all. */
export async function makeImageOnlyPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(PNG_1X1)
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792])
    p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  }
  return doc.save()
}

/** A file that has a PDF header but is broken beyond repair. */
export const makeCorruptPdf = (): Uint8Array => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

/** A file that is not a PDF at all (but is named like one). */
export const makeNotPdf = (): Uint8Array => Buffer.from('This is a text file, not a PDF.')

// ---- an RC4-40 encrypted PDF that needs a password, written by hand (no PDF tool required) ---------------------------
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest()
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  let a = 0
  let b = 0
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255
    b = (b + s[a]) & 255
    ;[s[a], s[b]] = [s[b], s[a]]
    out[n] = data[n] ^ s[(s[a] + s[b]) & 255]
  }
  return out
}

/** One page saying "Top secret ledger", protected by the user password "secret". */
export function makePasswordPdf(userPassword = 'secret'): Uint8Array {
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const pad = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32)
  const pBytes = Buffer.alloc(4)
  pBytes.writeInt32LE(-4)
  const O = rc4(md5(pad('owner-password')).subarray(0, 5), pad(userPassword))
  const key = md5(pad(userPassword), O, pBytes, id).subarray(0, 5)
  const U = rc4(key, PAD)
  const objKey = (n: number): Buffer => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10)
  const hex = (b: Buffer): string => `<${b.toString('hex')}>`
  const enc = rc4(objKey(4), Buffer.from('BT /F1 20 Tf 72 700 Td (Top secret ledger) Tj ET', 'latin1'))
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  const add = (n: number, body: string | Buffer): void => {
    offsets[n] = parts.reduce((s, p) => s + p.length, 0)
    parts.push(Buffer.from(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n'))
  }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>')
  add(4, Buffer.concat([Buffer.from(`<< /Length ${enc.length} >>\nstream\n`), enc, Buffer.from('\nendstream')]))
  add(5, `<< /Filter /Standard /V 1 /R 2 /O ${hex(O)} /U ${hex(U)} /P -4 >>`)
  const xref = parts.reduce((s, p) => s + p.length, 0)
  let table = 'xref\n0 6\n0000000000 65535 f \n'
  for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  parts.push(Buffer.from(`${table}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [${hex(id)} ${hex(id)}] >>\nstartxref\n${xref}\n%%EOF\n`))
  return new Uint8Array(Buffer.concat(parts))
}

// ---- generating a whole library on disk ---------------------------------------------------------------------------

const WORDS = [
  'invoice', 'contract', 'budget', 'forecast', 'quarterly', 'report', 'meeting', 'agenda', 'minutes', 'proposal',
  'schedule', 'analysis', 'revenue', 'expense', 'customer', 'supplier', 'delivery', 'warranty', 'insurance', 'policy',
  'project', 'milestone', 'deadline', 'resource', 'strategy', 'marketing', 'campaign', 'product', 'design', 'engineering',
  'security', 'compliance', 'audit', 'training', 'onboarding', 'benefits', 'payroll', 'holiday', 'travel', 'receipt'
]

/** Deterministic pseudo-random generator (mulberry32), so generated libraries are identical run to run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sentence(rand: () => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')
}

export interface GeneratedFile {
  path: string
  pages: number
}

/**
 * Writes `count` small PDFs into `dir` (spread over sub-folders), each with a unique marker word `docNNNNN` on page 1
 * and `pagesEach` pages of generated prose. Returns what was written.
 */
export async function generateLibrary(dir: string, count: number, opts: { pagesEach?: number; wordsPerPage?: number; folders?: number; seed?: number } = {}): Promise<GeneratedFile[]> {
  const rand = rng(opts.seed ?? 1)
  const pagesEach = opts.pagesEach ?? 2
  const wordsPerPage = opts.wordsPerPage ?? 40
  const folders = Math.max(1, opts.folders ?? 10)
  const out: GeneratedFile[] = []
  // Build one PDF template per distinct text is too slow for thousands of files; vary text, reuse the font embedding.
  for (let i = 0; i < count; i++) {
    const sub = `folder${String(i % folders).padStart(2, '0')}`
    const path = join(dir, sub, `doc${String(i).padStart(5, '0')}.pdf`)
    const pages = Array.from({ length: pagesEach }, (_, p) => {
      const lines = [p === 0 ? `Document marker doc${String(i).padStart(5, '0')}` : `Page ${p + 1}`]
      for (let l = 0; l < Math.ceil(wordsPerPage / 10); l++) lines.push(sentence(rand, 10))
      return lines.join('\n')
    })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await makeTextPdf(pages))
    out.push({ path, pages: pagesEach })
  }
  return out
}

export { PDFString }
