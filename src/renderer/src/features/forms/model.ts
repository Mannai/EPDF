import {
  PDFCheckBox,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFButton,
  PDFTextField,
  TextAlignment,
  type PDFDocument,
  type PDFField
} from 'pdf-lib'
import type { Rect } from './geometry'

/**
 * A plain-data description of the AcroForm fields of a PDF, extracted with pdf-lib. This is what the
 * overlay renders and what validation runs against. Pure logic: no DOM, no PDF.js, so it runs in Node.
 */

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'signature'

/** Kinds the user can fill in. Buttons and signature fields are shown but not editable. */
export const FILLABLE_KINDS: readonly FieldKind[] = ['text', 'checkbox', 'radio', 'dropdown', 'list']

export type FieldValue = string | boolean | string[]

export interface WidgetModel {
  /** Unique across the document: `<field name>#<widget index>`. */
  key: string
  /** 0-based page index. */
  pageIndex: number
  /** The page's /Rotate (0, 90, 180, 270). */
  pageRotation: number
  /** In PDF user space (normalized: x1<x2, y1<y2). */
  rect: Rect
  /** Checkbox/radio: the export value this widget represents. */
  onValue?: string
  /** Points; 0/undefined = auto size. */
  fontSize?: number
  /** CSS color from the default appearance, if any. */
  color?: string
  align: 'left' | 'center' | 'right'
  /** CSS colors from the widget's /MK entry. */
  background?: string
  borderColor?: string
  borderWidth: number
  /** Push-button caption. */
  caption?: string
}

export interface FieldModel {
  /** Fully qualified name. */
  name: string
  kind: FieldKind
  /** Accessible name: the field's tooltip (/TU) or its name. */
  label: string
  tooltip?: string
  readOnly: boolean
  required: boolean
  value: FieldValue
  multiline: boolean
  password: boolean
  comb: boolean
  maxLength?: number
  options: string[]
  multiSelect: boolean
  /** Editable combo box: the user may type a value that is not in the list. */
  editable: boolean
  /** Radio buttons that can't be switched off once on (the default for radio groups). */
  widgets: WidgetModel[]
}

export interface FormModel {
  fields: FieldModel[]
  /** Set when pdf-lib could not read the form at all. */
  error?: string
}

const F_HIDDEN = 1 << 1
const F_NOVIEW = 1 << 5

const text = (o: PDFString | PDFHexString | PDFName | undefined | unknown): string | undefined => {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText()
  if (o instanceof PDFName) return o.decodeText()
  return undefined
}

const cssColor = (c: number[] | undefined): string | undefined => {
  if (!c || c.length === 0) return undefined
  const to = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
  if (c.length === 1) return `rgb(${to(c[0])} ${to(c[0])} ${to(c[0])})`
  if (c.length === 3) return `rgb(${to(c[0])} ${to(c[1])} ${to(c[2])})`
  if (c.length === 4) {
    const [C, M, Y, K] = c
    return `rgb(${to((1 - C) * (1 - K))} ${to((1 - M) * (1 - K))} ${to((1 - Y) * (1 - K))})`
  }
  return undefined
}

const TF_RE = /\/[^\s/]+\s+(\d*\.\d+|\d+)\s+Tf/g
const COLOR_RE = /((?:\d*\.\d+|\d+)(?:\s+(?:\d*\.\d+|\d+)){0,3})\s+(g|rg|k)\b/g

/** Parses a default-appearance string (`/Helv 12 Tf 0 0 1 rg`) into font size and CSS color. */
export function parseDefaultAppearance(da: string | undefined): { fontSize?: number; color?: string } {
  if (!da) return {}
  let fontSize: number | undefined
  for (const m of da.matchAll(TF_RE)) fontSize = Number(m[1])
  let color: string | undefined
  for (const m of da.matchAll(COLOR_RE)) {
    const nums = m[1].split(/\s+/).map(Number)
    if ((m[2] === 'g' && nums.length === 1) || (m[2] === 'rg' && nums.length === 3) || (m[2] === 'k' && nums.length === 4)) {
      color = cssColor(nums)
    }
  }
  return { fontSize, color }
}

function inheritedDA(field: PDFField, acroFormDA: string | undefined): string | undefined {
  const raw = field.acroField.getInheritableAttribute(PDFName.of('DA'))
  return text(raw) ?? acroFormDA
}

function widgetDA(widget: { getDefaultAppearance(): string | undefined }): string | undefined {
  return widget.getDefaultAppearance()
}

/** Maps each annotation ref to the 0-based page it sits on (a widget's own /P entry is not trusted). */
export function annotationPages(pdf: PDFDocument): Map<string, number> {
  const map = new Map<string, number>()
  pdf.getPages().forEach((page, i) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k)
      if (ref instanceof PDFRef) map.set(ref.toString(), i)
    }
  })
  return map
}

