import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { parseContent, type PdfObj } from '../../textedit/pdfcontent/content'
import { forEachRef } from './graph'
import { pruneTrueType } from './ttf'
import { N, decodeStream, deflateMax, encodedBytes, nameOf, numOf, refKey, resolve } from './streams'

/**
 * Font subsetting for fully embedded TrueType fonts (see ttf.ts for what "subsetting" means here). It is deliberately strict:
 * a font is only touched when EVERY place that uses it has been read and understood, because a missing glyph would be
 * corrupted text. Anything unusual (interactive-form default resources, unparseable content, ExtGState fonts, non-Identity
 * encodings, shared font files) makes the font ineligible.
 */

export interface FontReport {
  candidates: number
  subsetted: number
  savedBytes: number
  /** Object keys of the font programs that were rewritten (already compressed at maximum level). */
  replaced: string[]
}

/** Total size of the embedded font programs that could be candidates for subsetting (for the size estimate). */
export function subsettableFontBytes(pdf: PDFDocument): number {
  const ctx = pdf.context
  let total = 0
  for (const c of findCandidates(ctx, refCounts(ctx)).values()) total += encodedBytes(c.file).length
  return total
}

interface Candidate {
  ref: PDFRef
  type0: PDFDict
  cidFont: PDFDict
  cidFontRef: PDFRef
  descriptor: PDFDict
  descriptorRef: PDFRef
  fileRef: PDFRef
  file: PDFStream
  /** CID -> GID; null = identity. */
  map: Uint16Array | null
  /** Number of dictionary entries that point at the Type 0 font, as seen in the resource dictionaries we walked. */
  seen: number
  used: Set<number>
  unknown: boolean
}

const MIN_FONT_BYTES = 24 * 1024

function refCounts(ctx: PDFContext): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [, obj] of ctx.enumerateIndirectObjects()) forEachRef(obj, (r) => counts.set(refKey(r), (counts.get(refKey(r)) ?? 0) + 1))
  return counts
}

const asDict = (ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined => {
  const v = resolve(ctx, o)
  return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : undefined
}

function findCandidates(ctx: PDFContext, counts: Map<string, number>): Map<string, Candidate> {
  const out = new Map<string, Candidate>()
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(ctx, obj.get(N('Subtype'))) !== 'Type0') continue
    const enc = nameOf(ctx, obj.get(N('Encoding')))
    if (enc !== 'Identity-H' && enc !== 'Identity-V') continue
    const desc = resolve(ctx, obj.get(N('DescendantFonts')))
    if (!(desc instanceof PDFArray) || desc.size() !== 1) continue
    const cidRef = desc.get(0)
    const cid = resolve(ctx, cidRef)
    if (!(cidRef instanceof PDFRef) || !(cid instanceof PDFDict) || nameOf(ctx, cid.get(N('Subtype'))) !== 'CIDFontType2') continue
    const fdRef = cid.get(N('FontDescriptor'))
    const fd = resolve(ctx, fdRef)
    if (!(fdRef instanceof PDFRef) || !(fd instanceof PDFDict)) continue
    const ffRef = fd.get(N('FontFile2'))
    const ff = resolve(ctx, ffRef)
    if (!(ffRef instanceof PDFRef) || !(ff instanceof PDFStream)) continue
    // The pieces must belong to this font only, or pruning one user would break another.
    if ((counts.get(refKey(cidRef)) ?? 0) !== 1 || (counts.get(refKey(fdRef)) ?? 0) !== 1 || (counts.get(refKey(ffRef)) ?? 0) !== 1) continue
    if (encodedBytes(ff).length < MIN_FONT_BYTES) continue
    let map: Uint16Array | null = null
    const c2g = resolve(ctx, cid.get(N('CIDToGIDMap')))
    if (c2g instanceof PDFStream) {
      const d = decodeStream(ctx, c2g)
      if (!d) continue
      map = new Uint16Array(d.length >> 1)
      for (let i = 0; i < map.length; i++) map[i] = (d[i * 2] << 8) | d[i * 2 + 1]
    } else if (c2g instanceof PDFName && nameOf(ctx, c2g) !== 'Identity') continue
    out.set(refKey(ref), { ref, type0: obj, cidFont: cid, cidFontRef: cidRef, descriptor: fd, descriptorRef: fdRef, fileRef: ffRef, file: ff, map, seen: 0, used: new Set(), unknown: false })
  }
  return out
}

