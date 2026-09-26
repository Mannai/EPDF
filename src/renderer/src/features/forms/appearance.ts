import {
  PDFArray,
  PDFButton,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  type PDFDocument,
  type PDFField,
  type PDFWidgetAnnotation
} from 'pdf-lib'
import {
  embeddedFontsFor,
  ensureTextEngine,
  isWinAnsiText,
  makeTextXObject,
  measureText,
  uncoveredChars,
  type TextColor,
  type TextFont,
  type TextXObject
} from '@shared/text'
import { UnsupportedCharactersError } from './fonts'

/**
 * Appearance streams (/AP /N) of form fields whose text the standard fonts cannot encode (Arabic, Hebrew, Indic,
 * Thai, CJK, Cyrillic, ...), drawn by the text engine. Pure pdf-lib + engine, no DOM; unit-tested in Node.
 *
 * What is written (see docs/features/forms-signing.md, "Right-to-left and other scripts in fields"):
 *   - /V stays the logical string (pdf-lib's setText / select, UTF-16);
 *   - /AP /N is a form XObject with the widget's background and border, a clip, and `/Tx BMC ... EMC` around the text,
 *     which is a nested engine form XObject (`makeTextXObject`): shaped, right-to-left where needed, subset Type0 fonts
 *     with /ToUnicode and /ActualText;
 *   - the field's /DA names the engine font (the one drawing most of the text) and that font is added to the
 *     AcroForm /DR under the same name (`EpdfSans`, `EpdfSerifBd`, ... + `_2` when taken), keeping the size (0 = auto)
 *     and colour of the old /DA;
 *   - /NeedAppearances is NOT set: readers draw these appearances as they are. (With NeedAppearances, PDF.js and
 *     pdfium redraw the field themselves without Arabic shaping.)
 * Alignment follows /Q: 1 = centre, 2 = right; 0 (the default) means "start", i.e. right for right-to-left text.
 */

const N = PDFName.of

export type FontFamily = 'sans' | 'serif' | 'mono'

/** Engine font stacks that match the standard fonts' look (metric-compatible Liberation fonts), fallbacks added by the engine. */
export const FAMILY_STACK: Record<FontFamily, string[]> = { sans: ['Helvetica'], serif: ['Times'], mono: ['Courier'] }

/** The family and weight a /DA font name stands for (`/Helv`, `/TiBo`, `/Courier-Bold`, `/EpdfSerifBd_2`, `/ArialMT` ...). */
export function familyOfFontName(name: string | undefined): { family: FontFamily; bold: boolean } {
  const n = (name ?? '').toLowerCase()
  const epdf = /^epdf(sans|serif|mono)(bd)?(?:_\d+)?$/.exec(n)
  if (epdf) return { family: epdf[1] as FontFamily, bold: !!epdf[2] }
  const bold = /bo(ld)?\b|bd|^hebo|^tibo|^cobo|heavy|black/.test(n)
  if (/^co|courier|mono/.test(n)) return { family: 'mono', bold }
  if (/^ti|times|serif|georgia|garamond|naskh/.test(n) && !/sans/.test(n)) return { family: 'serif', bold }
  return { family: 'sans', bold }
}

const drName = (f: { family: FontFamily; bold: boolean }): string => `Epdf${f.family[0].toUpperCase()}${f.family.slice(1)}${f.bold ? 'Bd' : ''}`

// ---------------------------------------------------------------------------------------------------------
// /DA

export interface ParsedDA {
  font?: string
  /** 0 = automatic. */
  size: number
  color: TextColor
  /** The colour operator as written (`0 0 1 rg`), to keep it when the font name changes. */
  colorOp: string
}

