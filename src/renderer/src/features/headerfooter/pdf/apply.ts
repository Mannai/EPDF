import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, type PDFPage } from 'pdf-lib'
import type { HeaderFooterSettings, OverlaySettings, Slot } from '../../../../../shared/features/headerfooter'
import { makeTextXObject } from '../../../../../shared/text/pdf/draw'
import type { MissingChar } from '../../../../../shared/text/types'
import { geometryFor, geometryKey, geometryOf, invert, placeOverlay, readerMatrix, selectPages, visibleBox, normalizeRotation, type Matrix, type PageGeometry } from './geometry'
import { fmt, freeName, insertMarkStream, markContent, markStream, ocgFor, ownXObjects, pdfDate, pieceInfo, writeSettings, type Band } from './marks'
import { expandTokens, tokenValues } from './tokens'

/**
 * Writes headers/footers (and Bates numbers), watermarks and backgrounds into a pdf-lib document. All text goes
 * through the text engine (`makeTextXObject`: shaping, bidi, font fallback, subset fonts embedded once per document).
 * Each page gets one Form XObject per mark, placed in reader space (see ./geometry) and marked as described in
 * ./marks. Callers wrap this in `editPdf` so an application is one undo step.
 */

export class ApplyCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'ApplyCancelled'
  }
}

export interface ApplyOptions {
  /** Document file name, for {file}. */
  fileName: string
  now?: Date
  onProgress?(done: number, total: number): void
  isCancelled?(): boolean
  /** Yield to the event loop every this many pages (keeps the UI responsive). 0 = never. */
  yieldEvery?: number
  /**
   * Preview: draw only on these pages of `pdf`, numbered as page `index` of a document with `numPages` pages.
   * Default: every selected page of `pdf` itself.
   */
  only?: { index: number; page: PDFPage }[]
  numPages?: number
}

export interface ApplyResult {
  /** Pages that received the mark. */
  pages: number
  /** Characters no bundled font could draw (drawn as .notdef). */
  missing: string[]
}

/** The bytes (or an earlier Source XObject) for an image/PDF watermark or background. */
export type SourceInput = { bytes: Uint8Array; kind: 'png' | 'jpeg' | 'pdf' } | { ref: PDFRef }

const hexColor = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]
const cm = (m: Matrix): string => `${m.map(fmt).join(' ')} cm`
const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function targetsOf(pdf: PDFDocument, pages: HeaderFooterSettings['pages'], o: ApplyOptions): { targets: { index: number; page: PDFPage }[]; plan: number[] } {
  const numPages = o.numPages ?? pdf.getPageCount()
  const sel = selectPages(numPages, pages)
  if (!sel.ok) throw new Error(sel.error)
  const targets = o.only ? o.only.filter((t) => sel.pages.includes(t.index)) : sel.pages.map((i) => ({ index: i, page: pdf.getPage(i) }))
  return { targets, plan: sel.pages }
}

async function tick(i: number, total: number, o: ApplyOptions): Promise<void> {
  o.onProgress?.(i, total)
  if (o.isCancelled?.()) throw new ApplyCancelled()
  if (o.yieldEvery && i > 0 && i % o.yieldEvery === 0) {
    await new Promise((r) => setTimeout(r, 0))
    if (o.isCancelled?.()) throw new ApplyCancelled()
  }
}

function collectMissing(into: Set<string>, missing: MissingChar[]): void {
  for (const m of missing) into.add(m.char)
}

/** A Form XObject in reader space with the mark's /PieceInfo (and /OC). */
function markForm(pdf: PDFDocument, content: string, g: PageGeometry, resources: Record<string, unknown>, piece: ReturnType<typeof pieceInfo>, oc: PDFRef | null, now: Date): PDFRef {
  const ctx = pdf.context
  const dict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, g.width, g.height],
    Matrix: readerMatrix(g),
    Resources: ctx.obj(resources as never),
    PieceInfo: piece,
    LastModified: pdfDate(now)
  }
  if (oc) dict.OC = oc
  return ctx.register(ctx.flateStream(content, dict as never))
}

