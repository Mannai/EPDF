import {
  PDFArray,
  PDFDict,
  PDFDropdown,
  PDFField,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRef,
  PDFString,
  PDFTextField,
  PDFButton,
  PDFCheckBox,
  PDFRadioGroup,
  StandardFonts,
  TextAlignment,
  type PDFDocument,
  type PDFFont,
  type PDFWidgetAnnotation
} from 'pdf-lib'
import { DEFAULT_STYLE, type Align, type BorderStyle, type FieldStyle, type FontName } from './spec'

/**
 * Field appearance: fonts (standard fonts registered in the form's /DR), the default appearance string
 * (/DA), widget colours and borders (/MK, /BS), and appearance-stream regeneration (so the form displays in
 * other readers). Pure pdf-lib.
 */

const N = PDFName.of

const STANDARD: Record<FontName, StandardFonts> = {
  Helv: StandardFonts.Helvetica,
  HeBo: StandardFonts.HelveticaBold,
  TiRo: StandardFonts.TimesRoman,
  TiBo: StandardFonts.TimesRomanBold,
  Cour: StandardFonts.Courier,
  CoBo: StandardFonts.CourierBold
}

const ALIASES: Record<string, FontName> = {
  helvetica: 'Helv',
  'helvetica-bold': 'HeBo',
  helveticabold: 'HeBo',
  'times-roman': 'TiRo',
  timesroman: 'TiRo',
  times: 'TiRo',
  'times-bold': 'TiBo',
  timesbold: 'TiBo',
  courier: 'Cour',
  'courier-bold': 'CoBo',
  courierbold: 'CoBo',
  arial: 'Helv'
}

export const toFontName = (name: string | undefined): FontName => {
  if (!name) return 'Helv'
  if (name in STANDARD) return name as FontName
  return ALIASES[name.toLowerCase()] ?? 'Helv'
}

/** One embedded copy of each standard font per document object (embedding twice would duplicate the font dict). */
const ready = new WeakMap<PDFDocument, Map<FontName, Promise<PDFFont>>>()
export function loadStandardFont(pdf: PDFDocument, name: FontName): Promise<PDFFont> {
  let m = ready.get(pdf)
  if (!m) ready.set(pdf, (m = new Map()))
  let p = m.get(name)
  if (!p) m.set(name, (p = pdf.embedFont(STANDARD[name])))
  return p
}

// ---------------------------------------------------------------------------------------------------------
// colours

