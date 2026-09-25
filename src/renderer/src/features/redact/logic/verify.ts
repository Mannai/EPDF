import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFObject } from 'pdf-lib'
import { analyzePage } from '../../textedit/pdfcontent/analyze'
import { bytesToLatin1, parseContent } from '../../textedit/pdfcontent/content'
import { N, darr, dget, dname, nameText, numbers, refTag, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import { reachableTags } from './docScrub'
import { extractStreamText } from './extract'
import { GLYPH_COVERAGE, coverage, disjointRects, intersect, type Rect } from './geom'
import { glyphBand } from './interp'
import { decodeImage, pixelSpans } from './imageRedact'
import { decodeTextString } from './pdfconv'
import { OVERLAY_FONT_PREFIX } from './pageRedact'

/**
 * The independent self-check. It re-reads the finished file from its BYTES (not from the objects the redaction
 * worked on) and looks for anything that should be gone:
 *
 *   1. text glyphs still lying under a mark (read with the original text-edit engine, a separate implementation
 *      of text positioning from the one that removed them),
 *   2. images under a mark whose pixels there are not black,
 *   3. annotations still under a mark,
 *   4. the redacted strings anywhere: page/form/appearance text (decoded with the fonts), the literal, UTF-16BE
 *      and hex forms inside every decompressed stream and every text string of the file, and the raw file bytes,
 *   5. objects that are not reachable from the trailer (leftovers of earlier revisions or replaced streams),
 *   6. optionally the text PDF.js extracts.
 *
 * Text that also appears elsewhere on the page, outside every mark, is legitimate: occurrences are compared
 * against what remains visible outside the marks.
 */

export interface Finding {
  /** Human readable place: "page 2", "object 17 (annotation)", ... */
  where: string
  detail: string
}

export interface VerifyInput {
  bytes: Uint8Array
  /** Disjointness is not required. */
  marksByPage: ReadonlyMap<number, readonly Rect[]>
  secrets: readonly string[]
  /** Text of every page as PDF.js extracts it (optional; supplied by the app). */
  pdfjsPages?: (bytes: Uint8Array) => Promise<string[]>
  /** Anything the caller knows is expected to remain (overlay text, ...): not scanned for. */
  ignoreSecrets?: readonly string[]
}

const squeeze = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

export function countOccurrences(hay: string, needle: string): number {
  const h = squeeze(hay)
  const n = squeeze(needle)
  if (!n) return 0
  let c = 0
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) c++
  return c
}

/** Secrets as used for scanning: whitespace-squeezed, at least 3 characters, no duplicates. */
export const usableSecrets = (secrets: readonly string[]): string[] => [...new Set(secrets.map((s) => squeeze(s.normalize('NFC'))).filter((s) => s.length >= 3))]

const utf16be = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1])
  return s
}

const isImageOrFont = (d: PDFDict): boolean => {
  const sub = dname(d, 'Subtype')
  return sub === 'Image' || sub === 'Type1C' || sub === 'CIDFontType0C' || sub === 'OpenType' || d.has(N('Length1')) || d.has(N('Length2'))
}

function printableRatio(b: Uint8Array): number {
  const n = Math.min(b.length, 4096)
  if (n === 0) return 1
  let ok = 0
  for (let i = 0; i < n; i++) if ((b[i] >= 32 && b[i] < 127) || b[i] === 10 || b[i] === 13 || b[i] === 9) ok++
  return ok / n
}

/** The strings shown by the text operators of a content stream (TJ pieces joined), or null if it is not content. */
function contentStrings(bytes: Uint8Array): Uint8Array[] | null {
  if (printableRatio(bytes) < 0.85) return null
  try {
    const ops = parseContent(bytes).ops
    const out: Uint8Array[] = []
    let shows = 0
    for (const op of ops) {
      if (op.op === 'Tj' || op.op === "'" || op.op === '"') {
        const s = op.args[op.op === '"' ? 2 : 0]
        if (s?.t === 'str') out.push(s.b)
        shows++
      } else if (op.op === 'TJ' && op.args[0]?.t === 'arr') {
        const parts = op.args[0].v.filter((x) => x.t === 'str') as { t: 'str'; b: Uint8Array }[]
        const total = parts.reduce((n, p) => n + p.b.length, 0)
        const joined = new Uint8Array(total)
        let o = 0
        for (const p of parts) {
          joined.set(p.b, o)
          o += p.b.length
        }
        out.push(joined)
        shows++
      }
    }
    return shows > 0 ? out : null
  } catch {
    return null
  }
}

function* streams(pdf: PDFDocument): Generator<[PDFRef, PDFStream]> {
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) if (obj instanceof PDFStream) yield [ref, obj]
}

