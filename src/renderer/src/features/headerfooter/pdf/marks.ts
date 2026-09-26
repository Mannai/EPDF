import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib'
import type { MarkGroup } from '../../../../../shared/features/headerfooter'
import { streamBytes } from '../../textedit/pdfcontent/pdfutil'

/**
 * How Epdf marks what it adds, so it can find, update and remove it later (also after saving and reopening), and so
 * other software treats it as pagination/watermark artifacts rather than body text.
 *
 * Every mark on a page is ONE Form XObject drawn from its own small content stream:
 *
 *   /Artifact << /Type /Pagination /Subtype /Header /EpdfMark /HeaderFooter >> BDC   (Tagged PDF artifact, ISO 32000 14.8.2.2)
 *   q /EpdfMk0 Do Q
 *   EMC
 *
 * - Header/footer and Bates: /Type /Pagination /Subtype /Header or /Footer. Watermark: /Type /Pagination /Subtype
 *   /Watermark. Background: /Type /Background with the /BBox the spec requires for that type. These are the artifact
 *   types Acrobat itself writes, so screen readers, "Save as text", reflow and accessibility checkers skip them.
 * - The Form XObject carries /PieceInfo (ISO 32000 14.5, page-piece dictionaries) with two entries:
 *   `ADBE_CompoundType << /Private /Header|/Footer|/Watermark|/Background /LastModified … >>`, the entry Acrobat uses
 *   to recognise its own headers, footers, watermarks and backgrounds (its "Remove" commands look for it), and
 *   `EpdfPageMarks << /LastModified … /Private << /Group … /Band … /Settings ref /Source ref /Id … >> >>` with Epdf's
 *   own data: the settings JSON (shared by all pages of one application) and the image / imported page it drew.
 * - Watermarks and backgrounds carry /OC (an optional content group named "Watermark"/"Background" whose /Usage has
 *   /PageElement /FG or /BG and /Print, /View states, with /AS auto-states), like Acrobat's, which gives
 *   "show when printing / on screen".
 * - The page content stream holding the mark has `/EpdfMark /<Group>` in its stream dictionary; front marks are drawn
 *   after the page's original content wrapped in `q … Q` (streams marked /WrapOpen and /WrapClose) so its graphics
 *   state cannot leak into the mark.
 */

export const PIECE_KEY = 'EpdfPageMarks'
export const ADOBE_PIECE_KEY = 'ADBE_CompoundType'
/** Key in BDC property lists, content stream dictionaries, OCGs: Epdf's own marker. */
export const MARK_KEY = 'EpdfMark'
export const WRAP_OPEN = 'WrapOpen'
export const WRAP_CLOSE = 'WrapClose'

export type Band = 'Header' | 'Footer'

/** The PDF name Epdf writes for each group. */
export const GROUP_NAME: Record<MarkGroup, string> = { headerfooter: 'HeaderFooter', bates: 'Bates', watermark: 'Watermark', background: 'Background' }
const GROUP_OF_NAME = new Map<string, MarkGroup>(Object.entries(GROUP_NAME).map(([g, n]) => [n, g as MarkGroup]))

/** Acrobat's `/Private` value for marks of a group (headers/footers use the band). */
export const adobePrivate = (group: MarkGroup, band?: Band): string => (group === 'watermark' ? 'Watermark' : group === 'background' ? 'Background' : (band ?? 'Header'))
/** Which group an Acrobat-made mark belongs to (Acrobat's Bates numbers are headers/footers too). */
export const groupOfAdobe = (priv: string): MarkGroup | null => (priv === 'Header' || priv === 'Footer' ? 'headerfooter' : priv === 'Watermark' ? 'watermark' : priv === 'Background' ? 'background' : null)

const N = (s: string): PDFName => PDFName.of(s)

