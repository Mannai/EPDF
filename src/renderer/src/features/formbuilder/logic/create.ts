import { PDFHexString, PDFRadioGroup, type PDFDocument, type PDFField, type PDFPage } from 'pdf-lib'
import { isWinAnsiText } from '@shared/text'
import { applyWidgetLook, ensureAcroFormDefaults, readWidgetLook, setWidgetRotation } from './appearance'
import { BuilderError, applyPatch, assertNewName, buildBoxAppearance, refreshAppearance, removeField, toWidgetRect } from './edit'
import { normRotation } from './frame'
import { DEFAULT_STYLE, OVERLAY_STYLE, normRect, type FieldPatch, type FieldSpec, type FieldStyle, type RadioButtonSpec, type URect } from './spec'

/**
 * Creates real AcroForm fields with pdf-lib: widget annotations with the right /Rect and /P, /MK colours and
 * border, /DA, appearance streams (so the form displays in other readers), /AcroForm with /DR and /DA, radio
 * groups as one field with several kid widgets. Pure pdf-lib; runs inside `editPdf`.
 */

/** Widget options with an exact rectangle (pdf-lib grows the rect by the border width; we set it ourselves). */
const boxOptions = (rect: URect): { x: number; y: number; width: number; height: number; borderWidth: 0; backgroundColor: undefined; borderColor: undefined; textColor: undefined } => ({
  ...toWidgetRect(rect),
  borderWidth: 0,
  backgroundColor: undefined,
  borderColor: undefined,
  textColor: undefined
})

function styleFor(spec: FieldSpec): FieldStyle {
  return { ...DEFAULT_STYLE, ...(spec.style ?? {}) }
}

function finishWidgets(field: PDFField, page: PDFPage, style: FieldStyle): void {
  const rot = normRotation(page.getRotation().angle)
  for (const w of field.acroField.getWidgets()) {
    setWidgetRotation(w, rot)
    applyWidgetLook(w, style)
  }
}

/**
 * Adds one field to the document and returns its final name. Throws `BuilderError` (nothing added) when the
 * name is invalid or taken, the page does not exist, or the options make no sense.
 */
