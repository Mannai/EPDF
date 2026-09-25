import { PDFCheckBox, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField, type PDFDocument } from 'pdf-lib'
import { fontForText, helvetica, unicodeFont, unsupportedChars, UnsupportedCharactersError, type UnicodeFontProvider } from './fonts'
import { describeField, type FieldModel, type FieldValue } from './model'

/** Validation and application of form-field values. Pure pdf-lib logic (no DOM), unit-tested in Node. */

/** A value the user typed is not acceptable for this field. The message is written for the user. */
export class FormValueError extends Error {}

export type ValidationResult = { ok: true; value: FieldValue } | { ok: false; error: string }

const fail = (error: string): ValidationResult => ({ ok: false, error })

/**
 * Extension point: other features can add rules for text values (the form builder checks number / date /
 * email / pattern formats stored in a field's /AA scripts). A check returns a message for the user, or null
 * when the value is fine. Checks must be pure and must never run PDF JavaScript.
 */
export type ValueCheck = (field: FieldModel, value: string) => string | null
const valueChecks: ValueCheck[] = []
export function registerValueCheck(check: ValueCheck): void {
  valueChecks.push(check)
}
const runValueChecks = (field: FieldModel, value: string): string | null => {
  for (const c of valueChecks) {
    const m = c(field, value)
    if (m) return m
  }
  return null
}

/**
 * Checks (and normalises) a value against a field's rules: read-only, MaxLen, single vs multi line,
 * checkbox = boolean, radio = one of the export values, combo = listed value unless editable, list = subset.
 */
export function validateValue(field: FieldModel, value: FieldValue): ValidationResult {
  if (field.readOnly) return fail(`“${field.label}” is read-only.`)
  switch (field.kind) {
    case 'text': {
      if (typeof value !== 'string') return fail('Text fields take text.')
      let v = value
      if (!field.multiline) v = v.replace(/[\r\n]+/g, ' ')
      else v = v.replace(/\r\n?/g, '\n')
      if (field.maxLength !== undefined && v.length > field.maxLength) {
        return fail(`“${field.label}” accepts at most ${field.maxLength} characters (you entered ${v.length}).`)
      }
      const problem = runValueChecks(field, v)
      if (problem) return fail(problem)
      return { ok: true, value: v }
    }
    case 'checkbox':
      return typeof value === 'boolean' ? { ok: true, value } : fail('A checkbox is either checked or not.')
    case 'radio': {
      if (typeof value !== 'string' || !field.options.includes(value)) return fail(`“${value}” is not one of the choices for “${field.label}”.`)
      return { ok: true, value }
    }
    case 'dropdown': {
      if (typeof value !== 'string') return fail('Choose one value.')
      if (value !== '' && !field.editable && !field.options.includes(value)) return fail(`“${value}” is not in the list for “${field.label}”.`)
      if (field.maxLength !== undefined && value.length > field.maxLength) return fail(`“${field.label}” accepts at most ${field.maxLength} characters.`)
      return { ok: true, value }
    }
    case 'list': {
      const arr = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
      if (arr.some((v) => !field.options.includes(v))) return fail(`Some choices are not in the list for “${field.label}”.`)
      if (arr.length > 1 && !field.multiSelect) return fail(`“${field.label}” allows only one choice.`)
      return { ok: true, value: arr }
    }
    default:
      return fail(`“${field.label}” is a ${field.kind === 'signature' ? 'signature field' : 'button'} and can’t be filled in here.`)
  }
}

/** The text in a value that has to be encodable in the field's appearance font. */
export const textOf = (v: FieldValue): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n') : '')

/**
 * (Re)generates appearance streams for every field that needs one, so the filled form displays in other PDF
 * readers. Uses Helvetica when it can encode everything, otherwise the bundled Unicode font.
 */
export async function refreshAppearances(pdf: PDFDocument, texts: string, provider: UnicodeFontProvider): Promise<void> {
  const form = pdf.getForm()
  const h = await helvetica(pdf)
  if (unsupportedChars(h, texts).length === 0) {
    try {
      form.updateFieldAppearances(h)
      return
    } catch {
      // Some other field on the form holds text Helvetica cannot draw: fall through to the Unicode font.
    }
  }
  const u = await unicodeFont(pdf, provider)
  const bad = unsupportedChars(u, texts)
  if (bad.length > 0) throw new UnsupportedCharactersError(bad)
  form.updateFieldAppearances(u)
}

/**
 * Sets one field's value inside an `editPdf` callback and regenerates the appearances. Throws
 * `FormValueError` / `UnsupportedCharactersError` with a user-presentable message; nothing is saved then.
 */
export async function applyFieldValue(pdf: PDFDocument, name: string, value: FieldValue, provider: UnicodeFontProvider): Promise<void> {
  const form = pdf.getForm()
  const field = form.getFieldMaybe(name)
  if (!field) throw new FormValueError('That field no longer exists in the document.')
  const model = describeField(pdf, field)
  if (!model) throw new FormValueError('This kind of field is not supported.')
  const res = validateValue(model, value)
  if (!res.ok) throw new FormValueError(res.error)
  const v = res.value

  if (field instanceof PDFTextField) {
    // Fail early (before touching the document) if the text cannot be drawn at all.
    await fontForText(pdf, v as string, provider)
    if ((v as string) === '') field.setText(undefined)
    else field.setText(v as string)
    // A rich-text value (/RV) would override the plain value in some readers: the edit replaces both.
    field.acroField.dict.delete(PDFName.of('RV'))
  } else if (field instanceof PDFCheckBox) {
    if (v) field.check()
    else field.uncheck()
  } else if (field instanceof PDFRadioGroup) {
    field.select(v as string)
  } else if (field instanceof PDFDropdown) {
    await fontForText(pdf, v as string, provider)
    if (v === '') field.clear()
    else field.select(v as string)
  } else if (field instanceof PDFOptionList) {
    const arr = v as string[]
    await fontForText(pdf, arr.join('\n'), provider)
    if (arr.length === 0) field.clear()
    else field.select(arr)
  } else {
    throw new FormValueError('This kind of field can’t be filled in here.')
  }
  await refreshAppearances(pdf, textOf(v), provider)
}
