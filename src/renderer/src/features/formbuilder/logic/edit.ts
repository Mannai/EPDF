import {
  AnnotationFlags,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
  type PDFDocument,
  type PDFField,
  type PDFPage,
  type PDFWidgetAnnotation
} from 'pdf-lib'
import { scriptsFor } from './actions'
import { applyTextStyle, applyWidgetLook, ensureAcroFormDefaults, hexToComponents, loadStandardFont, parseDA, readDA, readWidgetLook, refreshField } from './appearance'
import { normRotation } from './frame'
import { nameProblem } from './names'
import { kindOfField } from './read'
import { type FieldPatch, type FieldStyle, type FontName, type URect, DEFAULT_STYLE, normRect } from './spec'

const N = PDFName.of

/** A problem with what the user asked for, phrased for the user. Nothing is changed when this is thrown. */
export class BuilderError extends Error {}

export function requireField(pdf: PDFDocument, name: string): PDFField {
  const f = pdf.getForm().getFieldMaybe(name)
  if (!f) throw new BuilderError(`The field “${name}” no longer exists.`)
  return f
}

/** Fully qualified names of all fields (case is significant in PDF, but we compare loosely to avoid look-alikes). */
export function fieldNames(pdf: PDFDocument): string[] {
  return pdf.getForm().getFields().map((f) => f.getName())
}

export function assertNewName(pdf: PDFDocument, name: string, except?: string): void {
  const problem = nameProblem(name)
  if (problem) throw new BuilderError(problem)
  const lower = name.toLowerCase()
  const clash = fieldNames(pdf).some((n) => n !== except && (n.toLowerCase() === lower || n.startsWith(`${name}.`) || name.startsWith(`${n}.`)))
  if (clash) throw new BuilderError(`A field named “${name}” already exists. Field names must be unique.`)
}

export const toWidgetRect = (r: URect): { x: number; y: number; width: number; height: number } => {
  const n = normRect(r)
  return { x: n.x1, y: n.y1, width: Math.max(1, n.x2 - n.x1), height: Math.max(1, n.y2 - n.y1) }
}

/** Sets the /AA format, keystroke and validate scripts of a field from a rule. */
export function setFieldScripts(pdf: PDFDocument, field: PDFField, scripts: ReturnType<typeof scriptsFor>): void {
  const dict = field.acroField.dict
  const entries: [string, string | undefined][] = [
    ['F', scripts.format],
    ['K', scripts.keystroke],
    ['V', scripts.validate]
  ]
  let aa = dict.lookupMaybe(N('AA'), PDFDict)
  if (entries.every(([, v]) => !v)) {
    // Remove only what we manage; keep other actions (calculate, focus, ...).
    if (aa) for (const [k] of entries) aa.delete(N(k))
    if (aa && aa.keys().length === 0) dict.delete(N('AA'))
    return
  }
  if (!aa) {
    aa = pdf.context.obj({})
    dict.set(N('AA'), aa)
  }
  for (const [k, v] of entries) {
    if (v) aa.set(N(k), pdf.context.obj({ S: 'JavaScript', JS: PDFString.of(v) }))
    else aa.delete(N(k))
  }
}

function setTooltip(field: PDFField, text: string): void {
  const dict = field.acroField.dict
  if (text.trim() === '') dict.delete(N('TU'))
  else dict.set(N('TU'), PDFHexString.fromText(text))
}

function setHidden(field: PDFField, hidden: boolean): void {
  for (const w of field.acroField.getWidgets()) {
    w.setFlagTo(AnnotationFlags.Hidden, hidden)
    w.setFlagTo(AnnotationFlags.Print, !hidden)
  }
}

