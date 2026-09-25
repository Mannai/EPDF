import {
  AnnotationFlags,
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  decodePDFRawStream,
  type PDFDocument,
  type PDFField
} from 'pdf-lib'
import { annotationPages } from '../../forms/model'
import { parseScripts, type ActionScripts } from './actions'
import { alignmentOf, parseDA, readDA, readWidgetLook } from './appearance'
import { DEFAULT_STYLE, type BuilderKind, type FieldInfo, type FieldStyle, type WidgetInfo } from './spec'

/**
 * Reads the AcroForm fields of a document into plain `FieldInfo` records (everything the properties panel,
 * the CSV export and the duplicate/paste actions need). Never throws for one odd field: it is skipped.
 */

const N = PDFName.of

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export function kindOfField(field: PDFField): BuilderKind | null {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'checkbox'
  if (field instanceof PDFRadioGroup) return 'radio'
  if (field instanceof PDFDropdown) return 'dropdown'
  if (field instanceof PDFOptionList) return 'list'
  if (field instanceof PDFSignature) return 'signature'
  if (field instanceof PDFButton) return 'button'
  return null
}

function textOf(o: unknown): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText()
  if (o instanceof PDFName) return o.decodeText()
  if (o instanceof PDFStream) {
    try {
      const bytes = o instanceof PDFRawStream ? decodePDFRawStream(o).decode() : (o as unknown as { getContents(): Uint8Array }).getContents()
      return new TextDecoder().decode(bytes)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The JavaScript source of a field's /AA entries (looked at on the field and its widgets). Never executed. */
export function readScripts(field: PDFField): ActionScripts {
  const out: ActionScripts = {}
  const dicts = [field.acroField.dict, ...field.acroField.getWidgets().map((w) => w.dict)]
  for (const d of dicts) {
    const aa = d.lookupMaybe(N('AA'), PDFDict)
    if (!aa) continue
    const js = (key: string): string | undefined => {
      const act = aa.lookupMaybe(N(key), PDFDict)
      return act ? textOf(act.lookup(N('JS'))) : undefined
    }
    out.format ??= js('F')
    out.keystroke ??= js('K')
    out.validate ??= js('V')
  }
  return out
}

export function describeBuilderField(pdf: PDFDocument, field: PDFField, pages: Map<string, number>, rotations: number[]): FieldInfo | null {
  const kind = kindOfField(field)
  if (!kind) return null
  const name = field.getName()
  const dot = name.lastIndexOf('.')
  const tooltip = textOf(field.acroField.getInheritableAttribute(N('TU'))) ?? ''
  const da = parseDA(readDA(field))
  const widgetsRaw = field.acroField.getWidgets()
  const firstWidget = widgetsRaw[0]
  const look = firstWidget ? readWidgetLook(firstWidget) : { borderColor: null, backgroundColor: null, borderWidth: 0, borderStyle: 'solid' as const }

  const info: FieldInfo = {
    name,
    namePrefix: dot >= 0 ? name.slice(0, dot + 1) : '',
    kind,
    tooltip,
    required: safe(() => field.isRequired(), false),
    readOnly: safe(() => field.isReadOnly(), false),
    hidden: false,
    value: '',
    defaultValue: textOf(field.acroField.getInheritableAttribute(N('DV'))) ?? '',
    multiline: false,
    password: false,
    comb: false,
    options: [],
    editable: false,
    multiSelect: false,
    onValue: 'Yes',
    caption: '',
    style: { ...DEFAULT_STYLE, ...da, ...look, align: 'left' },
    format: parseScripts(readScripts(field)),
    widgets: []
  }

  if (field instanceof PDFTextField) {
    info.value = safe(() => field.getText() ?? '', '')
    info.multiline = safe(() => field.isMultiline(), false)
    info.password = safe(() => field.isPassword(), false)
    info.comb = safe(() => field.isCombed(), false)
    info.maxLength = safe(() => field.getMaxLength(), undefined)
    info.style.align = alignmentOf(field)
  } else if (field instanceof PDFCheckBox) {
    info.value = safe(() => field.isChecked(), false) ? 'true' : ''
    info.onValue = safe(() => firstWidget?.getOnValue()?.decodeText(), undefined) ?? 'Yes'
  } else if (field instanceof PDFRadioGroup) {
    info.value = safe(() => field.getSelected() ?? '', '')
    info.options = safe(() => field.getOptions(), [])
  } else if (field instanceof PDFDropdown) {
    info.options = safe(() => field.getOptions(), [])
    info.value = safe(() => field.getSelected()[0] ?? '', '')
    info.editable = safe(() => field.isEditable(), false)
    info.multiSelect = false
  } else if (field instanceof PDFOptionList) {
    info.options = safe(() => field.getOptions(), [])
    info.value = safe(() => field.getSelected().join('\n'), '')
    info.multiSelect = safe(() => field.isMultiselect(), false)
  } else if (field instanceof PDFButton) {
    info.caption = safe(() => firstWidget?.getAppearanceCharacteristics()?.getCaptions().normal ?? '', '')
  }

  let radioIndex = 0
  widgetsRaw.forEach((w, i) => {
    const ref = pdf.context.getObjectRef(w.dict)
    const pageIndex = ref ? (pages.get(ref.toString()) ?? -1) : -1
    const r = safe(() => w.getRectangle(), { x: 0, y: 0, width: 0, height: 0 })
    const flags = safe(() => w.getFlags(), 0)
    const hidden = (flags & (AnnotationFlags.Hidden | AnnotationFlags.NoView)) !== 0
    let value: string | undefined
    if (kind === 'radio') {
      const on = safe(() => w.getOnValue()?.decodeText(), undefined)
      value = on === undefined ? undefined : (info.options[radioIndex++] ?? on)
    } else if (kind === 'checkbox') value = info.onValue
    const widget: WidgetInfo = {
      index: i,
      pageIndex,
      pageRotation: rotations[pageIndex] ?? 0,
      value,
      hidden,
      rect: { x1: Math.min(r.x, r.x + r.width), y1: Math.min(r.y, r.y + r.height), x2: Math.max(r.x, r.x + r.width), y2: Math.max(r.y, r.y + r.height) }
    }
    info.widgets.push(widget)
  })
  info.hidden = info.widgets.length > 0 && info.widgets.every((w) => w.hidden)
  return info
}

export interface BuilderModel {
  fields: FieldInfo[]
  error?: string
}

/** Every field of the document that sits on a page (fields nowhere on a page cannot be edited visually). */
export function readBuilderModel(pdf: PDFDocument): BuilderModel {
  try {
    const form = pdf.getForm()
    const pages = annotationPages(pdf)
    const rotations = pdf.getPages().map((p) => safe(() => ((p.getRotation().angle % 360) + 360) % 360, 0))
    const fields: FieldInfo[] = []
    for (const f of form.getFields()) {
      const d = safe(() => describeBuilderField(pdf, f, pages, rotations), null)
      if (d && d.widgets.some((w) => w.pageIndex >= 0)) fields.push({ ...d, widgets: d.widgets.filter((w) => w.pageIndex >= 0) })
    }
    return { fields }
  } catch (err) {
    return { fields: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export type { FieldStyle, PDFArray }