function attachMark(pdf: PDFDocument, page: PDFPage, form: PDFRef, group: 'headerfooter' | 'bates' | 'watermark' | 'background', band: Band | undefined, layer: 'behind' | 'front'): void {
  const xo = ownXObjects(page)
  const name = freeName(xo, 'EpdfMk')
  xo.set(PDFName.of(name), form)
  const stream = markStream(pdf, markContent(group, band, visibleBox(page), name), groupMarkName(group))
  insertMarkStream(pdf, page, stream, group, layer)
}

const groupMarkName = (g: 'headerfooter' | 'bates' | 'watermark' | 'background'): string =>
  g === 'headerfooter' ? 'HeaderFooter' : g === 'bates' ? 'Bates' : g === 'watermark' ? 'Watermark' : 'Background'

// ------------------------------------------------------------------------------------------------ headers and footers

const BANDS: { band: Band; slots: { slot: Slot; align: 'left' | 'center' | 'right' }[] }[] = [
  {
    band: 'Header',
    slots: [
      { slot: 'topLeft', align: 'left' },
      { slot: 'topCenter', align: 'center' },
      { slot: 'topRight', align: 'right' }
    ]
  },
  {
    band: 'Footer',
    slots: [
      { slot: 'bottomLeft', align: 'left' },
      { slot: 'bottomCenter', align: 'center' },
      { slot: 'bottomRight', align: 'right' }
    ]
  }
]

/** True if the settings would draw anything at all. */
export const hasHeaderFooterText = (s: HeaderFooterSettings): boolean => Object.values(s.slots).some((t) => t.trim() !== '')

export async function applyHeaderFooter(pdf: PDFDocument, group: 'headerfooter' | 'bates', s: HeaderFooterSettings, o: ApplyOptions): Promise<ApplyResult> {
  if (!hasHeaderFooterText(s)) throw new Error('Type the text of at least one header or footer.')
  const now = o.now ?? new Date()
  const { targets, plan } = targetsOf(pdf, s.pages, o)
  const settingsRef = writeSettings(pdf, group, s, now)
  const id = newId()
  const missing = new Set<string>()
  const color = hexColor(s.font.color)
  const style = { size: s.font.size, color, fontStack: [s.font.family], weight: s.font.bold ? ('bold' as const) : ('normal' as const), italic: s.font.italic, direction: s.direction }
  const padX = s.font.size * 0.5
  const padY = s.font.size * 0.25
  const first = plan[0]!
  const last = plan[plan.length - 1]!
  const ordinalOf = new Map(plan.map((p, i) => [p, i]))
  // Identical text at an identical width is laid out and embedded once (static headers, same-size pages).
  const cache = new Map<string, Awaited<ReturnType<typeof makeTextXObject>>>()

  for (let i = 0; i < targets.length; i++) {
    await tick(i, targets.length, o)
    const { index, page } = targets[i]!
    const g = geometryOf(page)
    const values = tokenValues(s, { pageIndex: index, firstIndex: first, lastIndex: last, ordinal: ordinalOf.get(index) ?? 0, fileName: o.fileName, now })
    const avail = Math.max(10, g.width - s.margins.left - s.margins.right)
    for (const b of BANDS) {
      const parts: string[] = []
      const xobjects: Record<string, PDFRef> = {}
      for (const { slot, align } of b.slots) {
        const text = expandTokens(s.slots[slot], values).replace(/\r\n?/g, '\n')
        if (text.trim() === '') continue
        const key = `${align}|${avail}|${text}`
        let xo = cache.get(key)
        if (!xo) {
          xo = await makeTextXObject(pdf, text, { ...style, align, width: avail + 2 * padX, padding: { x: padX, y: padY } })
          cache.set(key, xo)
          collectMissing(missing, xo.missing)
        }
        const x = s.margins.left - padX
        const y = b.band === 'Header' ? g.height - s.margins.top - (xo.height - padY) : s.margins.bottom - padY
        const n = `T${Object.keys(xobjects).length}`
        xobjects[n] = xo.ref
        parts.push(`q\n1 0 0 1 ${fmt(x)} ${fmt(y)} cm\n/${n} Do\nQ`)
      }
      if (parts.length === 0) continue
      const piece = pieceInfo(pdf, { group, band: b.band, settings: settingsRef, id, now })
      const form = markForm(pdf, parts.join('\n'), g, { XObject: xobjects }, piece, null, now)
      attachMark(pdf, page, form, group, b.band, 'front')
    }
  }
  o.onProgress?.(targets.length, targets.length)
  return { pages: targets.length, missing: [...missing] }
}