/** PDF date string (D:YYYYMMDDHHmmSS+00'00'). */
export function pdfDate(d: Date): PDFString {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  return PDFString.of(`D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)
}

/** The artifact property list written before a mark (inline in the content stream). */
export function artifactProps(group: MarkGroup, band: Band | undefined, box: [number, number, number, number]): string {
  const mark = `/${MARK_KEY} /${GROUP_NAME[group]}`
  if (group === 'background') return `<< /Type /Background /BBox [${box.map(fmt).join(' ')}] ${mark} >>`
  const sub = group === 'watermark' ? 'Watermark' : (band ?? 'Header')
  return `<< /Type /Pagination /Subtype /${sub} ${mark} >>`
}

export const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000
  return Object.is(r, -0) ? '0' : String(r)
}

export interface MarkInfo {
  group: MarkGroup
  band?: Band
  settings: PDFRef
  source?: PDFRef
  id: string
  now: Date
}

/** The /PieceInfo dictionary of a mark's Form XObject. */
export function pieceInfo(pdf: PDFDocument, m: MarkInfo): PDFDict {
  const ctx = pdf.context
  const date = pdfDate(m.now)
  const priv: Record<string, PDFObject> = { Group: N(GROUP_NAME[m.group]), Settings: m.settings, Id: PDFString.of(m.id) }
  if (m.band) priv.Band = N(m.band)
  if (m.source) priv.Source = m.source
  return ctx.obj({
    [ADOBE_PIECE_KEY]: ctx.obj({ LastModified: date, Private: N(adobePrivate(m.group, m.band)) }),
    [PIECE_KEY]: ctx.obj({ LastModified: date, Private: ctx.obj(priv) })
  })
}

/** Stores the settings of one application (JSON, compressed); shared by all its marks. */
export function writeSettings(pdf: PDFDocument, group: MarkGroup, settings: unknown, now: Date): PDFRef {
  const json = JSON.stringify({ v: 1, group, appliedAt: now.toISOString(), settings })
  return pdf.context.register(pdf.context.flateStream(new TextEncoder().encode(json), { [MARK_KEY]: N('Settings') }))
}

export function readSettings(pdf: PDFDocument, ref: PDFRef | undefined): { group?: string; settings?: unknown; appliedAt?: string } | null {
  if (!ref) return null
  try {
    const s = pdf.context.lookup(ref)
    if (!(s instanceof PDFStream)) return null
    const v = JSON.parse(new TextDecoder().decode(streamBytes(s))) as { group?: string; settings?: unknown; appliedAt?: string }
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------------------------ reading marks

export interface FoundMark {
  /** Resource name on the page. */
  name: string
  ref: PDFRef | null
  group: MarkGroup
  band?: Band
  /** Made by other software (recognised by Acrobat's ADBE_CompoundType), not by Epdf. */
  foreign: boolean
  settings?: PDFRef
  source?: PDFRef
  id?: string
}

const nameOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? o.decodeText() : undefined)
const refOf = (o: PDFObject | undefined): PDFRef | undefined => (o instanceof PDFRef ? o : undefined)
const textOf = (o: PDFObject | undefined): string | undefined => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined)

/** Classifies one XObject: an Epdf mark, an Acrobat-style mark, or nothing. */
export function classifyXObject(pdf: PDFDocument, value: PDFObject | undefined): Omit<FoundMark, 'name'> | null {
  const ref = value instanceof PDFRef ? value : null
  let obj: PDFObject | undefined
  try {
    obj = ref ? pdf.context.lookup(ref) : value
  } catch {
    return null
  }
  if (!(obj instanceof PDFStream)) return null
  const pi = obj.dict.lookup(N('PieceInfo'))
  if (!(pi instanceof PDFDict)) return null
  const ours = pi.lookup(N(PIECE_KEY))
  if (ours instanceof PDFDict) {
    const priv = ours.lookup(N('Private'))
    if (priv instanceof PDFDict) {
      const group = GROUP_OF_NAME.get(nameOf(priv.lookup(N('Group'))) ?? '')
      if (group) {
        const band = nameOf(priv.lookup(N('Band')))
        return {
          ref,
          group,
          band: band === 'Header' || band === 'Footer' ? band : undefined,
          foreign: false,
          settings: refOf(priv.get(N('Settings'))),
          source: refOf(priv.get(N('Source'))),
          id: textOf(priv.lookup(N('Id')))
        }
      }
    }
  }
  const adobe = pi.lookup(N(ADOBE_PIECE_KEY))
  if (adobe instanceof PDFDict) {
    const priv = nameOf(adobe.lookup(N('Private')))
    const group = priv ? groupOfAdobe(priv) : null
    if (group) return { ref, group, band: priv === 'Header' || priv === 'Footer' ? priv : undefined, foreign: true }
  }
  return null
}

/** The page's XObject resources dictionary (inherited resources included), or undefined. */
export function xobjectsOf(page: PDFPage): PDFDict | undefined {
  try {
    const res = page.node.Resources()
    const x = res?.lookup(N('XObject'))
    return x instanceof PDFDict ? x : undefined
  } catch {
    return undefined
  }
}

/** Marks (Epdf's and Acrobat-style) referenced from a page's resources. */
export function findMarks(pdf: PDFDocument, page: PDFPage): FoundMark[] {
  const xo = xobjectsOf(page)
  if (!xo) return []
  const out: FoundMark[] = []
  for (const [k, v] of xo.entries()) {
    const c = classifyXObject(pdf, v)
    if (c) out.push({ name: k.decodeText(), ...c })
  }
  return out
}

// ------------------------------------------------------------------------------------------------ page resources and contents

/**
 * Gives the page its own /Resources and /XObject dictionaries (shallow copies) if they are inherited or shared, so
 * adding a mark to one page never adds names to other pages. Returns the page's XObject dictionary.
 */
export function ownXObjects(page: PDFPage): PDFDict {
  const node = page.node
  const ctx = node.context
  const ownRaw = node.get(N('Resources'))
  let res: PDFDict
  if (ownRaw instanceof PDFDict) res = ownRaw
  else {
    const inherited = node.Resources()
    res = inherited ? (inherited.clone(ctx) as PDFDict) : ctx.obj({})
    node.set(N('Resources'), res)
  }
  const xRaw = res.get(N('XObject'))
  let xo: PDFDict
  if (xRaw instanceof PDFDict) xo = xRaw
  else {
    const looked = xRaw ? ctx.lookupMaybe(xRaw, PDFDict) : undefined
    xo = looked ? (looked.clone(ctx) as PDFDict) : ctx.obj({})
    res.set(N('XObject'), xo)
  }
  return xo
}

/** A resource name not used on the page yet. */
export function freeName(xo: PDFDict, prefix: string): string {
  const used = new Set(xo.keys().map((k) => k.decodeText()))
  for (let i = 0; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`
}

/** The page's /Contents as a list of references (direct streams are registered; nothing else changes). */
export function contentRefs(page: PDFPage): PDFRef[] {
  const node = page.node
  const ctx = node.context
  const raw = node.get(N('Contents'))
  if (!raw) return []
  if (raw instanceof PDFRef) {
    const o = ctx.lookup(raw)
    if (o instanceof PDFArray) return arrayRefs(page, o)
    return [raw]
  }
  if (raw instanceof PDFArray) return arrayRefs(page, raw)
  if (raw instanceof PDFStream) return [ctx.register(raw)]
  return []
}

function arrayRefs(page: PDFPage, arr: PDFArray): PDFRef[] {
  const out: PDFRef[] = []
  for (let i = 0; i < arr.size(); i++) {
    const e = arr.get(i)
    if (e instanceof PDFRef) out.push(e)
    else if (e instanceof PDFStream) out.push(page.node.context.register(e))
  }
  return out
}

export function setContents(page: PDFPage, refs: PDFRef[]): void {
  page.node.set(N('Contents'), page.node.context.obj(refs))
}

/** The /EpdfMark value of a content stream's dictionary, if Epdf wrote that stream. */
export function streamMark(pdf: PDFDocument, ref: PDFRef): string | undefined {
  try {
    const s = pdf.context.lookup(ref)
    return s instanceof PDFStream ? nameOf(s.dict.lookup(N(MARK_KEY))) : undefined
  } catch {
    return undefined
  }
}

const latin1 = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

/** A small uncompressed content stream written by Epdf, tagged with `/EpdfMark /<mark>`. */
export function markStream(pdf: PDFDocument, content: string, mark: string): PDFRef {
  return pdf.context.register(pdf.context.stream(latin1(content), { [MARK_KEY]: N(mark) }))
}

/**
 * Adds the stream that draws a mark to the page, behind the page content (backgrounds first, then behind-watermarks)
 * or in front of it (after the original content, which is wrapped in q … Q once).
 */
export function insertMarkStream(pdf: PDFDocument, page: PDFPage, stream: PDFRef, group: MarkGroup, layer: 'behind' | 'front'): void {
  const refs = contentRefs(page)
  const bg = GROUP_NAME.background
  if (layer === 'behind') {
    let i = 0
    if (group !== 'background') while (i < refs.length && streamMark(pdf, refs[i]!) === bg) i++
    refs.splice(i, 0, stream)
    setContents(page, refs)
    return
  }
  const marks = refs.map((r) => streamMark(pdf, r))
  const open = marks.indexOf(WRAP_OPEN)
  const close = marks.lastIndexOf(WRAP_CLOSE)
  if (!(open >= 0 && close > open)) {
    // Wrap the original content (everything that is not a behind-mark at the start) in q … Q.
    let i = 0
    while (i < refs.length && (marks[i] === bg || marks[i] === GROUP_NAME.watermark)) i++
    refs.splice(i, 0, markStream(pdf, 'q\n', WRAP_OPEN))
    refs.push(markStream(pdf, '\nQ\n', WRAP_CLOSE))
  }
  refs.push(stream)
  setContents(page, refs)
}

/** The content of a mark's stream: the artifact sequence that draws the Form XObject `name`. */
export function markContent(group: MarkGroup, band: Band | undefined, box: [number, number, number, number], name: string): string {
  return `\n/Artifact ${artifactProps(group, band, box)} BDC\nq\n/${name} Do\nQ\nEMC\n`
}

// ------------------------------------------------------------------------------------------------ optional content

export const OCG_NAMES: Partial<Record<MarkGroup, string>> = { watermark: 'Watermark', background: 'Background' }

/**
 * The optional content group for a watermark/background with the given visibility (created once per document and
 * setting), registered in /OCProperties the way Acrobat does it: ON in the default configuration, with /Usage print and
 * view states and /AS auto-states for the View and Print events, so viewers that follow usage hide it on screen or in
 * print. (PDF.js follows /Usage for its display and print intents.)
 */
export function ocgFor(pdf: PDFDocument, group: MarkGroup, print: boolean, screen: boolean): PDFRef | null {
  const label = OCG_NAMES[group]
  if (!label) return null
  const ctx = pdf.context
  const catalog = pdf.catalog
  let props = catalog.lookup(N('OCProperties'))
  if (!(props instanceof PDFDict)) {
    props = ctx.obj({ OCGs: [], D: ctx.obj({ Order: [], ON: [], OFF: [], AS: [] }) })
    catalog.set(N('OCProperties'), props)
  }
  const pd = props as PDFDict
  const ocgs = arrayIn(pdf, pd, 'OCGs')
  const variant = `${print ? 'P' : 'p'}${screen ? 'S' : 's'}`
  for (let i = 0; i < ocgs.size(); i++) {
    const r = ocgs.get(i)
    if (!(r instanceof PDFRef)) continue
    const g = ctx.lookup(r)
    if (g instanceof PDFDict && nameOf(g.lookup(N(MARK_KEY))) === GROUP_NAME[group] && textOf(g.lookup(N('EpdfVisibility'))) === variant) return r
  }
  const ocg = ctx.register(
    ctx.obj({
      Type: 'OCG',
      Name: PDFString.of(label),
      [MARK_KEY]: N(GROUP_NAME[group]),
      EpdfVisibility: PDFString.of(variant),
      Usage: ctx.obj({
        CreatorInfo: ctx.obj({ Creator: PDFString.of('Epdf'), Subtype: 'Artwork' }),
        PageElement: ctx.obj({ Subtype: group === 'background' ? 'BG' : 'FG' }),
        Print: ctx.obj({ PrintState: print ? 'ON' : 'OFF' }),
        View: ctx.obj({ ViewState: screen ? 'ON' : 'OFF' }),
        Export: ctx.obj({ ExportState: 'ON' })
      })
    })
  )
  ocgs.push(ocg)
  let d = pd.lookup(N('D'))
  if (!(d instanceof PDFDict)) {
    d = ctx.obj({})
    pd.set(N('D'), d)
  }
  const dd = d as PDFDict
  arrayIn(pdf, dd, 'Order').push(ocg)
  arrayIn(pdf, dd, 'ON').push(ocg)
  const as = arrayIn(pdf, dd, 'AS')
  for (const [event, category] of [
    ['View', 'View'],
    ['Print', 'Print'],
    ['Export', 'Export']
  ] as const) {
    let entry: PDFDict | undefined
    for (let i = 0; i < as.size(); i++) {
      const e = as.lookup(i)
      if (e instanceof PDFDict && nameOf(e.lookup(N('Event'))) === event && e.lookup(N(MARK_KEY))) entry = e
    }
    if (!entry) {
      entry = ctx.obj({ Event: event, Category: [category], OCGs: [], [MARK_KEY]: N('AutoState') })
      as.push(entry)
    }
    arrayIn(pdf, entry, 'OCGs').push(ocg)
  }
  return ocg
}

/** An array entry of a dictionary, created (or made direct) if needed. */
export function arrayIn(pdf: PDFDocument, d: PDFDict, key: string): PDFArray {
  const v = d.lookup(N(key))
  if (v instanceof PDFArray) return v
  const a = pdf.context.obj([])
  d.set(N(key), a)
  return a
}

/** Removes Epdf's optional content groups that no mark uses any more (and /OCProperties if it is left empty). */
export function pruneOcgs(pdf: PDFDocument, stillUsed: Set<string>): PDFRef[] {
  const ctx = pdf.context
  const props = pdf.catalog.lookup(N('OCProperties'))
  if (!(props instanceof PDFDict)) return []
  const ocgs = props.lookup(N('OCGs'))
  if (!(ocgs instanceof PDFArray)) return []
  const drop: PDFRef[] = []
  for (let i = 0; i < ocgs.size(); i++) {
    const r = ocgs.get(i)
    if (!(r instanceof PDFRef) || stillUsed.has(r.toString())) continue
    const g = ctx.lookup(r)
    if (g instanceof PDFDict && g.lookup(N(MARK_KEY))) drop.push(r)
  }
  if (drop.length === 0) return []
  const dropSet = new Set(drop.map((r) => r.toString()))
  const filter = (a: PDFObject | undefined): void => {
    if (!(a instanceof PDFArray)) return
    for (let i = a.size() - 1; i >= 0; i--) {
      const e = a.get(i)
      if (e instanceof PDFRef && dropSet.has(e.toString())) a.remove(i)
      else if (e instanceof PDFArray) filter(e)
    }
  }
  filter(ocgs)
  const scrub = (d: PDFObject | undefined): void => {
    if (!(d instanceof PDFDict)) return
    for (const k of ['Order', 'ON', 'OFF', 'Locked', 'RBGroups']) filter(d.lookup(N(k)))
    const as = d.lookup(N('AS'))
    if (as instanceof PDFArray) {
      for (let i = as.size() - 1; i >= 0; i--) {
        const e = as.lookup(i)
        if (e instanceof PDFDict) {
          filter(e.lookup(N('OCGs')))
          const left = e.lookup(N('OCGs'))
          if (e.lookup(N(MARK_KEY)) && left instanceof PDFArray && left.size() === 0) as.remove(i)
        }
      }
    }
  }
  scrub(props.lookup(N('D')))
  const configs = props.lookup(N('Configs'))
  if (configs instanceof PDFArray) for (let i = 0; i < configs.size(); i++) scrub(configs.lookup(i))
  if (ocgs.size() === 0) pdf.catalog.delete(N('OCProperties'))
  return drop
}
