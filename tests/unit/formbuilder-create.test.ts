import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown, PDFName, PDFNumber, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField, PDFButton, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createField, addRadioButton } from '../../src/renderer/src/features/formbuilder/logic/create'
import { deleteFields, deleteRadioButton, applyPatch, setWidgetRects, clearAllFields, BuilderError } from '../../src/renderer/src/features/formbuilder/logic/edit'
import { readBuilderModel } from '../../src/renderer/src/features/formbuilder/logic/read'
import type { FieldSpec } from '../../src/renderer/src/features/formbuilder/logic/spec'
import { extractFormModel } from '../../src/renderer/src/features/forms/model'
import { tabStops } from '../../src/renderer/src/features/forms/tabOrder'

const N = PDFName.of

async function blank(rotate = 0, size: [number, number] = [612, 792]): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  const p = doc.addPage(size)
  if (rotate) p.setRotation(degrees(rotate))
  doc.addPage(size)
  return doc
}
const reload = async (doc: PDFDocument): Promise<PDFDocument> => PDFDocument.load(await doc.save())

const rect = (x: number, y: number, w: number, h: number) => ({ x1: x, y1: y, x2: x + w, y2: y + h })

async function pdfjsAnnotations(bytes: Uint8Array, pageNo = 1): Promise<Record<string, unknown>[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo)
    return (await page.getAnnotations()) as Record<string, unknown>[]
  } finally {
    await task.destroy()
  }
}

const SPECS: FieldSpec[] = [
  { kind: 'text', name: 'full_name', pageIndex: 0, rect: rect(72, 700, 200, 22), tooltip: 'Full name', required: true, maxLength: 40 },
  { kind: 'text', name: 'notes', pageIndex: 0, rect: rect(72, 620, 300, 60), multiline: true },
  { kind: 'text', name: 'secret', pageIndex: 0, rect: rect(72, 590, 100, 20), password: true, readOnly: true },
  { kind: 'text', name: 'account', pageIndex: 0, rect: rect(72, 550, 160, 20), comb: true, maxLength: 8 },
  { kind: 'checkbox', name: 'agree', pageIndex: 0, rect: rect(72, 520, 14, 14), tooltip: 'I agree', onValue: 'Agreed' },
  {
    kind: 'radio',
    name: 'level',
    pageIndex: 0,
    rect: rect(72, 480, 100, 14),
    buttons: [
      { rect: rect(72, 480, 14, 14), value: 'basic' },
      { rect: rect(120, 480, 14, 14), value: 'plus' },
      { rect: rect(170, 480, 14, 14), value: 'pro' }
    ],
    value: 'plus'
  },
  { kind: 'dropdown', name: 'country', pageIndex: 0, rect: rect(72, 440, 140, 22), options: ['France', 'Germany', 'Spain'], value: 'Spain' },
  { kind: 'dropdown', name: 'combo', pageIndex: 0, rect: rect(240, 440, 140, 22), options: ['a', 'b'], editable: true },
  { kind: 'list', name: 'langs', pageIndex: 0, rect: rect(72, 350, 140, 70), options: ['en', 'fr', 'de'], multiSelect: true },
  { kind: 'signature', name: 'sig', pageIndex: 0, rect: rect(72, 280, 200, 44) },
  { kind: 'button', name: 'go', pageIndex: 0, rect: rect(72, 240, 90, 26), caption: 'Submit' },
  { kind: 'text', name: 'page2_field', pageIndex: 1, rect: rect(100, 600, 150, 20), style: { borderColor: null, backgroundColor: null, borderWidth: 0 } }
]

async function build(rotate = 0): Promise<PDFDocument> {
  const doc = await blank(rotate)
  for (const s of SPECS) await createField(doc, s)
  return doc
}