/** All text strings and names in non-stream objects (and stream dictionaries) of the file. */
function* textValues(pdf: PDFDocument): Generator<{ where: string; text: string }> {
  const walk = function* (o: PDFObject, where: string, depth: number): Generator<{ where: string; text: string }> {
    if (depth > 30) return
    if (o instanceof PDFStream) yield* walk(o.dict, where, depth + 1)
    else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        const key = nameText(k)
        if (key === 'ID' || key === 'O' || key === 'U' || key === 'OE' || key === 'UE' || key === 'Perms') continue
        yield* walk(v, `${where}/${key}`, depth + 1)
      }
    } else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) yield* walk(o.get(i), where, depth + 1)
    else if (o instanceof PDFString || o instanceof PDFHexString) yield { where, text: decodeTextString(o.asBytes()) }
    else if (o instanceof PDFName) yield { where, text: nameText(o) }
  }
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) yield* walk(obj, `object ${refTag(ref).replace(' ', ' gen ')}`, 0)
}

export async function verifyRedaction(input: VerifyInput): Promise<Finding[]> {
  const findings: Finding[] = []
  const add = (where: string, detail: string): void => {
    if (findings.length < 200) findings.push({ where, detail })
  }
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(input.bytes, { updateMetadata: false })
  } catch (e) {
    return [{ where: 'file', detail: `The redacted file could not be read back (${e instanceof Error ? e.message : String(e)}).` }]
  }
  const ctx = pdf.context
  const secrets = usableSecrets(input.secrets).filter((s) => !(input.ignoreSecrets ?? []).map(squeeze).includes(s))

  // ---- 5. unreachable objects
  const reach = reachableTags(pdf)
  let orphans = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reach.has(refTag(ref))) orphans++
  if (orphans) add('file', `${orphans} object(s) that nothing refers to are still in the file and may hold old content.`)

  // ---- 1-3. per page geometry
  let allowedText = ''
  const pages = pdf.getPages()
  for (let pi = 0; pi < pages.length; pi++) {
    const marks = disjointRects(input.marksByPage.get(pi) ?? [])
    let analysis: ReturnType<typeof analyzePage>
    try {
      analysis = analyzePage(pdf, pi)
    } catch (e) {
      if (marks.length) add(`page ${pi + 1}`, `The page could not be re-read to confirm the redaction (${e instanceof Error ? e.message : String(e)}).`)
      continue
    }
    const pageText: string[] = []
    for (const run of analysis.runs) {
      if (run.fontName.startsWith(OVERLAY_FONT_PREFIX)) continue
      const band = glyphBand(run.font)
      let line = ''
      for (const g of run.glyphs) {
        const r: Rect = (() => {
          const t = run.matrix
          const pts = [
            [g.x0, run.rise + band.desc * run.size],
            [g.x1, run.rise + band.desc * run.size],
            [g.x0, run.rise + band.asc * run.size],
            [g.x1, run.rise + band.asc * run.size]
          ].map(([x, y]) => [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]])
          const xs = pts.map((p) => p[0])
          const ys = pts.map((p) => p[1])
          return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        })()
        if (marks.length && coverage(r, marks) >= GLYPH_COVERAGE) {
          add(`page ${pi + 1}`, `Text is still present under a redaction mark (“${run.text.length > 40 ? run.text.slice(0, 40) + '…' : run.text}”).`)
          break
        }
        line += g.text
      }
      pageText.push(line)
    }
    allowedText += '\n' + pageText.join('\n')

    if (marks.length) {
      for (const im of analysis.images) {
        if (!marks.some((m) => intersect(im.bbox, m))) continue
        if (im.kind === 'inline') {
          add(`page ${pi + 1}`, 'An inline image under a redaction mark was left in the page.')
          continue
        }
        const obj = im.ref ? ctx.lookup(im.ref) : undefined
        if (!(obj instanceof PDFStream)) {
          add(`page ${pi + 1}`, 'An image under a redaction mark could not be inspected.')
          continue
        }
        const dec = decodeImage(pdf, obj)
        const spans = dec ? pixelSpans(dec.width, dec.height, im.ctm, marks) : null
        if (!dec || !spans) {
          add(`page ${pi + 1}`, 'An image under a redaction mark could not be decoded to confirm that its pixels were destroyed.')
          continue
        }
        const jpeg = (() => {
          const f = dget(obj.dict, 'Filter')
          return f instanceof PDFName && nameText(f) === 'DCTDecode'
        })()
        const stencil = obj.dict.has(N('ImageMask'))
        const tolerance = jpeg ? 24 : 0
        let bad = 0
        let total = 0
        for (const s of spans) {
          for (let x = s.x0; x < s.x1; x++) {
            total++
            const o = (s.y * dec.width + x) * dec.components
            let worst = 0
            if (dec.components === 4) worst = Math.max(dec.data[o], dec.data[o + 1], dec.data[o + 2], 255 - dec.data[o + 3])
            else for (let c = 0; c < dec.components; c++) worst = Math.max(worst, stencil ? 0 : dec.data[o + c])
            if (worst > tolerance) bad++
          }
        }
        // JPEG blocks at the edge of a region may ring slightly; anything more than a sliver is a failure
        if (bad > (jpeg ? total * 0.03 : 0)) add(`page ${pi + 1}`, 'Image pixels under a redaction mark are not black, so they were not destroyed.')
      }
      const annots = pages[pi].node.Annots()
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          const d = annots.lookup(i)
          if (!(d instanceof PDFDict)) continue
          const r = numbers(darr(d, 'Rect'))
          if (r.length === 4 && r.every(Number.isFinite)) {
            const box = { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) }
            if (marks.some((m) => intersect(box, m))) add(`page ${pi + 1}`, `An annotation (${dname(d, 'Subtype') ?? 'unknown'}) under a redaction mark is still present.`)
          }
        }
      }
    }
  }

  if (secrets.length) {
    // ---- 4. strings in streams, text values and raw bytes
    const allowed = (s: string): number => countOccurrences(allowedText, s)
    const contentHits = new Map<string, number>()
    const bump = (s: string, n: number): void => {
      contentHits.set(s, (contentHits.get(s) ?? 0) + n)
    }
    for (const [ref, stream] of streams(pdf)) {
      const where = `object ${ref.objectNumber} (stream)`
      const d = stream.dict
      let bytes: Uint8Array
      try {
        bytes = streamBytes(stream)
      } catch {
        continue
      }
      const type = dname(d, 'Type')
      if (type === 'Metadata' || type === 'EmbeddedFile' || (!isImageOrFont(d) && printableRatio(bytes) >= 0.9 && contentStrings(bytes) === null)) {
        const text = type === 'EmbeddedFile' ? bytesToLatin1(bytes) : new TextDecoder().decode(bytes)
        const wide = utf16be(bytes)
        for (const s of secrets) {
          if (countOccurrences(text, s) + countOccurrences(wide, s) > 0) add(where, `Redacted text was found in ${type === 'Metadata' ? 'a metadata stream' : type === 'EmbeddedFile' ? 'an attachment' : 'a data stream'}.`)
        }
        continue
      }
      if (isImageOrFont(d)) continue
      const shown = contentStrings(bytes)
      if (shown) {
        for (const b of shown) {
          const asLatin = bytesToLatin1(b)
          const wide = utf16be(b)
          for (const s of secrets) bump(s, countOccurrences(asLatin, s) + (b.length % 2 === 0 ? countOccurrences(wide, s) : 0))
        }
        const decoded = extractStreamText(pdf, stream)
        for (const s of secrets) bump(s, countOccurrences(decoded, s))
      }
    }
    for (const s of secrets) {
      const n = contentHits.get(s) ?? 0
      // every visible occurrence is counted once per stream where it is drawn (decoded and literal counts may
      // both see the same text), so compare against twice what is legitimately visible
      if (n > 2 * allowed(s)) add('content streams', 'Redacted text is still present in page content or an appearance stream.')
    }
    for (const v of textValues(pdf)) {
      for (const s of secrets) if (countOccurrences(v.text, s) > 0) add(v.where, 'Redacted text is still present in a document string (bookmark, field, annotation, metadata, ...).')
    }
    // raw bytes of the whole file: literal, UTF-16BE and hex spellings
    const raw = bytesToLatin1(input.bytes)
    const rawLower = raw.toLowerCase()
    // (short secrets are skipped here: compressed data would produce chance matches; they are covered above)
    for (const s of secrets.filter((x) => x.length >= 6)) {
      const forms: string[] = []
      const lit = s.toLowerCase()
      forms.push(lit)
      const utf = Array.from(lit, (ch) => String.fromCharCode(0, ch.charCodeAt(0) & 0xff)).join('')
      forms.push(utf)
      const hexLatin = Array.from(lit, (ch) => (ch.charCodeAt(0) & 0xff).toString(16).padStart(2, '0')).join('')
      const hexUtf = Array.from(lit, (ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')
      let hits = 0
      for (const f of forms) for (let i = rawLower.indexOf(f); i >= 0; i = rawLower.indexOf(f, i + 1)) hits++
      for (const f of [hexLatin, hexUtf]) for (let i = rawLower.indexOf(f); i >= 0; i = rawLower.indexOf(f, i + 1)) hits++
      if (hits > 2 * allowed(s)) add('file bytes', 'Redacted text appears in the raw bytes of the file.')
    }
    // ---- 6. PDF.js
    if (input.pdfjsPages) {
      try {
        const texts = await input.pdfjsPages(input.bytes)
        const joined = texts.join('\n')
        for (const s of secrets) {
          if (countOccurrences(joined, s) > allowed(s)) add('text extraction', 'The redacted text can still be extracted by PDF.js.')
        }
      } catch (e) {
        add('text extraction', `PDF.js could not read the result to confirm the redaction (${e instanceof Error ? e.message : String(e)}).`)
      }
    }
  }
  return dedupe(findings)
}

function dedupe(fs: Finding[]): Finding[] {
  const seen = new Set<string>()
  return fs.filter((f) => {
    const k = `${f.where}|${f.detail}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