function contentOf(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | null {
  const v = resolve(ctx, o)
  if (v instanceof PDFStream) return decodeStream(ctx, v)
  if (v instanceof PDFArray) {
    const parts: Uint8Array[] = []
    for (let i = 0; i < v.size(); i++) {
      const s = resolve(ctx, v.get(i))
      if (!(s instanceof PDFStream)) continue
      const d = decodeStream(ctx, s)
      if (!d) return null
      parts.push(d, new Uint8Array([10]))
    }
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
    let o2 = 0
    for (const p of parts) (out.set(p, o2), (o2 += p.length))
    return out
  }
  return new Uint8Array(0)
}

const hasTextOps = (b: Uint8Array): boolean => {
  for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0x42 && b[i + 1] === 0x54 && b[i + 2] <= 32) return true // "BT"
  return false
}

function noteStrings(c: Candidate, args: PdfObj[]): void {
  const take = (s: Uint8Array): void => {
    if (s.length % 2) return void (c.unknown = true)
    for (let i = 0; i < s.length; i += 2) {
      const cidv = (s[i] << 8) | s[i + 1]
      const gid = c.map ? (c.map[cidv] ?? 0) : cidv
      c.used.add(gid)
    }
  }
  for (const a of args) {
    if (a.t === 'str') take(a.b)
    else if (a.t === 'arr') for (const x of a.v) if (x.t === 'str') take(x.b)
  }
}

/**
 * Reads one content stream: `resources` maps font names to candidates. Returns false if the content could not be understood
 * (then every font in those resources is marked unknown by the caller).
 */
function scanContent(bytes: Uint8Array, fonts: Map<string, Candidate>): boolean {
  let parsed
  try {
    parsed = parseContent(bytes)
  } catch {
    return false
  }
  let cur: Candidate | null = null
  const stack: (Candidate | null)[] = []
  for (const op of parsed.ops) {
    switch (op.op) {
      case 'q':
        stack.push(cur)
        break
      case 'Q':
        if (stack.length) cur = stack.pop()!
        break
      case 'Tf': {
        const nm = op.args[0]
        cur = nm?.t === 'name' ? (fonts.get(nm.v) ?? null) : null
        break
      }
      case 'Tj':
      case 'TJ':
        if (cur) noteStrings(cur, op.args)
        break
      case "'":
      case '"':
        if (cur) noteStrings(cur, op.args)
        break
    }
  }
  return true
}