export function hexToComponents(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const h2 = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0')

export function componentsToHex(c: readonly number[] | undefined): string | null {
  if (!c || c.length === 0) return null
  if (c.length === 1) return `#${h2(c[0])}${h2(c[0])}${h2(c[0])}`
  if (c.length === 3) return `#${h2(c[0])}${h2(c[1])}${h2(c[2])}`
  if (c.length === 4) {
    const [C, M, Y, K] = c
    return `#${h2((1 - C) * (1 - K))}${h2((1 - M) * (1 - K))}${h2((1 - Y) * (1 - K))}`
  }
  return null
}

const num = (n: number): string => String(Math.round(n * 1000) / 1000)

/** `/Helv 12 Tf 0 0 0 rg` */
export function buildDA(style: Pick<FieldStyle, 'fontName' | 'fontSize' | 'textColor'>): string {
  const [r, g, b] = hexToComponents(style.textColor)
  const color = r === g && g === b ? `${num(r)} g` : `${num(r)} ${num(g)} ${num(b)} rg`
  return `/${style.fontName} ${num(style.fontSize)} Tf ${color}`
}

export function parseDA(da: string | undefined): { fontName: FontName; fontSize: number; textColor: string } {
  const out = { fontName: 'Helv' as FontName, fontSize: 0, textColor: '#000000' }
  if (!da) return out
  const tf = /\/([^\s/]+)\s+(-?\d*\.?\d+)\s+Tf/.exec(da)
  if (tf) {
    out.fontName = toFontName(decodeURIComponent(tf[1].replace(/#([0-9a-fA-F]{2})/g, '%$1')))
    out.fontSize = Math.max(0, Number(tf[2]))
  }
  let color: string | null = null
  for (const m of da.matchAll(/((?:-?\d*\.?\d+)(?:\s+-?\d*\.?\d+){0,3})\s+(g|rg|k)\b/g)) {
    const nums = m[1].split(/\s+/).map(Number)
    if ((m[2] === 'g' && nums.length === 1) || (m[2] === 'rg' && nums.length === 3) || (m[2] === 'k' && nums.length === 4)) color = componentsToHex(nums)
  }
  if (color) out.textColor = color
  return out
}

// ---------------------------------------------------------------------------------------------------------
// AcroForm defaults

/** Makes sure /AcroForm has a /DR with the standard fonts the fields use and a default /DA. */
export async function ensureAcroFormDefaults(pdf: PDFDocument, fonts: FontName[] = ['Helv']): Promise<void> {
  const form = pdf.getForm()
  const acro = form.acroForm.dict
  const ctx = pdf.context
  let dr = acro.lookupMaybe(N('DR'), PDFDict)
  if (!dr) {
    dr = ctx.obj({})
    acro.set(N('DR'), dr)
  }
  let fontDict = dr.lookupMaybe(N('Font'), PDFDict)
  if (!fontDict) {
    fontDict = ctx.obj({})
    dr.set(N('Font'), fontDict)
  }
  for (const name of new Set<FontName>(['Helv', ...fonts])) {
    if (fontDict.has(N(name))) continue
    const f = await loadStandardFont(pdf, name)
    fontDict.set(N(name), f.ref)
  }
  if (!acro.has(N('DA'))) acro.set(N('DA'), PDFString.of('/Helv 0 Tf 0 g'))
}

// ---------------------------------------------------------------------------------------------------------
// widget look

const BS_CODE: Record<BorderStyle, string> = { solid: 'S', dashed: 'D', beveled: 'B', inset: 'I', underline: 'U' }
const BS_FROM: Record<string, BorderStyle> = { S: 'solid', D: 'dashed', B: 'beveled', I: 'inset', U: 'underline' }

/** Writes the widget's colours and border (/MK /BC /BG, /BS) - null means "none". */
export function applyWidgetLook(widget: PDFWidgetAnnotation, look: Pick<FieldStyle, 'borderColor' | 'backgroundColor' | 'borderWidth' | 'borderStyle'>): void {
  const mk = widget.getOrCreateAppearanceCharacteristics().dict
  const put = (key: string, hex: string | null): void => {
    if (hex === null) mk.delete(N(key))
    else mk.set(N(key), widget.dict.context.obj(hexToComponents(hex)))
  }
  put('BC', look.borderColor)
  put('BG', look.backgroundColor)
  const bs = widget.getOrCreateBorderStyle().dict
  bs.set(N('W'), PDFNumber.of(look.borderColor === null ? 0 : look.borderWidth))
  bs.set(N('S'), N(BS_CODE[look.borderStyle]))
}

export function readWidgetLook(widget: PDFWidgetAnnotation): Pick<FieldStyle, 'borderColor' | 'backgroundColor' | 'borderWidth' | 'borderStyle'> {
  const mk = widget.dict.lookupMaybe(N('MK'), PDFDict)
  const comps = (key: string): number[] | undefined => {
    const a = mk?.lookupMaybe(N(key), PDFArray)
    if (!a) return undefined
    const out: number[] = []
    for (let i = 0; i < a.size(); i++) {
      const v = a.lookup(i)
      if (v instanceof PDFNumber) out.push(v.asNumber())
    }
    return out
  }
  const bs = widget.dict.lookupMaybe(N('BS'), PDFDict)
  const w = bs?.lookupMaybe(N('W'), PDFNumber)?.asNumber()
  const s = bs?.lookupMaybe(N('S'), PDFName)?.decodeText()
  const borderColor = componentsToHex(comps('BC'))
  return {
    borderColor,
    backgroundColor: componentsToHex(comps('BG')),
    borderWidth: w ?? (borderColor ? 1 : 0),
    borderStyle: (s && BS_FROM[s]) || 'solid'
  }
}

export function setWidgetRotation(widget: PDFWidgetAnnotation, degrees: number): void {
  widget.getOrCreateAppearanceCharacteristics().dict.set(N('R'), PDFNumber.of(degrees))
}

const ALIGN_TO: Record<Align, TextAlignment> = { left: TextAlignment.Left, center: TextAlignment.Center, right: TextAlignment.Right }

export const alignmentOf = (field: PDFTextField): Align => {
  try {
    const a = field.getAlignment()
    return a === TextAlignment.Center ? 'center' : a === TextAlignment.Right ? 'right' : 'left'
  } catch {
    return 'left'
  }
}

/** Sets the default appearance (font, size, colour) on the field and drops per-widget overrides. */
export function applyTextStyle(field: PDFField, style: Pick<FieldStyle, 'fontName' | 'fontSize' | 'textColor' | 'align'>): void {
  field.acroField.setDefaultAppearance(buildDA(style))
  for (const w of field.acroField.getWidgets()) w.dict.delete(N('DA'))
  if (field instanceof PDFTextField) field.setAlignment(ALIGN_TO[style.align])
}

/** Regenerates the appearance streams of a field with the standard font its /DA names. */
export async function refreshField(pdf: PDFDocument, field: PDFField): Promise<void> {
  const daText = readDA(field)
  const da = parseDA(daText)
  const font = await loadStandardFont(pdf, da.fontName)
  if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFButton) {
    const fieldDA = field.acroField.dict.get(N('DA'))
    const widgets = field.acroField.getWidgets()
    const widgetDAs = widgets.map((w) => w.dict.get(N('DA')))
    field.defaultUpdateAppearances(font)
    // pdf-lib rewrites /DA with the size it computed and its own font name; put back what was there
    // (size 0 = automatic, font names the form's /DR knows).
    if (fieldDA) field.acroField.dict.set(N('DA'), fieldDA)
    else field.acroField.dict.delete(N('DA'))
    widgets.forEach((w, i) => {
      const d = widgetDAs[i]
      if (d) w.dict.set(N('DA'), d)
      else w.dict.delete(N('DA'))
    })
  } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    field.defaultUpdateAppearances()
  }
}

export function readDA(field: PDFField): string | undefined {
  const raw = field.acroField.getInheritableAttribute(N('DA'))
  if (raw instanceof PDFString) return raw.decodeText()
  const w = field.acroField.getWidgets()[0]
  return w?.getDefaultAppearance()
}

export { DEFAULT_STYLE }
export type { PDFRef }