export function parseDA(da: string | undefined): ParsedDA {
  const out: ParsedDA = { size: 0, color: 0, colorOp: '0 g' }
  if (!da) return out
  const tf = [...da.matchAll(/\/([^\s/]+)\s+(-?\d*\.?\d+)\s+Tf/g)].pop()
  if (tf) {
    out.font = tf[1]
    out.size = Math.max(0, Number(tf[2]) || 0)
  }
  for (const m of da.matchAll(/((?:-?\d*\.?\d+)(?:\s+-?\d*\.?\d+){0,3})\s+(g|rg|k)\b/g)) {
    const nums = m[1].split(/\s+/).map(Number)
    if (m[2] === 'g' && nums.length === 1) out.color = nums[0]
    else if (m[2] === 'rg' && nums.length === 3) out.color = nums as [number, number, number]
    else if (m[2] === 'k' && nums.length === 4) out.color = nums as [number, number, number, number]
    else continue
    out.colorOp = `${m[1]} ${m[2]}`
  }
  return out
}

function stringOf(o: unknown): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined
}

/** The /DA in effect for a widget: its own, else the field's (inherited), else the AcroForm's. */
function effectiveDA(pdf: PDFDocument, field: PDFField, widget: PDFWidgetAnnotation): { da: string | undefined; onWidget: boolean } {
  const own = stringOf(widget.dict.lookup(N('DA')))
  if (own) return { da: own, onWidget: true }
  const inherited = stringOf(field.acroField.getInheritableAttribute(N('DA')))
  if (inherited) return { da: inherited, onWidget: false }
  return { da: stringOf(pdf.getForm().acroForm.dict.lookup(N('DA'))), onWidget: false }
}

// ---------------------------------------------------------------------------------------------------------
// what a field shows

/** The text a field's appearance shows (value, selection, options, caption). */
export function displayedTexts(field: PDFField): string[] {
  try {
    if (field instanceof PDFTextField) return [field.getText() ?? '']
    if (field instanceof PDFDropdown) return [field.getSelected()[0] ?? '']
    if (field instanceof PDFOptionList) return field.getOptions()
    if (field instanceof PDFButton) {
      return field.acroField.getWidgets().map((w) => w.getAppearanceCharacteristics()?.getCaptions()?.normal ?? '')
    }
  } catch {
    /* unreadable field: nothing to draw */
  }
  return []
}

/** True if the field shows text the standard fonts cannot encode (its appearance must come from the engine). */
export function needsEngineAppearance(field: PDFField): boolean {
  return displayedTexts(field).some((t) => !isWinAnsiText(t))
}

/** The engine font stack of a field: from its /DA font (standard-font look), fallbacks for every script appended. */
export function fieldStack(pdf: PDFDocument, field: PDFField): { fontStack: string[]; weight: 'bold' | 'normal'; family: FontFamily; bold: boolean } {
  const w = field.acroField.getWidgets()[0]
  const da = parseDA(w ? effectiveDA(pdf, field, w).da : stringOf(field.acroField.getInheritableAttribute(N('DA'))))
  const f = familyOfFontName(da.font)
  return { fontStack: FAMILY_STACK[f.family], weight: f.bold ? 'bold' : 'normal', ...f }
}

/** Throws `UnsupportedCharactersError` when no bundled font can draw some character of `text` (nothing is changed then). */
export async function assertDrawable(text: string, fontStack: string[] = FAMILY_STACK.sans): Promise<void> {
  if (isWinAnsiText(text)) return
  const bad = await uncoveredChars(text, { fontStack })
  if (bad.length > 0) throw new UnsupportedCharactersError(bad)
}

// ---------------------------------------------------------------------------------------------------------
// drawing

const num = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

function colorOps(c: number[], stroke: boolean): string {
  const v = c.map(num).join(' ')
  if (c.length === 1) return `${v} ${stroke ? 'G' : 'g'}`
  if (c.length === 4) return `${v} ${stroke ? 'K' : 'k'}`
  return `${v} ${stroke ? 'RG' : 'rg'}`
}