// ------------------------------------------------------------------------------------------------ watermarks and backgrounds

/** An upright Form XObject of the watermark/background source, with its natural size in points. */
export interface PreparedSource {
  ref: PDFRef
  width: number
  height: number
}

/** Reads the size of an earlier Source XObject (a form with /BBox [0 0 w h]). */
function sourceFromRef(pdf: PDFDocument, ref: PDFRef): PreparedSource {
  const s = pdf.context.lookup(ref)
  const bbox = s instanceof PDFStream ? s.dict.lookup(PDFName.of('BBox')) : undefined
  const nums = bbox instanceof PDFArray ? bbox.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)) : []
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error('The earlier watermark picture could not be found; choose the file again.')
  return { ref, width: nums[2]! - nums[0]!, height: nums[3]! - nums[1]! }
}

/** Embeds the image or PDF page as an upright Form XObject whose /BBox is [0 0 width height]. */
export async function prepareSource(pdf: PDFDocument, s: OverlaySettings, input: SourceInput | undefined, missing: Set<string>): Promise<PreparedSource | null> {
  const src = s.source
  const ctx = pdf.context
  if (src.kind === 'color') return null
  if (input && 'ref' in input) return sourceFromRef(pdf, input.ref)
  if (src.kind === 'text') {
    if (src.text.trim() === '') throw new Error('Type the watermark text.')
    const pad = src.font.size * 0.2
    const xo = await makeTextXObject(pdf, src.text.replace(/\r\n?/g, '\n'), {
      size: src.font.size,
      color: hexColor(src.font.color),
      fontStack: [src.font.family],
      weight: src.font.bold ? 'bold' : 'normal',
      italic: src.font.italic,
      direction: src.direction,
      align: 'center',
      padding: pad
    })
    collectMissing(missing, xo.missing)
    return { ref: xo.ref, width: xo.width, height: xo.height }
  }
  if (!input) throw new Error(src.kind === 'image' ? 'Choose a PNG or JPEG picture.' : 'Choose a PDF file.')
  if (src.kind === 'image') {
    let img
    try {
      img = input.kind === 'png' ? await pdf.embedPng(input.bytes) : input.kind === 'jpeg' ? await pdf.embedJpg(input.bytes) : null
    } catch (err) {
      throw new Error(`The picture could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!img) throw new Error('Choose a PNG or JPEG picture.')
    const w = img.width
    const h = img.height
    const ref = ctx.register(
      ctx.flateStream(`q\n${fmt(w)} 0 0 ${fmt(h)} 0 0 cm\n/Im0 Do\nQ`, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, w, h], Resources: ctx.obj({ XObject: ctx.obj({ Im0: img.ref }) }) } as never)
    )
    return { ref, width: w, height: h }
  }
  // A page of another PDF.
  if (input.kind !== 'pdf') throw new Error('Choose a PDF file.')
  let srcDoc: PDFDocument
  try {
    srcDoc = await PDFDocument.load(input.bytes, { updateMetadata: false })
  } catch (err) {
    const enc = err instanceof Error && /encrypt/i.test(err.message)
    throw new Error(enc ? 'That PDF is password protected. Remove its protection first, or choose another file.' : `That PDF could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (src.page > srcDoc.getPageCount()) throw new Error(`That PDF has only ${srcDoc.getPageCount()} page${srcDoc.getPageCount() === 1 ? '' : 's'}.`)
  const sp = srcDoc.getPage(src.page - 1)
  const box = visibleBox(sp)
  let embedded
  try {
    embedded = await pdf.embedPage(sp, { left: box[0], bottom: box[1], right: box[2], top: box[3] })
  } catch (err) {
    throw new Error(`That page could not be used: ${err instanceof Error ? err.message : String(err)}`)
  }
  // The embedded form's space is the source page's box moved to the origin; show it the way a reader shows that page.
  const g = geometryFor([0, 0, box[2] - box[0], box[3] - box[1]], normalizeRotation(sp.getRotation().angle))
  const toUpright = invert(readerMatrix(g))
  const ref = ctx.register(
    ctx.flateStream(`q\n${cm(toUpright)}\n/P0 Do\nQ`, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, g.width, g.height], Resources: ctx.obj({ XObject: ctx.obj({ P0: embedded.ref }) }) } as never)
  )
  return { ref, width: g.width, height: g.height }
}

export const DEFAULT_OVERLAY_YIELD = 25

export async function applyOverlay(pdf: PDFDocument, group: 'watermark' | 'background', s: OverlaySettings, input: SourceInput | undefined, o: ApplyOptions): Promise<ApplyResult & { source: PDFRef | null }> {
  if (!s.print && !s.screen) throw new Error('Choose to show it on screen, when printing, or both.')
  if (group === 'watermark' && s.source.kind === 'color') throw new Error('A watermark needs text, a picture or a PDF page.')
  const now = o.now ?? new Date()
  const { targets } = targetsOf(pdf, s.pages, o)
  const missing = new Set<string>()
  const source = await prepareSource(pdf, s, input, missing)
  const settingsRef = writeSettings(pdf, group, s, now)
  const id = newId()
  const oc = ocgFor(pdf, group, s.print, s.screen)
  const layer = group === 'background' ? 'behind' : s.layer
  const ctx = pdf.context
  const gs = s.opacity < 1 ? ctx.register(ctx.obj({ Type: 'ExtGState', ca: s.opacity, CA: s.opacity })) : null
  const forms = new Map<string, PDFRef>()

  for (let i = 0; i < targets.length; i++) {
    await tick(i, targets.length, o)
    const { page } = targets[i]!
    const g = geometryOf(page)
    const key = geometryKey(g)
    let form = forms.get(key)
    if (!form) {
      let drawing: string
      const res: Record<string, unknown> = {}
      if (!source) {
        const c = hexColor(s.source.kind === 'color' ? s.source.color : '#ffffff')
        drawing = `${c.map(fmt).join(' ')} rg\n0 0 ${fmt(g.width)} ${fmt(g.height)} re\nf`
      } else {
        const p = placeOverlay(source.width, source.height, g.width, g.height, s)
        drawing = `q\n${cm(p.matrix)}\n/S0 Do\nQ`
        res.XObject = ctx.obj({ S0: source.ref })
      }
      let content: string
      let resources: Record<string, unknown>
      if (gs) {
        // Opacity applies to the mark as a whole (an isolated transparency group), so overlapping glyphs and
        // picture pixels do not get darker where they overlap.
        const group = ctx.register(
          ctx.flateStream(drawing, {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: [0, 0, g.width, g.height],
            Group: ctx.obj({ Type: 'Group', S: 'Transparency', I: true }),
            Resources: ctx.obj(res as never)
          } as never)
        )
        content = `/GS0 gs\n/G0 Do`
        resources = { ExtGState: ctx.obj({ GS0: gs }), XObject: ctx.obj({ G0: group }) }
      } else {
        content = drawing
        resources = res
      }
      const piece = pieceInfo(pdf, { group, settings: settingsRef, source: source?.ref, id, now })
      form = markForm(pdf, content, g, resources, piece, oc, now)
      forms.set(key, form)
    }
    attachMark(pdf, page, form, group, undefined, layer)
  }
  o.onProgress?.(targets.length, targets.length)
  return { pages: targets.length, missing: [...missing], source: source?.ref ?? null }
}