export async function createField(pdf: PDFDocument, spec: FieldSpec): Promise<string> {
  if (spec.pageIndex < 0 || spec.pageIndex >= pdf.getPageCount()) throw new BuilderError('That page does not exist.')
  assertNewName(pdf, spec.name)
  const form = pdf.getForm()
  const page = pdf.getPage(spec.pageIndex)
  const style = styleFor(spec)
  await ensureAcroFormDefaults(pdf, [style.fontName])
  const rect = normRect(spec.rect)
  if (spec.kind !== 'radio' && (rect.x2 - rect.x1 < 2 || rect.y2 - rect.y1 < 2)) throw new BuilderError('The field is too small.')

  let field: PDFField
  const patch: FieldPatch = {}
  switch (spec.kind) {
    case 'text': {
      const f = form.createTextField(spec.name)
      f.addToPage(page, boxOptions(rect))
      field = f
      if (spec.maxLength) patch.maxLength = spec.maxLength
      if (spec.multiline) patch.multiline = true
      if (spec.password) patch.password = true
      if (spec.comb) {
        if (!spec.maxLength) throw remove(pdf, f, 'A comb field needs a maximum length (the number of cells).')
        patch.comb = true
      }
      if (spec.value) patch.value = spec.value
      break
    }
    case 'checkbox': {
      const f = form.createCheckBox(spec.name)
      f.addToPage(page, boxOptions(rect))
      field = f
      if (spec.onValue && spec.onValue !== 'Yes') patch.onValue = spec.onValue
      if (spec.value === 'true') patch.value = 'true'
      break
    }
    case 'radio': {
      const buttons: RadioButtonSpec[] = spec.buttons && spec.buttons.length ? spec.buttons : [{ rect, value: spec.options?.[0] ?? 'Choice1' }]
      const values = buttons.map((b) => b.value.trim())
      if (values.some((v) => v === '')) throw new BuilderError('Every radio button needs an export value.')
      if (new Set(values).size !== values.length) throw new BuilderError('Export values of a radio group must be different.')
      const g = form.createRadioGroup(spec.name)
      buttons.forEach((b, i) => g.addOptionToPage(values[i], page, boxOptions(b.rect)))
      g.disableOffToggling()
      field = g
      if (spec.value) patch.value = spec.value
      break
    }
    case 'dropdown': {
      // Options are set after addToPage: pdf-lib draws a first appearance there with Helvetica, which cannot encode
      // Arabic/Hebrew/... options; the real appearance is drawn below (applyPatch), by the text engine when needed.
      const f = form.createDropdown(spec.name)
      f.addToPage(page, boxOptions(rect))
      f.setOptions(spec.options ?? [])
      field = f
      if (spec.editable) patch.editable = true
      if (spec.value) patch.value = spec.value
      break
    }
    case 'list': {
      const f = form.createOptionList(spec.name)
      f.addToPage(page, boxOptions(rect))
      f.setOptions(spec.options ?? [])
      field = f
      if (spec.multiSelect) patch.multiSelect = true
      if (spec.value) patch.value = spec.value
      break
    }
    case 'button': {
      const f = form.createButton(spec.name)
      const caption = spec.caption ?? 'Button'
      // A caption Helvetica cannot encode is set by applyPatch below and drawn by the text engine.
      f.addToPage(isWinAnsiText(caption) ? caption : '', page, boxOptions(rect))
      field = f
      break
    }
    case 'signature': {
      const ref = pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Sig',
          T: PDFHexString.fromText(spec.name),
          Rect: [rect.x1, rect.y1, rect.x2, rect.y2],
          F: 4,
          P: page.ref
        })
      )
      page.node.addAnnot(ref)
      form.acroForm.addField(ref)
      field = form.getSignature(spec.name)
      break
    }
  }

  finishWidgets(field, page, style)
  if (spec.tooltip) patch.tooltip = spec.tooltip
  if (spec.required) patch.required = true
  if (spec.readOnly) patch.readOnly = true
  if (spec.hidden) patch.hidden = true
  if (spec.format && spec.format.type !== 'none') patch.format = spec.format
  patch.style = style
  if (spec.kind === 'button' && spec.caption !== undefined) patch.caption = spec.caption
  try {
    const finalName = await applyPatch(pdf, spec.name, patch)
    if (spec.kind === 'signature') for (const w of field.acroField.getWidgets()) buildBoxAppearance(pdf, w)
    return finalName
  } catch (err) {
    try {
      removeField(pdf, field)
    } catch {
      /* already gone */
    }
    throw err
  }
}

function remove(pdf: PDFDocument, field: PDFField, message: string): BuilderError {
  removeField(pdf, field)
  return new BuilderError(message)
}

/** Adds one more button to an existing radio group (on any page). Returns the new export value. */
export async function addRadioButton(pdf: PDFDocument, groupName: string, pageIndex: number, rect: URect, value: string): Promise<string> {
  const form = pdf.getForm()
  const g = form.getFieldMaybe(groupName)
  if (!(g instanceof PDFRadioGroup)) throw new BuilderError('That is not a radio group.')
  const v = value.trim()
  if (v === '') throw new BuilderError('Every radio button needs an export value.')
  if (g.getOptions().includes(v)) throw new BuilderError(`The group already has a button “${v}”.`)
  const page = pdf.getPage(pageIndex)
  const first = g.acroField.getWidgets()[0]
  const look = first ? readWidgetLook(first) : { ...DEFAULT_STYLE }
  g.addOptionToPage(v, page, boxOptions(rect))
  const w = g.acroField.getWidgets()[g.acroField.getWidgets().length - 1]
  setWidgetRotation(w, normRotation(page.getRotation().angle))
  applyWidgetLook(w, { ...DEFAULT_STYLE, ...look })
  await refreshAppearance(pdf, g)
  return v
}

/** The style a detected field gets: it lies over a printed box or rule, so it draws nothing of its own. */
export const detectedStyle = (): Partial<FieldStyle> => ({ ...OVERLAY_STYLE })