/** Renames the appearance states of a checkbox widget (`/Yes` -> `/Agreed`) and its current state. */
export function renameOnState(widget: PDFWidgetAnnotation, from: string, to: string): void {
  if (from === to) return
  const ap = widget.dict.lookupMaybe(N('AP'), PDFDict)
  if (!ap) return
  for (const key of ['N', 'D']) {
    const d = ap.lookupMaybe(N(key), PDFDict)
    const v = d?.get(N(from))
    if (d && v) {
      d.delete(N(from))
      d.set(N(to), v)
    }
  }
  const as = widget.dict.lookup(N('AS'))
  if (as instanceof PDFName && as.decodeText() === from) widget.dict.set(N('AS'), N(to))
}

/** Applies a set of edits to one field. Returns the field's (possibly new) fully qualified name. */
export async function applyPatch(pdf: PDFDocument, name: string, patch: FieldPatch): Promise<string> {
  let field = requireField(pdf, name)
  const kind = kindOfField(field)
  if (!kind) throw new BuilderError('This kind of field cannot be edited.')

  if (patch.name !== undefined && patch.name !== name) {
    const partial = patch.name
    const prefix = name.includes('.') ? name.slice(0, name.lastIndexOf('.') + 1) : ''
    const full = partial.startsWith(prefix) && prefix ? partial : `${prefix}${partial}`
    assertNewName(pdf, prefix ? full.slice(prefix.length) : full, name)
    if (prefix && full.slice(prefix.length).includes('.')) throw new BuilderError('A field name cannot contain a period.')
  }

  const font: FontName = patch.style?.fontName ?? parseDA(readDA(field)).fontName
  await ensureAcroFormDefaults(pdf, [font])

  if (patch.tooltip !== undefined) setTooltip(field, patch.tooltip)
  if (patch.required !== undefined) patch.required ? field.enableRequired() : field.disableRequired()
  if (patch.readOnly !== undefined) patch.readOnly ? field.enableReadOnly() : field.disableReadOnly()
  if (patch.hidden !== undefined) setHidden(field, patch.hidden)

  if (field instanceof PDFTextField) {
    if (patch.multiline !== undefined) patch.multiline ? field.enableMultiline() : field.disableMultiline()
    if (patch.password !== undefined) patch.password ? field.enablePassword() : field.disablePassword()
    if (patch.maxLength !== undefined || 'maxLength' in patch) {
      const n = patch.maxLength
      if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) {
        if (field.isCombed()) field.disableCombing()
        field.setMaxLength(undefined)
      } else {
        const cur = field.getText() ?? ''
        if (cur.length > n) field.setText(cur.slice(0, n))
        field.setMaxLength(Math.floor(n))
      }
    }
    if (patch.comb !== undefined) {
      if (patch.comb) {
        if (field.getMaxLength() === undefined) throw new BuilderError('A comb field needs a maximum length (the number of cells).')
        if (field.isMultiline() || field.isPassword()) throw new BuilderError('A comb field cannot be multi-line or a password field.')
        field.enableCombing()
      } else field.disableCombing()
    }
    // Comb + multiline/password conflict when turning those on afterwards.
    if (field.isCombed() && (field.isMultiline() || field.isPassword())) throw new BuilderError('A comb field cannot be multi-line or a password field.')
  } else if (field instanceof PDFDropdown) {
    if (patch.options !== undefined) {
      const sel = field.getSelected()
      field.setOptions(patch.options)
      const keep = sel.filter((s) => patch.options!.includes(s))
      if (keep.length === 0) field.clear()
    }
    if (patch.editable !== undefined) patch.editable ? field.enableEditing() : field.disableEditing()
  } else if (field instanceof PDFOptionList) {
    if (patch.options !== undefined) {
      const sel = field.getSelected()
      field.setOptions(patch.options)
      const keep = sel.filter((s) => patch.options!.includes(s))
      if (keep.length === 0) field.clear()
    }
    if (patch.multiSelect !== undefined) patch.multiSelect ? field.enableMultiselect() : field.disableMultiselect()
  } else if (field instanceof PDFCheckBox) {
    if (patch.onValue !== undefined && patch.onValue !== '') {
      const w = field.acroField.getWidgets()[0]
      const cur = w?.getOnValue()?.decodeText() ?? 'Yes'
      for (const wi of field.acroField.getWidgets()) renameOnState(wi, cur, patch.onValue)
    }
  }

  if (patch.radioValues && field instanceof PDFRadioGroup) {
    const widgets = field.acroField.getWidgets()
    if (patch.radioValues.length !== widgets.length) throw new BuilderError('Every radio button needs an export value.')
    const vals = patch.radioValues.map((v) => v.trim())
    if (vals.some((v) => v === '')) throw new BuilderError('Every radio button needs an export value.')
    if (new Set(vals).size !== vals.length) throw new BuilderError('Export values of a radio group must be different.')
    const selectedIdx = field.getOptions().indexOf(field.getSelected() ?? '')
    field.acroField.dict.set(N('Opt'), pdf.context.obj(vals.map((v) => PDFHexString.fromText(v))))
    // Appearance states of radio widgets are indexes; only the /Opt list changed, so states stay valid.
    if (selectedIdx >= 0 && patch.value === undefined) patch.value = vals[selectedIdx]
  }

  if (patch.style) {
    const cur = parseDA(readDA(field))
    const w0 = field.acroField.getWidgets()[0]
    const curLook = w0 ? readWidgetLook(w0) : { borderColor: DEFAULT_STYLE.borderColor, backgroundColor: DEFAULT_STYLE.backgroundColor, borderWidth: 1, borderStyle: DEFAULT_STYLE.borderStyle }
    const merged: FieldStyle = {
      ...DEFAULT_STYLE,
      ...cur,
      ...curLook,
      align: field instanceof PDFTextField ? readAlign(field) : 'left',
      ...patch.style
    }
    if (!(field instanceof PDFCheckBox) && !(field instanceof PDFRadioGroup) && !(field instanceof PDFSignature)) applyTextStyle(field, merged)
    else if (patch.style.textColor !== undefined) {
      // Check marks take their colour from the default appearance.
      const da = field.acroField.getDefaultAppearance() ?? ''
      const [r, g, b] = hexParts(patch.style.textColor)
      const rest = da.replace(/(?:-?\d*\.?\d+\s+){1,3}(?:g|rg|k)\b/g, '').trim()
      field.acroField.setDefaultAppearance(`${r} ${g} ${b} rg\n${rest}`.trim())
    }
    for (const w of field.acroField.getWidgets()) applyWidgetLook(w, merged)
  }

  if (patch.format) {
    setFieldScripts(pdf, field, scriptsFor(patch.format))
  }

  if (patch.caption !== undefined) {
    for (const w of field.acroField.getWidgets()) w.getOrCreateAppearanceCharacteristics().dict.set(N('CA'), PDFHexString.fromText(patch.caption))
  }

  // Values last, so limits set above apply to them.
  if (patch.defaultValue !== undefined && (field instanceof PDFTextField || field instanceof PDFDropdown)) {
    if (patch.defaultValue === '') field.acroField.dict.delete(N('DV'))
    else field.acroField.dict.set(N('DV'), PDFHexString.fromText(patch.defaultValue))
    if (patch.value === undefined && (field instanceof PDFTextField ? (field.getText() ?? '') === '' : field.getSelected().length === 0)) patch.value = patch.defaultValue
  }
  if (patch.value !== undefined) setValue(field, patch.value)

  if (patch.name !== undefined && patch.name !== name) {
    const prefix = name.includes('.') ? name.slice(0, name.lastIndexOf('.') + 1) : ''
    const partial = prefix && patch.name.startsWith(prefix) ? patch.name.slice(prefix.length) : patch.name
    field.acroField.setPartialName(partial)
    field = requireField(pdf, prefix + partial)
  }

  await refreshAppearance(pdf, field)
  return field.getName()
}