describe('createField: real AcroForm objects', () => {
  it('creates every field type; the saved file re-loads with the right types, flags and kids', async () => {
    const doc = await reload(await build())
    const form = doc.getForm()
    const f = (n: string) => form.getField(n)
    expect(f('full_name')).toBeInstanceOf(PDFTextField)
    expect(f('notes')).toBeInstanceOf(PDFTextField)
    expect(f('agree')).toBeInstanceOf(PDFCheckBox)
    expect(f('level')).toBeInstanceOf(PDFRadioGroup)
    expect(f('country')).toBeInstanceOf(PDFDropdown)
    expect(f('langs')).toBeInstanceOf(PDFOptionList)
    expect(f('sig')).toBeInstanceOf(PDFSignature)
    expect(f('go')).toBeInstanceOf(PDFButton)

    const name = form.getTextField('full_name')
    expect(name.isRequired()).toBe(true)
    expect(name.getMaxLength()).toBe(40)
    expect(name.acroField.dict.lookup(N('TU'))!.toString()).toBeTruthy()
    expect(form.getTextField('notes').isMultiline()).toBe(true)
    const secret = form.getTextField('secret')
    expect(secret.isPassword()).toBe(true)
    expect(secret.isReadOnly()).toBe(true)
    const account = form.getTextField('account')
    expect(account.isCombed()).toBe(true)
    expect(account.getMaxLength()).toBe(8)
    expect(form.getCheckBox('agree').acroField.getWidgets()[0].getOnValue()?.decodeText()).toBe('Agreed')

    const level = form.getRadioGroup('level')
    expect(level.getOptions()).toEqual(['basic', 'plus', 'pro'])
    expect(level.getSelected()).toBe('plus')
    expect(level.acroField.getWidgets()).toHaveLength(3) // one field, three kid widgets
    expect(level.acroField.dict.lookup(N('Kids'), PDFArray).size()).toBe(3)

    expect(form.getDropdown('country').getSelected()).toEqual(['Spain'])
    expect(form.getDropdown('combo').isEditable()).toBe(true)
    expect(form.getOptionList('langs').isMultiselect()).toBe(true)
    expect(form.getOptionList('langs').getOptions()).toEqual(['en', 'fr', 'de'])
  })

  it('widgets have exact /Rect, /P, /MK, /BS, /F and appearance streams', async () => {
    const doc = await reload(await build())
    const form = doc.getForm()
    const w = form.getTextField('full_name').acroField.getWidgets()[0]
    expect(w.getRectangle()).toEqual({ x: 72, y: 700, width: 200, height: 22 })
    expect(w.dict.lookup(N('P'))).toBe(doc.getPage(0).node)
    const mk = w.dict.lookup(N('MK'), PDFDict)
    expect(mk.has(N('BC'))).toBe(true)
    expect(mk.has(N('BG'))).toBe(true)
    expect(w.dict.lookup(N('BS'), PDFDict).lookup(N('W'), PDFNumber).asNumber()).toBe(1)
    expect((w.dict.lookup(N('F'), PDFNumber).asNumber() & 4) === 4).toBe(true)
    expect(w.dict.has(N('AP'))).toBe(true)
    // Every widget of every field has an /AP /N.
    for (const field of form.getFields()) for (const wi of field.acroField.getWidgets()) expect(wi.dict.lookup(N('AP'), PDFDict).has(N('N')), field.getName()).toBe(true)
    // The field on page 2 sits in page 2's /Annots, not page 1's.
    const p2 = doc.getPage(1).node.Annots()!
    expect(p2.size()).toBe(1)
    // A transparent overlay field has neither border nor background entries.
    const ov = form.getTextField('page2_field').acroField.getWidgets()[0].dict.lookup(N('MK'), PDFDict)
    expect(ov.has(N('BC'))).toBe(false)
    expect(ov.has(N('BG'))).toBe(false)
  })

  it('writes /AcroForm /DA and /DR so other readers can edit the fields', async () => {
    const doc = await reload(await build())
    const acro = doc.getForm().acroForm.dict
    expect(acro.lookup(N('DA'))!.toString()).toContain('Helv')
    const fonts = acro.lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict)
    expect(fonts.has(N('Helv'))).toBe(true)
    const da = doc.getForm().getTextField('full_name').acroField.getDefaultAppearance()
    expect(da).toMatch(/\/Helv 0 Tf/)
    expect(acro.has(N('NeedAppearances'))).toBe(false) // appearances are generated, not deferred to the reader
  })

  it('is understood by the merged forms feature (its own model extraction)', async () => {
    const doc = await reload(await build())
    const m = extractFormModel(doc)
    expect(m.error).toBeUndefined()
    const byName = Object.fromEntries(m.fields.map((x) => [x.name, x]))
    expect(Object.fromEntries(m.fields.map((x) => [x.name, x.kind]))).toEqual({
      full_name: 'text',
      notes: 'text',
      secret: 'text',
      account: 'text',
      agree: 'checkbox',
      level: 'radio',
      country: 'dropdown',
      combo: 'dropdown',
      langs: 'list',
      sig: 'signature',
      go: 'button',
      page2_field: 'text'
    })
    expect(byName.full_name.required).toBe(true)
    expect(byName.full_name.maxLength).toBe(40)
    expect(byName.full_name.label).toBe('Full name')
    expect(byName.notes.multiline).toBe(true)
    expect(byName.account.comb).toBe(true)
    expect(byName.level.widgets.map((w) => w.onValue)).toEqual(['basic', 'plus', 'pro'])
    expect(byName.level.value).toBe('plus')
    expect(byName.page2_field.widgets[0].pageIndex).toBe(1)
    expect(byName.full_name.widgets[0].rect).toEqual({ x1: 72, y1: 700, x2: 272, y2: 722 })
    expect(byName.country.options).toEqual(['France', 'Germany', 'Spain'])
    expect(byName.combo.editable).toBe(true)
    expect(tabStops(m).length).toBeGreaterThan(5)
  })

  it('is read by PDF.js (legacy build, Node): widget annotations with the right field types', async () => {
    const bytes = await (await build()).save()
    const annots = await pdfjsAnnotations(bytes)
    const w = (n: string) => annots.filter((a) => a.fieldName === n)
    expect(annots.every((a) => a.subtype === 'Widget')).toBe(true)
    expect(w('full_name')[0]).toMatchObject({ fieldType: 'Tx', required: true, maxLen: 40 })
    expect(w('notes')[0]).toMatchObject({ fieldType: 'Tx', multiLine: true })
    expect(w('secret')[0]).toMatchObject({ fieldType: 'Tx', password: true, readOnly: true })
    expect(w('account')[0]).toMatchObject({ fieldType: 'Tx', comb: true })
    expect(w('agree')[0]).toMatchObject({ fieldType: 'Btn', checkBox: true })
    expect(w('level')).toHaveLength(3)
    expect(w('level')[0]).toMatchObject({ fieldType: 'Btn', radioButton: true })
    expect(w('country')[0]).toMatchObject({ fieldType: 'Ch', combo: true })
    expect(w('langs')[0]).toMatchObject({ fieldType: 'Ch', multiSelect: true })
    expect(w('sig')[0]).toMatchObject({ fieldType: 'Sig' })
    expect(w('go')[0]).toMatchObject({ fieldType: 'Btn', pushButton: true })
    const rectOf = w('full_name')[0].rect as number[]
    expect(rectOf.map((n) => Math.round(n))).toEqual([72, 700, 272, 722])
    expect((await pdfjsAnnotations(bytes, 2)).map((a) => a.fieldName)).toEqual(['page2_field'])
  })

  it('rotated pages: /Rect stays in user space, /MK /R carries the page rotation, appearances match', async () => {
    for (const rot of [90, 180, 270]) {
      const doc = await reload(await build(rot))
      const form = doc.getForm()
      const w = form.getTextField('full_name').acroField.getWidgets()[0]
      expect(w.getRectangle()).toEqual({ x: 72, y: 700, width: 200, height: 22 })
      expect(w.dict.lookup(N('MK'), PDFDict).lookup(N('R'), PDFNumber).asNumber()).toBe(rot)
      const ap = w.dict.lookup(N('AP'), PDFDict).lookup(N('N')) as unknown as { dict: PDFDict }
      const bbox = ap.dict.lookup(N('BBox'), PDFArray)
      const nums = [0, 1, 2, 3].map((i) => (bbox.lookup(i) as PDFNumber).asNumber())
      // The appearance box is the widget's own rectangle; pdf-lib rotates the content inside it by /MK /R.
      expect([Math.round(nums[2] - nums[0]), Math.round(nums[3] - nums[1])]).toEqual([200, 22])
      const annots = await pdfjsAnnotations(await doc.save())
      expect(annots.find((a) => a.fieldName === 'full_name')).toMatchObject({ fieldType: 'Tx' })
    }
  })

  it('refuses bad input without changing the document: duplicate names, bad names, tiny fields, missing pages', async () => {
    const doc = await blank()
    await createField(doc, { kind: 'text', name: 'a', pageIndex: 0, rect: rect(10, 10, 100, 20) })
    await expect(createField(doc, { kind: 'text', name: 'a', pageIndex: 0, rect: rect(10, 50, 100, 20) })).rejects.toThrow(/already exists/)
    await expect(createField(doc, { kind: 'text', name: 'A', pageIndex: 0, rect: rect(10, 50, 100, 20) })).rejects.toThrow(/already exists/)
    await expect(createField(doc, { kind: 'text', name: 'a.b', pageIndex: 0, rect: rect(10, 50, 100, 20) })).rejects.toThrow(/period/)
    await expect(createField(doc, { kind: 'text', name: '', pageIndex: 0, rect: rect(10, 50, 100, 20) })).rejects.toThrow(/empty/)
    await expect(createField(doc, { kind: 'text', name: 'tiny', pageIndex: 0, rect: rect(10, 50, 1, 1) })).rejects.toThrow(/too small/)
    await expect(createField(doc, { kind: 'text', name: 'x', pageIndex: 9, rect: rect(10, 50, 100, 20) })).rejects.toThrow(/page/)
    await expect(createField(doc, { kind: 'text', name: 'comb', pageIndex: 0, rect: rect(10, 50, 100, 20), comb: true })).rejects.toThrow(/maximum length/)
    await expect(createField(doc, { kind: 'radio', name: 'r', pageIndex: 0, rect: rect(0, 0, 10, 10), buttons: [{ rect: rect(0, 0, 10, 10), value: 'x' }, { rect: rect(20, 0, 10, 10), value: 'x' }] })).rejects.toThrow(/different/)
    expect(doc.getForm().getFields().map((x) => x.getName())).toEqual(['a'])
    expect(doc.getPage(0).node.Annots()!.size()).toBe(1)
  })
})

