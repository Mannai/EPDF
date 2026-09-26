import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFStream, PDFTextField, decodePDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { UnsupportedCharactersError } from '../../src/renderer/src/features/forms/fonts'
import { extractFormModel, type FormModel } from '../../src/renderer/src/features/forms/model'
import { FormValueError, applyFieldValue, validateValue } from '../../src/renderer/src/features/forms/values'
import { createEncryptedFormPdf, createFormsPdf } from '../fixtures/forms-signing.mjs'

const noto = new Uint8Array(readFileSync(join('resources', 'fonts', 'NotoSans-Regular.ttf')))
const provider = async (): Promise<Uint8Array> => noto

let bytes: Uint8Array
let model: FormModel
const field = (name: string) => model.fields.find((f) => f.name === name)!

beforeAll(async () => {
  bytes = await createFormsPdf()
  model = extractFormModel(await PDFDocument.load(bytes))
})

async function fill(name: string, value: string | boolean | string[]): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes)
  await applyFieldValue(pdf, name, value, provider)
  return PDFDocument.load(await pdf.save())
}

/** True if the first widget has a normal appearance (a stream, or a dictionary of states for check boxes). */
const hasAppearance = (pdf: PDFDocument, name: string): boolean => {
  const normal = pdf.getForm().getField(name).acroField.getWidgets()[0].getAppearances()?.normal
  return normal instanceof PDFStream || normal instanceof PDFDict
}

const contentsOf = (s: PDFStream): string => {
  const raw = s as unknown as { contents?: Uint8Array }
  return Buffer.from(raw.contents ? decodePDFRawStream(s as never).decode() : s.getContents()).toString('latin1')
}

describe('encrypted documents', () => {
  it('cannot be read or edited by pdf-lib (the app shows the form read-only and explains why)', async () => {
    await expect(PDFDocument.load(createEncryptedFormPdf(), { updateMetadata: false })).rejects.toThrow(/encrypt/i)
  })
})

describe('validateValue', () => {
  it('enforces MaxLen', () => {
    expect(validateValue(field('code'), '12345')).toEqual({ ok: true, value: '12345' })
    const r = validateValue(field('code'), '123456')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/at most 5 characters/)
  })

  it('refuses read-only fields', () => {
    const r = validateValue(field('readonly_id'), 'x')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/read-only/)
  })

  it('joins lines of a single-line field and keeps them in a multiline one', () => {
    expect(validateValue(field('full_name'), 'a\nb')).toEqual({ ok: true, value: 'a b' })
    expect(validateValue(field('notes'), 'a\r\nb')).toEqual({ ok: true, value: 'a\nb' })
  })

  it('checkbox takes only a boolean', () => {
    expect(validateValue(field('agree'), true).ok).toBe(true)
    expect(validateValue(field('agree'), 'yes').ok).toBe(false)
  })

  it('radio takes only one of its export values', () => {
    expect(validateValue(field('color'), 'green').ok).toBe(true)
    expect(validateValue(field('color'), 'purple').ok).toBe(false)
    expect(validateValue(field('color'), true).ok).toBe(false)
  })

  it('a combo box takes listed values (or empty); an option list a subset', () => {
    expect(validateValue(field('country'), 'Spain').ok).toBe(true)
    expect(validateValue(field('country'), '').ok).toBe(true)
    expect(validateValue(field('country'), 'Atlantis').ok).toBe(false)
    expect(validateValue(field('langs'), ['English', 'German']).ok).toBe(true)
    expect(validateValue(field('langs'), ['Klingon']).ok).toBe(false)
  })

  it('buttons and signature fields are not fillable', () => {
    expect(validateValue(field('submit'), 'x').ok).toBe(false)
    expect(validateValue(field('sig_field'), 'x').ok).toBe(false)
  })
})