const hexParts = (hex: string): [number, number, number] => {
  const c = hexToComponents(hex).map((v) => Math.round(v * 1000) / 1000)
  return [c[0], c[1], c[2]]
}

function readAlign(field: PDFTextField): 'left' | 'center' | 'right' {
  const q = field.acroField.dict.lookup(N('Q'))
  const n = q && 'asNumber' in q ? (q as { asNumber(): number }).asNumber() : 0
  return n === 1 ? 'center' : n === 2 ? 'right' : 'left'
}

/** Sets the current value of a field (no validation beyond what pdf-lib enforces). */
export function setValue(field: PDFField, value: string): void {
  if (field instanceof PDFTextField) {
    if (value === '') field.setText(undefined)
    else {
      const max = field.getMaxLength()
      if (max !== undefined && value.length > max) throw new BuilderError(`The value is longer than the maximum length (${max}).`)
      field.setText(value)
    }
  } else if (field instanceof PDFCheckBox) {
    if (value === 'true') field.check()
    else field.uncheck()
  } else if (field instanceof PDFRadioGroup) {
    if (value === '') field.clear()
    else field.select(value)
  } else if (field instanceof PDFDropdown) {
    if (value === '') field.clear()
    else if (field.isEditable() || field.getOptions().includes(value)) field.select(value)
    else throw new BuilderError(`“${value}” is not one of the options.`)
  } else if (field instanceof PDFOptionList) {
    const vals = value === '' ? [] : value.split('\n')
    if (vals.length === 0) field.clear()
    else field.select(vals)
  }
}