function components(dict: PDFDict | undefined, key: string): number[] | undefined {
  const a = dict?.lookupMaybe(N(key), PDFArray)
  if (!a || a.size() === 0) return undefined
  const out: number[] = []
  for (let i = 0; i < a.size(); i++) {
    const v = a.lookup(i)
    if (v instanceof PDFNumber) out.push(v.asNumber())
  }
  return out.length === 1 || out.length === 3 || out.length === 4 ? out : undefined
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemes = (s: string): string[] => (segmenter ? [...segmenter.segment(s)].map((g) => g.segment) : Array.from(s))

/** /Q of a field: 0 left (start), 1 centre, 2 right. */
function quadding(field: PDFField, widget: PDFWidgetAnnotation): number {
  const q = widget.dict.lookup(N('Q')) ?? field.acroField.getInheritableAttribute(N('Q'))
  return q instanceof PDFNumber ? q.asNumber() : 0
}

const alignOfQ = (q: number): 'start' | 'center' | 'right' => (q === 1 ? 'center' : q === 2 ? 'right' : 'start')

interface Placed {
  xo: TextXObject
  x: number
  y: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const MIN_SIZE = 4

/** Largest size in [MIN_SIZE, max] (0.5 pt steps) for which `fits(size)` holds; MIN_SIZE if none. */
async function fitSize(max: number, fits: (size: number) => Promise<boolean>): Promise<number> {
  let lo = MIN_SIZE
  let hi = Math.max(MIN_SIZE, max)
  if (await fits(hi)) return hi
  for (let i = 0; i < 12 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2
    if (await fits(mid)) lo = mid
    else hi = mid
  }
  return Math.floor(lo * 2) / 2
}

interface StyleIn {
  fontStack: string[]
  weight: 'bold' | 'normal'
  color: TextColor
}

/** Horizontal position of a single line of width `w` inside `box` for an alignment and the line's direction. */
function alignX(box: Box, w: number, align: 'start' | 'center' | 'right' | 'left', rtl: boolean): number {
  const a = align === 'start' ? (rtl ? 'right' : 'left') : align
  if (a === 'right') return box.x + box.w - w
  if (a === 'center') return box.x + (box.w - w) / 2
  return box.x
}

/** One unwrapped line: laid out once, placed by alignment, centred vertically. */
async function singleLine(pdf: PDFDocument, text: string, box: Box, size: number, st: StyleIn, align: 'start' | 'center' | 'right'): Promise<{ placed: Placed[]; size: number }> {
  let s = size
  if (s <= 0) {
    // Automatic size: as large as the box allows (width and height), like other readers do.
    const m = await measureText(text || ' ', { size: 12, fontStack: st.fontStack, weight: st.weight })
    const byW = m.width > 0 ? (box.w * 12) / m.width : Infinity
    const byH = m.height > 0 ? (box.h * 12) / m.height : 12
    s = Math.max(MIN_SIZE, Math.min(byW, byH, 500))
    s = Math.floor(s * 2) / 2
  }
  if (text === '') return { placed: [], size: s }
  const xo = await makeTextXObject(pdf, text, { size: s, fontStack: st.fontStack, weight: st.weight, color: st.color })
  const rtl = xo.layout.directions[0] === 'rtl'
  return { placed: [{ xo, x: alignX(box, xo.width, align, rtl), y: box.y + (box.h - xo.height) / 2 }], size: s }
}

async function multiLine(pdf: PDFDocument, text: string, box: Box, size: number, st: StyleIn, align: 'start' | 'center' | 'right'): Promise<{ placed: Placed[]; size: number }> {
  const opts = (s: number) => ({ size: s, width: Math.max(1, box.w), fontStack: st.fontStack, weight: st.weight, color: st.color, align })
  let s = size
  if (s <= 0) s = await fitSize(12, async (v) => (await measureText(text || ' ', opts(v))).height <= box.h)
  if (text === '') return { placed: [], size: s }
  const xo = await makeTextXObject(pdf, text, opts(s))
  return { placed: [{ xo, x: box.x, y: box.y + box.h - xo.height }], size: s }
}

async function combed(pdf: PDFDocument, text: string, box: Box, size: number, cells: number, st: StyleIn): Promise<{ placed: Placed[]; size: number }> {
  const chars = graphemes(text.replace(/[\r\n]+/g, ''))
  const n = Math.max(1, cells)
  const cellW = box.w / n
  let s = size
  if (s <= 0) {
    // Largest size at which every character fits 3/4 of a cell and the cell height.
    const probe = chars.length ? chars : ['0']
    s = await fitSize(Math.min(500, box.h), async (v) => {
      for (const c of new Set(probe)) {
        const m = await measureText(c, { size: v, fontStack: st.fontStack, weight: st.weight })
        if (m.width > cellW * 0.75 || m.height > box.h * 1.15) return false
      }
      return true
    })
  }
  const cache = new Map<string, TextXObject>()
  const placed: Placed[] = []
  for (let i = 0; i < Math.min(chars.length, n); i++) {
    const c = chars[i]
    let xo = cache.get(c)
    if (!xo) {
      xo = await makeTextXObject(pdf, c, { size: s, fontStack: st.fontStack, weight: st.weight, color: st.color })
      cache.set(c, xo)
    }
    placed.push({ xo, x: box.x + cellW * i + (cellW - xo.width) / 2, y: box.y + (box.h - xo.height) / 2 })
  }
  return { placed, size: s }
}

async function listLines(
  pdf: PDFDocument,
  options: string[],
  selected: Set<string>,
  box: Box,
  size: number,
  st: StyleIn
): Promise<{ placed: Placed[]; size: number; highlights: { y: number; h: number }[] }> {
  let s = size
  if (s <= 0) s = Math.max(MIN_SIZE, Math.min(12, Math.floor((box.h / Math.max(1, options.length) / 1.3) * 2) / 2))
  const lead = s * 1.3
  const placed: Placed[] = []
  const highlights: { y: number; h: number }[] = []
  let top = box.y + box.h
  for (const o of options) {
    const lineBox: Box = { x: box.x, y: top - lead, w: box.w, h: lead }
    if (selected.has(o)) highlights.push({ y: lineBox.y, h: lead })
    if (o !== '') {
      const xo = await makeTextXObject(pdf, o, { size: s, fontStack: st.fontStack, weight: st.weight, color: st.color })
      const rtl = xo.layout.directions[0] === 'rtl'
      placed.push({ xo, x: alignX(lineBox, xo.width, 'start', rtl), y: lineBox.y + (lead - xo.height) / 2 })
    }
    top -= lead
    if (top < box.y - lead) break
  }
  return { placed, size: s, highlights }
}

/** Marker on appearance streams written here, so a later redraw can delete the stale ones. */
const OWN_KEY = 'EpdfTextAP'

function deleteOwnAppearance(pdf: PDFDocument, widget: PDFWidgetAnnotation): void {
  const ap = widget.dict.lookupMaybe(N('AP'), PDFDict)
  const n = ap?.get(N('N'))
  if (!(n instanceof PDFRef)) return
  const s = pdf.context.lookup(n)
  if (!(s instanceof PDFStream) || !s.dict.has(N(OWN_KEY))) return
  const xobjects = s.dict.lookupMaybe(N('Resources'), PDFDict)?.lookupMaybe(N('XObject'), PDFDict)
  for (const k of xobjects?.keys() ?? []) {
    const r = xobjects!.get(k)
    if (r instanceof PDFRef) pdf.context.delete(r)
  }
  pdf.context.delete(n)
}

/** Adds `ref` to the AcroForm /DR fonts under `wanted` (or `wanted_2`, ... when that name holds another font). */
function addToDR(pdf: PDFDocument, wanted: string, ref: PDFRef): string {
  const acro = pdf.getForm().acroForm.dict
  let dr = acro.lookupMaybe(N('DR'), PDFDict)
  if (!dr) {
    dr = pdf.context.obj({})
    acro.set(N('DR'), dr)
  }
  let fonts = dr.lookupMaybe(N('Font'), PDFDict)
  if (!fonts) {
    fonts = pdf.context.obj({})
    dr.set(N('Font'), fonts)
  }
  let name = wanted
  for (let i = 2; ; i++) {
    const cur = fonts.get(N(name))
    if (cur === undefined || cur === ref) break
    name = `${wanted}_${i}`
  }
  fonts.set(N(name), ref)
  return name
}

/** The engine font that draws most glyphs of these layouts. */
function primaryFont(pdf: PDFDocument, xos: TextXObject[]): PDFRef | undefined {
  const count = new Map<TextFont, number>()
  let best: { font: TextFont; n: number } | undefined
  for (const xo of xos)
    for (const line of xo.layout.lines)
      for (const run of line.runs) {
        const n = (count.get(run.font) ?? 0) + run.glyphs.length
        count.set(run.font, n)
        if (!best || n > best.n) best = { font: run.font, n }
      }
  if (!best) return undefined
  return embeddedFontsFor(pdf).fontFor(best.font).ref
}

/**
 * Writes engine appearances for every widget of a text field, combo box, list box or push button, updates /DA and
 * /DR, and marks the field clean (so pdf-lib's own Helvetica regeneration at save time leaves it alone).
 * Throws `UnsupportedCharactersError` (before changing anything) if no bundled font has some character.
 */
export async function writeEngineAppearances(pdf: PDFDocument, field: PDFField): Promise<void> {
  ensureTextEngine()
  const stack = fieldStack(pdf, field)
  for (const t of displayedTexts(field)) await assertDrawable(t, stack.fontStack)
  const form = pdf.getForm()
  const widgets = field.acroField.getWidgets()
  widgets.forEach((widget) => deleteOwnAppearance(pdf, widget))
  const all: TextXObject[] = []
  const daUpdates: { widget: PDFWidgetAnnotation; onWidget: boolean; da: ParsedDA }[] = []
  for (const widget of widgets) {
    const { da: daText, onWidget } = effectiveDA(pdf, field, widget)
    const da = parseDA(daText)
    const st: StyleIn = { fontStack: stack.fontStack, weight: stack.weight, color: da.color }
    const r = widget.getRectangle()
    const mk = widget.dict.lookupMaybe(N('MK'), PDFDict)
    const rotRaw = mk?.lookupMaybe(N('R'), PDFNumber)?.asNumber() ?? 0
    const rot = (((Math.round(rotRaw / 90) * 90) % 360) + 360) % 360
    const rw = Math.abs(r.width)
    const rh = Math.abs(r.height)
    const [W, H] = rot === 90 || rot === 270 ? [rh, rw] : [rw, rh]
    const bs = widget.dict.lookupMaybe(N('BS'), PDFDict)
    const bw = bs?.lookupMaybe(N('W'), PDFNumber)?.asNumber() ?? 0
    const bg = components(mk, 'BG')
    const bc = components(mk, 'BC')
    const isComb = field instanceof PDFTextField && field.isCombed()
    const pad = isComb ? 0 : 1
    // 2 pt between the text and the sides (what Acrobat leaves), 1 pt above and below (what pdf-lib leaves).
    const padX = isComb ? 0 : 2
    const box: Box = { x: bw + padX, y: bw + pad, w: Math.max(0, W - 2 * (bw + padX)), h: Math.max(0, H - 2 * (bw + pad)) }
    const align = alignOfQ(quadding(field, widget))

    let result: { placed: Placed[]; size: number; highlights?: { y: number; h: number }[] }
    if (field instanceof PDFTextField) {
      let text = field.getText() ?? ''
      if (field.isPassword()) text = '*'.repeat(graphemes(text).length)
      if (field.isMultiline()) result = await multiLine(pdf, text.replace(/\r\n?/g, '\n'), box, da.size, st, align)
      else if (isComb) result = await combed(pdf, text, box, da.size, field.getMaxLength() ?? 0, st)
      else result = await singleLine(pdf, text.replace(/[\r\n]+/g, ' '), box, da.size, st, align)
    } else if (field instanceof PDFDropdown) {
      result = await singleLine(pdf, (field.getSelected()[0] ?? '').replace(/[\r\n]+/g, ' '), box, da.size, st, align)
    } else if (field instanceof PDFOptionList) {
      const opts = field.getOptions()
      if (field.isSorted()) opts.sort()
      result = await listLines(pdf, opts, new Set(field.getSelected()), box, da.size, st)
    } else if (field instanceof PDFButton) {
      const caption = widget.getAppearanceCharacteristics()?.getCaptions()?.normal ?? ''
      result = await singleLine(pdf, caption, { x: bw, y: bw, w: Math.max(0, W - 2 * bw), h: Math.max(0, H - 2 * bw) }, da.size, st, 'center')
    } else return

    // The widget's own look (as pdf-lib draws it for Latin text), then the text inside a clip.
    const ops: string[] = ['q']
    if (rot === 90) ops.push(`0 1 -1 0 ${num(rw)} 0 cm`)
    else if (rot === 180) ops.push(`-1 0 0 -1 ${num(rw)} ${num(rh)} cm`)
    else if (rot === 270) ops.push(`0 -1 1 0 0 ${num(rh)} cm`)
    if (bg) ops.push(`${colorOps(bg, false)} ${num(bw / 2)} ${num(bw / 2)} ${num(W - bw)} ${num(H - bw)} re f`)
    if (bc && bw > 0) ops.push(`${colorOps(bc, true)} ${num(bw)} w ${num(bw / 2)} ${num(bw / 2)} ${num(W - bw)} ${num(H - bw)} re S`)
    for (const hl of result.highlights ?? []) ops.push(`0.6 0.757 0.855 rg ${num(bw / 2)} ${num(hl.y)} ${num(W - bw)} ${num(hl.h)} re f`)
    ops.push(`${num(bw + pad)} ${num(bw + pad)} ${num(Math.max(0, W - 2 * (bw + pad)))} ${num(Math.max(0, H - 2 * (bw + pad)))} re W n`)
    ops.push('/Tx BMC', 'q')
    const xobjects: Record<string, PDFRef> = {}
    const names = new Map<TextXObject, string>()
    for (const p of result.placed) {
      let name = names.get(p.xo)
      if (!name) {
        name = `EpdfTx${names.size}`
        names.set(p.xo, name)
        xobjects[name] = p.xo.ref
        all.push(p.xo)
      }
      ops.push(`q 1 0 0 1 ${num(p.x)} ${num(p.y)} cm /${name} Do Q`)
    }
    ops.push('Q', 'EMC', 'Q')
    const stream = pdf.context.flateStream(ops.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, rw, rh],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { XObject: xobjects },
      [OWN_KEY]: true
    })
    const ref = pdf.context.register(stream)
    widget.setNormalAppearance(ref)
    widget.removeRolloverAppearance()
    widget.removeDownAppearance()
    daUpdates.push({ widget, onWidget, da })
  }

  // /DA names the engine font drawing most of the text; the font is in the AcroForm /DR under that name.
  const fontRef = primaryFont(pdf, all)
  if (fontRef) {
    const name = addToDR(pdf, drName(stack), fontRef)
    let fieldDone = false
    for (const u of daUpdates) {
      const da = `/${name} ${num(u.da.size)} Tf ${u.da.colorOp}`
      if (u.onWidget) u.widget.dict.set(N('DA'), PDFString.of(da))
      else if (!fieldDone) {
        field.acroField.dict.set(N('DA'), PDFString.of(da))
        fieldDone = true
      }
    }
  }
  form.markFieldAsClean(field.ref)
}