function kindOf(field: PDFField): FieldKind | null {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'checkbox'
  if (field instanceof PDFRadioGroup) return 'radio'
  if (field instanceof PDFDropdown) return 'dropdown'
  if (field instanceof PDFOptionList) return 'list'
  if (field instanceof PDFButton) return 'button'
  if (field instanceof PDFSignature) return 'signature'
  return null
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Describes one pdf-lib field. `pages` is optional: without it widgets get page index -1 (validation only). */
export function describeField(
  pdf: PDFDocument,
  field: PDFField,
  pages?: Map<string, number>,
  acroFormDA?: string,
  rotations?: number[]
): FieldModel | null {
  const kind = kindOf(field)
  if (!kind) return null
  const name = field.getName()
  const tooltip = text(field.acroField.getInheritableAttribute(PDFName.of('TU')))?.trim() || undefined

  const m: FieldModel = {
    name,
    kind,
    label: tooltip ?? name,
    tooltip,
    readOnly: safe(() => field.isReadOnly(), false),
    required: safe(() => field.isRequired(), false),
    value: kind === 'checkbox' ? false : kind === 'list' ? [] : '',
    multiline: false,
    password: false,
    comb: false,
    options: [],
    multiSelect: false,
    editable: false,
    widgets: []
  }

  if (field instanceof PDFTextField) {
    m.value = safe(() => field.getText() ?? '', '')
    m.multiline = safe(() => field.isMultiline(), false)
    m.password = safe(() => field.isPassword(), false)
    m.comb = safe(() => field.isCombed(), false)
    m.maxLength = safe(() => field.getMaxLength(), undefined)
  } else if (field instanceof PDFCheckBox) {
    m.value = safe(() => field.isChecked(), false)
  } else if (field instanceof PDFRadioGroup) {
    m.value = safe(() => field.getSelected() ?? '', '')
    m.options = safe(() => field.getOptions(), [])
  } else if (field instanceof PDFDropdown) {
    m.options = safe(() => field.getOptions(), [])
    m.value = safe(() => field.getSelected()[0] ?? '', '')
    m.editable = safe(() => field.isEditable(), false)
    m.multiSelect = safe(() => field.isMultiselect(), false)
  } else if (field instanceof PDFOptionList) {
    m.options = safe(() => field.getOptions(), [])
    m.value = safe(() => field.getSelected(), [])
    m.multiSelect = safe(() => field.isMultiselect(), false)
  }

  const fieldDA = inheritedDA(field, acroFormDA)
  const widgets = field.acroField.getWidgets()
  // A radio button's appearance state is an index or an internal name; the value the user sees (and
  // pdf-lib's `select`) is the matching entry of the group's option list, in widget order.
  let radioIndex = 0
  widgets.forEach((w, i) => {
    let onValue = m.kind === 'checkbox' || m.kind === 'radio' ? text(safe(() => w.getOnValue(), undefined)) : undefined
    if (m.kind === 'radio' && onValue !== undefined) onValue = m.options[radioIndex++] ?? onValue
    const flags = safe(() => w.getFlags(), 0)
    if (flags & (F_HIDDEN | F_NOVIEW)) return
    const ref = pdf.context.getObjectRef(w.dict)
    const pageIndex = ref ? (pages?.get(ref.toString()) ?? -1) : -1
    if (pages && pageIndex < 0) return // not on any page: nothing to show
    const r = safe(() => w.getRectangle(), { x: 0, y: 0, width: 0, height: 0 })
    const x1 = Math.min(r.x, r.x + r.width)
    const x2 = Math.max(r.x, r.x + r.width)
    const y1 = Math.min(r.y, r.y + r.height)
    const y2 = Math.max(r.y, r.y + r.height)
    const ap = safe(() => w.getAppearanceCharacteristics(), undefined)
    const bs = safe(() => w.getBorderStyle(), undefined)
    const da = parseDefaultAppearance(widgetDA(w) ?? fieldDA)
    const alignment = m.kind === 'text' ? safe(() => (field as PDFTextField).getAlignment(), TextAlignment.Left) : TextAlignment.Left
    m.widgets.push({
      key: `${name}#${i}`,
      pageIndex,
      pageRotation: rotations?.[pageIndex] ?? 0,
      rect: { x1, y1, x2, y2 },
      onValue,
      fontSize: da.fontSize,
      color: da.color,
      align: alignment === TextAlignment.Center ? 'center' : alignment === TextAlignment.Right ? 'right' : 'left',
      background: cssColor(safe(() => ap?.getBackgroundColor(), undefined)),
      borderColor: cssColor(safe(() => ap?.getBorderColor(), undefined)),
      borderWidth: safe(() => bs?.getWidth() ?? (ap?.getBorderColor() ? 1 : 0), 0),
      caption: kind === 'button' ? safe(() => ap?.getCaptions().normal, undefined) : undefined
    })
  })
  return m
}

/** Extracts every field that has at least one visible widget on a page. Never throws. */
export function extractFormModel(pdf: PDFDocument): FormModel {
  try {
    const form = pdf.getForm()
    const acroFormDA = text(form.acroForm.dict.get(PDFName.of('DA')))
    const pages = annotationPages(pdf)
    const rotations = pdf.getPages().map((p) => safe(() => (((p.getRotation().angle % 360) + 360) % 360), 0))
    const fields: FieldModel[] = []
    for (const f of form.getFields()) {
      const d = safe(() => describeField(pdf, f, pages, acroFormDA, rotations), null)
      if (d && d.widgets.length > 0) fields.push(d)
    }
    return { fields }
  } catch (err) {
    return { fields: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export const isFillable = (f: FieldModel): boolean => FILLABLE_KINDS.includes(f.kind) && !f.readOnly

export const fieldPages = (m: FormModel): number[] => [...new Set(m.fields.flatMap((f) => f.widgets.map((w) => w.pageIndex)))].sort((a, b) => a - b)