describe('radio group semantics', () => {
  it('one field, exclusive values, one selection at a time; buttons can be added and removed', async () => {
    const doc = await blank()
    await createField(doc, {
      kind: 'radio',
      name: 'size',
      pageIndex: 0,
      rect: rect(50, 500, 100, 14),
      buttons: [
        { rect: rect(50, 500, 14, 14), value: 'S' },
        { rect: rect(100, 500, 14, 14), value: 'M' }
      ]
    })
    await addRadioButton(doc, 'size', 0, rect(150, 500, 14, 14), 'L')
    await expect(addRadioButton(doc, 'size', 0, rect(200, 500, 14, 14), 'L')).rejects.toThrow(/already/)
    let g = doc.getForm().getRadioGroup('size')
    expect(g.getOptions()).toEqual(['S', 'M', 'L'])
    g.select('M')
    g.select('L')
    expect(g.getSelected()).toBe('L') // selecting another value deselects the previous one
    const states = g.acroField.getWidgets().map((w) => w.dict.lookup(N('AS'))!.toString())
    expect(states.filter((s) => s !== '/Off')).toHaveLength(1)
    // Off-toggling is disabled: exactly one stays selected in readers.
    expect(g.isOffToggleable()).toBe(false)

    doc.getForm().getRadioGroup('size') // still there after a round trip
    const again = await reload(doc)
    g = again.getForm().getRadioGroup('size')
    expect(g.getSelected()).toBe('L')

    deleteRadioButton(again, 'size', 1)
    g = again.getForm().getRadioGroup('size')
    expect(g.getOptions()).toEqual(['S', 'L'])
    expect(g.acroField.getWidgets()).toHaveLength(2)
    expect(g.getSelected()).toBe('L')
    expect(again.getPage(0).node.Annots()!.size()).toBe(2)
    deleteRadioButton(again, 'size', 0)
    deleteRadioButton(again, 'size', 0)
    expect(again.getForm().getFieldMaybe('size')).toBeUndefined()
    expect(again.getPage(0).node.Annots()!.size()).toBe(0)
  })

  it('export values can be renamed and must stay unique', async () => {
    const doc = await blank()
    await createField(doc, {
      kind: 'radio',
      name: 'g',
      pageIndex: 0,
      rect: rect(0, 0, 10, 10),
      buttons: [
        { rect: rect(50, 500, 14, 14), value: 'a' },
        { rect: rect(100, 500, 14, 14), value: 'b' }
      ],
      value: 'b'
    })
    await applyPatch(doc, 'g', { radioValues: ['Yes', 'No'] })
    const g = doc.getForm().getRadioGroup('g')
    expect(g.getOptions()).toEqual(['Yes', 'No'])
    expect(g.getSelected()).toBe('No')
    await expect(applyPatch(doc, 'g', { radioValues: ['x', 'x'] })).rejects.toThrow(/different/)
    await expect(applyPatch(doc, 'g', { radioValues: ['x'] })).rejects.toThrow(/every radio button/i)
  })
})