describe('applyFieldValue: real PDF output', () => {
  it('writes a text value and an appearance stream that survives a save/reload', async () => {
    const out = await fill('full_name', 'Ada Lovelace')
    expect(out.getForm().getTextField('full_name').getText()).toBe('Ada Lovelace')
    expect(hasAppearance(out, 'full_name')).toBe(true)
    // The appearance really contains the text (Helvetica, so it is plain in the content stream).
    const widget = out.getForm().getField('full_name').acroField.getWidgets()[0]
    const ap = widget.getNormalAppearance()
    const stream = (ap instanceof PDFStream ? ap : out.context.lookup(ap)) as PDFStream
    // pdf-lib writes the string as hex in a Tj operator.
    expect(contentsOf(stream).toUpperCase()).toContain(Buffer.from('Ada Lovelace').toString('hex').toUpperCase())
  })

  it('keeps unrelated fields untouched', async () => {
    const out = await fill('full_name', 'Ada')
    expect(out.getForm().getTextField('readonly_id').getText()).toBe('ID-0001')
    expect(out.getForm().getTextField('notes').getText()).toBeUndefined()
  })

  it('checks and unchecks a checkbox', async () => {
    const on = await fill('agree', true)
    expect((on.getForm().getField('agree') as PDFCheckBox).isChecked()).toBe(true)
    expect(hasAppearance(on, 'agree')).toBe(true)
    const pdf = await PDFDocument.load(await on.save())
    await applyFieldValue(pdf, 'agree', false, provider)
    expect((pdf.getForm().getField('agree') as PDFCheckBox).isChecked()).toBe(false)
  })

  it('selects exactly one radio button', async () => {
    const out = await fill('color', 'green')
    const radio = out.getForm().getField('color') as PDFRadioGroup
    expect(radio.getSelected()).toBe('green')
    // Exactly the second button is on (its state is the internal on-value, not the label).
    const states = radio.acroField.getWidgets().map((w) => w.getAppearanceState()?.toString())
    expect(states.filter((s) => s !== '/Off')).toHaveLength(1)
    expect(states[1]).not.toBe('/Off')
  })

  it('selects dropdown and option-list values', async () => {
    const d = await fill('country', 'Germany')
    expect(d.getForm().getDropdown('country').getSelected()).toEqual(['Germany'])
    expect(hasAppearance(d, 'country')).toBe(true)
    const l = await fill('langs', ['English', 'German'])
    expect(l.getForm().getOptionList('langs').getSelected()).toEqual(['English', 'German'])
  })

  it('clears a text value', async () => {
    const pdf = await PDFDocument.load(bytes)
    await applyFieldValue(pdf, 'full_name', 'x', provider)
    await applyFieldValue(pdf, 'full_name', '', provider)
    expect(pdf.getForm().getTextField('full_name').getText()).toBeUndefined()
  })

  it('rejects an over-long value without changing the document', async () => {
    const pdf = await PDFDocument.load(bytes)
    await expect(applyFieldValue(pdf, 'code', 'TOOLONG', provider)).rejects.toBeInstanceOf(FormValueError)
    expect(pdf.getForm().getTextField('code').getText()).toBeUndefined()
  })

  it('rejects a read-only field and a missing field', async () => {
    const pdf = await PDFDocument.load(bytes)
    await expect(applyFieldValue(pdf, 'readonly_id', 'hack', provider)).rejects.toThrow(/read-only/)
    await expect(applyFieldValue(pdf, 'nope', 'x', provider)).rejects.toThrow(/no longer exists/)
    expect(pdf.getForm().getTextField('readonly_id').getText()).toBe('ID-0001')
  })

  it('embeds the Unicode font for text WinAnsi cannot encode (Cyrillic, Greek, Polish)', async () => {
    const text = 'Привет Ελλάδα Zażółć'
    const out = await fill('full_name', text)
    expect(out.getForm().getTextField('full_name').getText()).toBe(text)
    expect(hasAppearance(out, 'full_name')).toBe(true)
    // A Type0/CID font was embedded (Helvetica alone could not draw this).
    const fonts = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o) => 'get' in o && (o as never as { get(n: PDFName): unknown }).get(PDFName.of('Subtype'))?.toString() === '/Type0')
    expect(fonts.length).toBeGreaterThan(0)
  })

  it('refuses characters no bundled font has, and leaves the document untouched', async () => {
    const pdf = await PDFDocument.load(bytes)
    // (Chinese used to be refused here; the text engine writes it now. Tibetan has no bundled font.)
    await expect(applyFieldValue(pdf, 'full_name', 'བོད་ཡིག', provider)).rejects.toBeInstanceOf(UnsupportedCharactersError)
    expect(pdf.getForm().getTextField('full_name').getText()).toBeUndefined()
  })

  it('drops a stale rich-text value (/RV) so no reader shows the old text', async () => {
    const pdf = await PDFDocument.load(bytes)
    const dict = pdf.getForm().getTextField('notes').acroField.dict
    dict.set(PDFName.of('RV'), pdf.context.obj('<body>old</body>'))
    await applyFieldValue(pdf, 'notes', 'new text', provider)
    expect(dict.get(PDFName.of('RV'))).toBeUndefined()
    expect(pdf.getForm().getTextField('notes').getText()).toBe('new text')
  })

  it('a multiline value keeps its line breaks', async () => {
    const out = await fill('notes', 'line one\nline two')
    expect((out.getForm().getField('notes') as PDFTextField).getText()).toBe('line one\nline two')
  })
})