/** Regenerates the appearance streams (the visible look) of one field. */
export async function refreshAppearance(pdf: PDFDocument, field: PDFField): Promise<void> {
  if (field instanceof PDFSignature) {
    for (const w of field.acroField.getWidgets()) buildBoxAppearance(pdf, w)
    return
  }
  const da = parseDA(readDA(field))
  await loadStandardFont(pdf, da.fontName)
  await refreshField(pdf, field)
}

/** A plain filled/bordered box as the appearance of a widget that has no content of its own (signature fields). */
export function buildBoxAppearance(pdf: PDFDocument, widget: PDFWidgetAnnotation): void {
  const r = widget.getRectangle()
  const w = Math.abs(r.width)
  const h = Math.abs(r.height)
  const look = readWidgetLook(widget)
  const ops: string[] = []
  const rgb = (hex: string): string => hexParts(hex).join(' ')
  if (look.backgroundColor) ops.push(`${rgb(look.backgroundColor)} rg 0 0 ${w} ${h} re f`)
  if (look.borderColor && look.borderWidth > 0) {
    const bw = look.borderWidth
    ops.push(`${rgb(look.borderColor)} RG ${bw} w ${bw / 2} ${bw / 2} ${Math.max(0, w - bw)} ${Math.max(0, h - bw)} re S`)
  }
  const stream = pdf.context.stream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, w, h], Resources: {} })
  const ref = pdf.context.register(stream)
  widget.dict.set(N('AP'), pdf.context.obj({ N: ref }))
}

// ---------------------------------------------------------------------------------------------------------
// geometry

/** Moves/resizes widgets. Each update names a field and the index of the widget inside it. */
export async function setWidgetRects(pdf: PDFDocument, updates: { name: string; index: number; rect: URect }[]): Promise<void> {
  const touched = new Map<string, PDFField>()
  for (const u of updates) {
    const f = requireField(pdf, u.name)
    const w = f.acroField.getWidgets()[u.index]
    if (!w) throw new BuilderError(`The field “${u.name}” has no such button.`)
    w.setRectangle(toWidgetRect(u.rect))
    touched.set(u.name, f)
  }
  for (const f of touched.values()) await refreshAppearance(pdf, f)
}

/**
 * Removes a field completely: its widgets from their pages' /Annots, the field from its parent (or the form's
 * /Fields) and the objects. (pdf-lib's own `removeField` looks for the wrong reference and leaves the widget
 * annotations on the page.)
 */
export function removeField(pdf: PDFDocument, field: PDFField): void {
  const ctx = pdf.context
  const widgets = field.acroField.getWidgets()
  const refs = widgets.map((w) => ctx.getObjectRef(w.dict))
  refs.forEach((ref) => {
    if (!ref) return
    const page = pdf.findPageForAnnotationRef(ref)
    page?.node.removeAnnot(ref)
  })
  pdf.getForm().acroForm.removeField(field.acroField)
  for (const ref of refs) if (ref && ref !== field.ref) ctx.delete(ref)
  ctx.delete(field.ref)
}