/** Subsets every eligible fully-embedded TrueType font. Mutates the document; unaffected fonts stay byte-identical. */
export function subsetFonts(pdf: PDFDocument): FontReport {
  const ctx = pdf.context
  const report: FontReport = { candidates: 0, subsetted: 0, savedBytes: 0, replaced: [] }
  const counts = refCounts(ctx)
  const cands = findCandidates(ctx, counts)
  report.candidates = cands.size
  if (cands.size === 0) return report

  // Any graphics-state dictionary that sets a font is a place we do not analyse: give up on everything.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : undefined
    if (d && nameOf(ctx, d.get(N('Type'))) === 'ExtGState' && d.has(N('Font'))) return report
  }

  const visitedFontDicts = new Set<PDFDict>()
  const walkResources = (res: PDFObject | undefined): Map<string, Candidate> => {
    const map = new Map<string, Candidate>()
    const rd = asDict(ctx, res)
    const fd = rd ? asDict(ctx, rd.get(N('Font'))) : undefined
    if (!fd) return map
    const first = !visitedFontDicts.has(fd)
    visitedFontDicts.add(fd)
    for (const [k, v] of fd.entries()) {
      if (!(v instanceof PDFRef)) continue
      const c = cands.get(refKey(v))
      if (!c) continue
      if (first) c.seen++
      map.set(k.decodeText(), c)
    }
    return map
  }
  const scanStream = (bytes: Uint8Array | null, res: PDFObject | undefined): void => {
    const fonts = walkResources(res)
    if (!bytes) {
      for (const c of fonts.values()) c.unknown = true
      return
    }
    if (fonts.size === 0) return
    if (!scanContent(bytes, fonts)) for (const c of fonts.values()) c.unknown = true
  }

  let pages: ReturnType<PDFDocument['getPages']> = []
  try {
    pages = pdf.getPages()
  } catch {
    return report
  }
  for (const page of pages) scanStream(contentOf(ctx, page.node.get(N('Contents'))), page.node.Resources() as PDFObject | undefined)
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue
    const sub = nameOf(ctx, obj.dict.get(N('Subtype')))
    const isPattern = numOf(ctx, obj.dict.get(N('PatternType'))) === 1
    if (sub !== 'Form' && !isPattern) continue
    const bytes = decodeStream(ctx, obj)
    if (!obj.dict.has(N('Resources'))) {
      // A form without resources borrows the page's: if it shows text we cannot tell which fonts, so play safe.
      if (!bytes || hasTextOps(bytes)) return report
      continue
    }
    scanStream(bytes, obj.dict.get(N('Resources')))
  }

  for (const c of cands.values()) {
    // Every reference to the font must have been seen in a resource dictionary we walked (AcroForm /DR, /DA users etc. are not).
    if (c.unknown || (counts.get(refKey(c.ref)) ?? 0) !== c.seen || c.seen === 0) continue
    const data = decodeStream(ctx, c.file)
    if (!data) continue
    const pruned = pruneTrueType(data, c.used)
    if (!pruned) continue
    const z = deflateMax(pruned.bytes)
    const before = encodedBytes(c.file).length
    if (z.length > before * 0.85) continue
    const dict = ctx.obj({}) as PDFDict
    for (const [k, v] of c.file.dict.entries()) {
      const key = k.decodeText()
      if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms' && key !== 'Length1' && key !== 'F') dict.set(k, v)
    }
    dict.set(N('Filter'), N('FlateDecode'))
    dict.set(N('Length1'), PDFNumber.of(pruned.bytes.length))
    dict.set(N('Length'), PDFNumber.of(z.length))
    ctx.assign(c.fileRef, PDFRawStream.of(dict, z))
    c.descriptor.delete(N('CIDSet')) // would list glyphs we emptied
    tagFontNames(ctx, c, before)
    report.subsetted++
    report.savedBytes += before - z.length
    report.replaced.push(refKey(c.fileRef))
  }
  return report
}

/** Subset fonts carry a six-letter tag in their name (ABCDEF+Name): tells other software this font is no longer complete. */
function tagFontNames(ctx: PDFContext, c: Candidate, seed: number): void {
  const name = nameOf(ctx, c.cidFont.get(N('BaseFont'))) ?? nameOf(ctx, c.descriptor.get(N('FontName'))) ?? 'Font'
  if (/^[A-Z]{6}\+/.test(name)) return
  let h = seed >>> 0
  for (const ch of name) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0) + 1
  let tag = ''
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26))
    h = Math.floor(h / 26) + 7919 * (i + 1)
  }
  const tagged = PDFName.of(`${tag}+${name}`)
  c.type0.set(N('BaseFont'), tagged)
  c.cidFont.set(N('BaseFont'), tagged)
  c.descriptor.set(N('FontName'), tagged)
  void ctx
}