describe('property edits round-trip', () => {
  it('reads back what was written: flags, limits, look, options, tooltip', async () => {
    const doc = await build()
    await applyPatch(doc, 'full_name', {
      tooltip: 'Legal name',
      required: false,
      readOnly: true,
      maxLength: 12,
      style: { fontName: 'TiRo', fontSize: 14, textColor: '#ff0000', align: 'center', borderColor: '#0000ff', backgroundColor: '#ffff00', borderWidth: 2, borderStyle: 'dashed' },
      defaultValue: 'Ada'
    })
    await applyPatch(doc, 'country', { options: ['Italy', 'Spain'] })
    await applyPatch(doc, 'agree', { onValue: 'Ok', value: 'true' })
    const back = await reload(doc)
    const model = readBuilderModel(back)
    const f = (n: string) => model.fields.find((x) => x.name === n)!
    const name = f('full_name')
    expect(name).toMatchObject({ tooltip: 'Legal name', required: false, readOnly: true, maxLength: 12, defaultValue: 'Ada', value: 'Ada' })
    expect(name.style).toMatchObject({ fontName: 'TiRo', fontSize: 14, textColor: '#ff0000', align: 'center', borderColor: '#0000ff', backgroundColor: '#ffff00', borderWidth: 2, borderStyle: 'dashed' })
    expect(f('country').options).toEqual(['Italy', 'Spain'])
    expect(f('country').value).toBe('Spain')
    expect(f('agree')).toMatchObject({ onValue: 'Ok', value: 'true' })
    expect(back.getForm().getCheckBox('agree').isChecked()).toBe(true)
    // The DR knows the Times font used by the field.
    const fonts = back.getForm().acroForm.dict.lookup(N('DR'), PDFDict).lookup(N('Font'), PDFDict)
    expect(fonts.has(N('TiRo'))).toBe(true)
    expect(f('sig').kind).toBe('signature')
    expect(f('level').widgets.map((w) => w.value)).toEqual(['basic', 'plus', 'pro'])
  })

  it('renames a field (unique, valid names only) and keeps its widgets', async () => {
    const doc = await build()
    expect(await applyPatch(doc, 'notes', { name: 'comments' })).toBe('comments')
    expect(doc.getForm().getFieldMaybe('notes')).toBeUndefined()
    expect(doc.getForm().getTextField('comments').acroField.getWidgets()).toHaveLength(1)
    await expect(applyPatch(doc, 'comments', { name: 'full_name' })).rejects.toThrow(/already exists/)
    await expect(applyPatch(doc, 'comments', { name: 'bad.name' })).rejects.toThrow(/period/)
    await expect(applyPatch(doc, 'comments', { name: '  ' })).rejects.toBeInstanceOf(BuilderError)
    await expect(applyPatch(doc, 'nope', { tooltip: 'x' })).rejects.toThrow(/no longer exists/)
  })

  it('comb needs a max length; too-long text is refused; hidden hides every widget', async () => {
    const doc = await build()
    await expect(applyPatch(doc, 'full_name', { comb: true, maxLength: undefined })).rejects.toThrow()
    await applyPatch(doc, 'full_name', { hidden: true })
    const m = readBuilderModel(await reload(doc))
    expect(m.fields.find((x) => x.name === 'full_name')!.hidden).toBe(true)
    expect(extractFormModel(await reload(doc)).fields.find((x) => x.name === 'full_name')).toBeUndefined() // hidden = not shown to fillers
    await expect(applyPatch(doc, 'account', { value: 'way too long value' })).rejects.toThrow(/maximum length/)
  })

  it('moves and resizes widgets and regenerates their appearance; deletes; clears values', async () => {
    const doc = await build()
    await setWidgetRects(doc, [{ name: 'full_name', index: 0, rect: rect(100, 300, 120, 30) }])
    const w = doc.getForm().getTextField('full_name').acroField.getWidgets()[0]
    expect(w.getRectangle()).toEqual({ x: 100, y: 300, width: 120, height: 30 })
    const ap = w.dict.lookup(N('AP'), PDFDict).lookup(N('N')) as unknown as { dict: PDFDict }
    const bbox = ap.dict.lookup(N('BBox'), PDFArray)
    expect([2, 3].map((i) => Math.round((bbox.lookup(i) as PDFNumber).asNumber()))).toEqual([120, 30])

    await applyPatch(doc, 'full_name', { value: 'Ada' })
    await applyPatch(doc, 'agree', { value: 'true' })
    expect(await clearAllFields(doc)).toBeGreaterThanOrEqual(3) // name, agree, plus the preselected radio/dropdown
    expect(doc.getForm().getTextField('full_name').getText()).toBeUndefined()
    expect(doc.getForm().getCheckBox('agree').isChecked()).toBe(false)
    expect(doc.getForm().getRadioGroup('level').getSelected()).toBeUndefined()

    deleteFields(doc, ['notes', 'level', 'sig'])
    expect(doc.getForm().getFieldMaybe('notes')).toBeUndefined()
    expect(doc.getForm().getFieldMaybe('level')).toBeUndefined()
    expect(doc.getPage(0).node.Annots()!.size()).toBe(SPECS.filter((s) => s.pageIndex === 0).length - 3)
  })
})