/** Deletes fields (and their widgets) from the document. */
export function deleteFields(pdf: PDFDocument, names: string[]): void {
  const form = pdf.getForm()
  for (const n of names) {
    const f = form.getFieldMaybe(n)
    if (f) removeField(pdf, f)
  }
}

/** Removes one button from a radio group; deletes the group when it was the last one. */
export function deleteRadioButton(pdf: PDFDocument, name: string, index: number): void {
  const f = requireField(pdf, name)
  if (!(f instanceof PDFRadioGroup)) throw new BuilderError('Only radio groups have several buttons.')
  const widgets = f.acroField.getWidgets()
  if (widgets.length <= 1) {
    removeField(pdf, f)
    return
  }
  const w = widgets[index]
  if (!w) return
  const ref = pdf.context.getObjectRef(w.dict)
  const opts = f.getOptions()
  const selected = f.getSelected()
  const selectedIdx = selected === undefined ? -1 : opts.indexOf(selected)
  f.acroField.removeWidget(index)
  // Drop the matching /Opt entry and the widget from its page.
  const remaining = opts.filter((_, i) => i !== index)
  f.acroField.dict.set(N('Opt'), pdf.context.obj(remaining.map((v) => PDFHexString.fromText(v))))
  if (ref) {
    for (const page of pdf.getPages()) removeAnnot(page, ref)
    pdf.context.delete(ref)
  }
  // The selection is stored as the index of the selected option: keep it pointing at the same button.
  if (selectedIdx === index || selectedIdx < 0) f.acroField.dict.delete(N('V'))
  else f.acroField.dict.set(N('V'), N(String(selectedIdx > index ? selectedIdx - 1 : selectedIdx)))
  // Appearance state names were indexes: renumber so they match the shortened list.
  f.acroField.getWidgets().forEach((wi, i) => {
    const ap = wi.dict.lookupMaybe(N('AP'), PDFDict)
    for (const key of ['N', 'D']) {
      const d = ap?.lookupMaybe(N(key), PDFDict)
      if (!d) continue
      const onKey = d.keys().find((k) => k.decodeText() !== 'Off')
      if (onKey && onKey.decodeText() !== String(i)) {
        const v = d.get(onKey)!
        d.delete(onKey)
        d.set(N(String(i)), v)
        const as = wi.dict.lookup(N('AS'))
        if (as instanceof PDFName && as.decodeText() === onKey.decodeText()) wi.dict.set(N('AS'), N(String(i)))
      }
    }
  })
}

function removeAnnot(page: PDFPage, ref: ReturnType<PDFDocument['context']['register']>): void {
  const annots = page.node.Annots()
  if (!annots) return
  for (let i = annots.size() - 1; i >= 0; i--) {
    const a = annots.get(i)
    if (a === ref || (a && 'tag' in a && (a as { tag: string }).tag === ref.tag)) annots.remove(i)
  }
}

/** Resets every field to an empty value (text cleared, boxes unchecked, choices deselected). */
export async function clearAllFields(pdf: PDFDocument): Promise<number> {
  const form = pdf.getForm()
  let n = 0
  for (const f of form.getFields()) {
    let changed = false
    if (f instanceof PDFTextField) {
      if ((f.getText() ?? '') !== '') (f.setText(undefined), (changed = true))
    } else if (f instanceof PDFCheckBox) {
      if (f.isChecked()) (f.uncheck(), (changed = true))
    } else if (f instanceof PDFRadioGroup) {
      if (f.getSelected() !== undefined) (f.clear(), (changed = true))
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
      if (f.getSelected().length > 0) (f.clear(), (changed = true))
    }
    if (changed) {
      n++
      await refreshAppearance(pdf, f)
    }
  }
  return n
}

export { normRotation }
