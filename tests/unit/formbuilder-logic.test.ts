import { PDFDict, PDFDocument, PDFName, PDFRef, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { checkValue, isDateInFormat, isSafeRegex, parseScripts, scriptsFor } from '../../src/renderer/src/features/formbuilder/logic/actions'
import { align, distribute, nudge, resizeBy, sameSize } from '../../src/renderer/src/features/formbuilder/logic/align'
import { applyProposals, detectDocument, proposalToSpec } from '../../src/renderer/src/features/formbuilder/logic/apply'
import { createField } from '../../src/renderer/src/features/formbuilder/logic/create'
import { fieldsToCsv } from '../../src/renderer/src/features/formbuilder/logic/csv'
import { applyPatch } from '../../src/renderer/src/features/formbuilder/logic/edit'
import { exportValueFor, isValidFieldName, nameFor, nameProblem, sanitizeName, uniqueName } from '../../src/renderer/src/features/formbuilder/logic/names'
import { readBuilderModel, readScripts } from '../../src/renderer/src/features/formbuilder/logic/read'
import type { FormatSpec } from '../../src/renderer/src/features/formbuilder/logic/spec'
import { applyTabPreset, readTabInfo, setPageTabs, setTabOrder, visualOrder } from '../../src/renderer/src/features/formbuilder/logic/tabs'
import { extractFormModel } from '../../src/renderer/src/features/forms/model'
import { stepStop, tabStops } from '../../src/renderer/src/features/forms/tabOrder'
import { validateValue } from '../../src/renderer/src/features/forms/values'
import { createFieldsForm, createMixed } from '../fixtures/form-builder.mjs'

const N = PDFName.of
const rect = (x: number, y: number, w: number, h: number) => ({ x1: x, y1: y, x2: x + w, y2: y + h })
const reload = async (d: PDFDocument): Promise<PDFDocument> => PDFDocument.load(await d.save())

describe('field names from labels', () => {
  it('turns printed labels into valid, tidy names', () => {
    expect(sanitizeName('Full name:')).toBe('Full_name')
    expect(sanitizeName('  Date of birth (optional) ')).toBe('Date_of_birth')
    expect(sanitizeName('1. First name *')).toBe('First_name')
    expect(sanitizeName('• Email / phone')).toBe('Email_phone')
    expect(sanitizeName('Straße & Größe?')).toBe('Straße_Größe')
    expect(sanitizeName('a.b.c')).toBe('abc') // no periods: they would create a hierarchy
    expect(sanitizeName('???')).toBe('')
    expect(sanitizeName('x'.repeat(100)).length).toBeLessThanOrEqual(48)
    expect(sanitizeName('A very long label that goes on and on and on and on forever')).toBe('A_very_long_label_that_goes_on_and_on_and_on')
  })

  it('makes names unique (case-insensitively) and falls back to numbered stems', () => {
    const taken = new Set<string>(['Name'])
    expect(uniqueName('Name', taken)).toBe('Name_2')
    expect(uniqueName('name', taken)).toBe('name_3')
    expect(nameFor('Address:', 'Text', taken)).toBe('Address')
    expect(nameFor(undefined, 'Text', taken)).toBe('Text1')
    expect(nameFor(undefined, 'Text', taken)).toBe('Text2')
    expect(nameFor('???', 'Text', taken)).toBe('Text3')
    const values = new Set<string>()
    expect(exportValueFor('Yes', 0, values)).toBe('Yes')
    expect(exportValueFor('Yes', 1, values)).toBe('Yes_2')
    expect(exportValueFor(undefined, 2, values)).toBe('Choice3')
  })

  it('validates names typed by the user', () => {
    expect(isValidFieldName('Full_name')).toBe(true)
    expect(nameProblem('')).toMatch(/empty/)
    expect(nameProblem('a.b')).toMatch(/period/)
    expect(nameProblem(' a')).toMatch(/space/)
    expect(nameProblem('a\u0001')).toMatch(/control/)
    expect(nameProblem('x'.repeat(200))).toMatch(/long/)
  })
})

describe('validation / format actions (Acrobat-compatible /AA JavaScript, written only)', () => {
  const SPECS: FormatSpec[] = [
    { type: 'number', decimals: 2, sep: 0, neg: 0, currency: '$', prepend: true, min: 0, max: 1000 },
    { type: 'number', decimals: 0, sep: 2, neg: 2, currency: '', prepend: false },
    { type: 'percent', decimals: 1, sep: 0 },
    { type: 'date', format: 'dd/mm/yyyy' },
    { type: 'date', format: 'd mmmm yyyy' },
    { type: 'time', format: 1 },
    { type: 'special', special: 'zip' },
    { type: 'special', special: 'phone' },
    { type: 'special', special: 'ssn' },
    { type: 'email' },
    { type: 'regex', pattern: '^[A-Z]{2}\\d{4}$', message: 'Use two capitals and 4 digits, e.g. "AB1234".' }
  ]

  it('generates the standard helper calls other readers understand', () => {
    expect(scriptsFor({ type: 'number', decimals: 2, sep: 0, neg: 0, currency: '', prepend: true })).toEqual({
      format: 'AFNumber_Format(2, 0, 0, 0, "", true);',
      keystroke: 'AFNumber_Keystroke(2, 0, 0, 0, "", true);',
      validate: undefined
    })
    expect(scriptsFor({ type: 'number', decimals: 2, sep: 1, neg: 0, currency: '€', prepend: false, min: 0, max: 99.5 }).validate).toBe('AFRange_Validate(true, 0, true, 99.5);')
    expect(scriptsFor({ type: 'percent', decimals: 2, sep: 0 }).format).toBe('AFPercent_Format(2, 0);')
    expect(scriptsFor({ type: 'date', format: 'mm/dd/yyyy' })).toEqual({ format: 'AFDate_FormatEx("mm/dd/yyyy");', keystroke: 'AFDate_KeystrokeEx("mm/dd/yyyy");' })
    expect(scriptsFor({ type: 'special', special: 'zip' }).format).toBe('AFSpecial_Format(0);')
    expect(scriptsFor({ type: 'special', special: 'phone' }).format).toBe('AFSpecial_Format(2);')
    expect(scriptsFor({ type: 'special', special: 'ssn' }).keystroke).toBe('AFSpecial_Keystroke(3);')
    expect(scriptsFor({ type: 'time', format: 2 }).format).toBe('AFTime_Format(2);')
    expect(scriptsFor({ type: 'email' }).validate).toMatch(/event\.rc = false/)
    const rx = scriptsFor({ type: 'regex', pattern: '^\\d+$', message: 'Digits "only"' }).validate!
    expect(rx).toContain('new RegExp("^\\\\d+$")')
    expect(rx).toContain('app.alert("Digits \\"only\\"")')
    expect(scriptsFor({ type: 'none' })).toEqual({})
  })

  it('every rule survives a write/parse round trip (including quotes and backslashes)', () => {
    for (const s of SPECS) expect(parseScripts(scriptsFor(s)), JSON.stringify(s)).toEqual(s.type === 'number' && s.min === undefined ? { ...s, min: undefined, max: undefined } : s)
  })

  it('recognises Acrobat-authored scripts too, and shrugs at unknown ones', () => {
    expect(parseScripts({ format: 'AFNumber_Format(3, 1, 2, 0, "£", true);' })).toMatchObject({ type: 'number', decimals: 3, sep: 1, neg: 2, currency: '£', prepend: true })
    expect(parseScripts({ format: 'AFDate_FormatEx("yyyy-mm-dd");' })).toEqual({ type: 'date', format: 'yyyy-mm-dd' })
    expect(parseScripts({ format: 'var x = 1; myCustom();' })).toEqual({ type: 'none' })
    expect(parseScripts({})).toEqual({ type: 'none' })
  })

  it('checks values the way the helpers would (Epdf never runs the JavaScript)', () => {
    const num: FormatSpec = { type: 'number', decimals: 2, sep: 0, neg: 0, currency: '$', prepend: true, min: 0, max: 1000 }
    expect(checkValue(num, '1,234.5', 'Amount')).toMatch(/at most 1000/)
    expect(checkValue(num, '$12.50', 'Amount')).toBeNull()
    expect(checkValue(num, 'abc', 'Amount')).toMatch(/must be a number/)
    expect(checkValue(num, '-5', 'Amount')).toMatch(/at least 0/)
    expect(checkValue(num, '', 'Amount')).toBeNull() // empty is never a format error
    expect(checkValue({ type: 'number', decimals: 2, sep: 2, neg: 0, currency: '', prepend: false }, '1.234,56', 'x')).toBeNull()
    expect(checkValue({ type: 'number', decimals: 2, sep: 2, neg: 0, currency: '', prepend: false }, '1,234.56', 'x')).toMatch(/number/)
    expect(checkValue({ type: 'percent', decimals: 1, sep: 0 }, '12.5%', 'x')).toBeNull()
    expect(checkValue({ type: 'percent', decimals: 1, sep: 0 }, 'many', 'x')).toMatch(/percentage/)
    expect(checkValue({ type: 'date', format: 'dd/mm/yyyy' }, '31/12/2024', 'Date')).toBeNull()
    expect(checkValue({ type: 'date', format: 'dd/mm/yyyy' }, '31/02/2024', 'Date')).toMatch(/valid date/)
    expect(checkValue({ type: 'date', format: 'dd/mm/yyyy' }, '2024-12-31', 'Date')).toMatch(/dd\/mm\/yyyy/)
    expect(isDateInFormat('29/02/2024', 'dd/mm/yyyy')).toBe(true)
    expect(isDateInFormat('29/02/2023', 'dd/mm/yyyy')).toBe(false)
    expect(isDateInFormat('5 March 2021', 'd mmmm yyyy')).toBe(true)
    expect(isDateInFormat('2021-03-05', 'yyyy-mm-dd')).toBe(true)
    expect(checkValue({ type: 'special', special: 'zip' }, '12345', 'Zip')).toBeNull()
    expect(checkValue({ type: 'special', special: 'zip' }, '1234', 'Zip')).toMatch(/ZIP/)
    expect(checkValue({ type: 'special', special: 'phone' }, '(555) 123-4567', 'Tel')).toBeNull()
    expect(checkValue({ type: 'special', special: 'phone' }, '123-4567', 'Tel')).toBeNull()
    expect(checkValue({ type: 'special', special: 'ssn' }, '123-45-678', 'SSN')).toMatch(/social/)
    expect(checkValue({ type: 'email' }, 'ada@example.org', 'Email')).toBeNull()
    expect(checkValue({ type: 'email' }, 'ada@', 'Email')).toMatch(/email/)
    expect(checkValue({ type: 'regex', pattern: '^[A-Z]{2}\\d{4}$', message: 'Bad code' }, 'AB1234', 'Code')).toBeNull()
    expect(checkValue({ type: 'regex', pattern: '^[A-Z]{2}\\d{4}$', message: 'Bad code' }, 'ab1234', 'Code')).toBe('Bad code')
    expect(checkValue({ type: 'time', format: 0 }, '14:30', 'Time')).toBeNull()
    expect(checkValue({ type: 'time', format: 0 }, '25', 'Time')).toMatch(/time/)
  })

  it('refuses risky or broken patterns instead of running them', () => {
    expect(isSafeRegex('^\\d+$')).toBe(true)
    expect(isSafeRegex('(a+)+$')).toBe(false) // nested quantifier: catastrophic backtracking
    expect(isSafeRegex('([a-z]*)*')).toBe(false)
    expect(isSafeRegex('[')).toBe(false)
    expect(isSafeRegex('')).toBe(false)
    expect(isSafeRegex('a'.repeat(300))).toBe(false)
    expect(checkValue({ type: 'regex', pattern: '(a+)+$', message: 'm' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!', 'x')).toBeNull() // never evaluated
  })

  it('is stored in /AA of the saved field and read back; removing the rule removes the entries', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    await createField(doc, { kind: 'text', name: 'amount', pageIndex: 0, rect: rect(50, 600, 100, 20), format: { type: 'number', decimals: 2, sep: 0, neg: 0, currency: '', prepend: true, min: 0, max: 10 } })
    const back = await reload(doc)
    const f = back.getForm().getTextField('amount')
    const aa = f.acroField.dict.lookup(N('AA'), PDFDict)
    expect(aa.keys().map((k) => k.decodeText()).sort()).toEqual(['F', 'K', 'V'])
    const act = aa.lookup(N('F'), PDFDict)
    expect(act.lookup(N('S')).toString()).toBe('/JavaScript')
    expect(readScripts(f).format).toBe('AFNumber_Format(2, 0, 0, 0, "", true);')
    expect(readBuilderModel(back).fields[0].format).toMatchObject({ type: 'number', decimals: 2, min: 0, max: 10 })
    await applyPatch(back, 'amount', { format: { type: 'none' } })
    expect(back.getForm().getTextField('amount').acroField.dict.has(N('AA'))).toBe(false)
  })

  it('makes the forms overlay check values against the rule (the validate hook)', async () => {
    const { registerValueCheck } = await import('../../src/renderer/src/features/forms/values')
    registerValueCheck((field, value) => checkValue(parseScripts({ format: field.scripts?.format, validate: field.scripts?.validate }), value, field.label))
    const doc = await PDFDocument.create()
    doc.addPage()
    await createField(doc, { kind: 'text', name: 'when', pageIndex: 0, rect: rect(50, 600, 100, 20), tooltip: 'Start date', format: { type: 'date', format: 'dd/mm/yyyy' } })
    const model = extractFormModel(await reload(doc)).fields[0]
    expect(model.scripts?.format).toContain('AFDate_FormatEx')
    expect(validateValue(model, '31/12/2024')).toEqual({ ok: true, value: '31/12/2024' })
    const bad = validateValue(model, 'tomorrow')
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/Start date.*dd\/mm\/yyyy/)
    // A field without a rule is untouched.
    await createField(doc, { kind: 'text', name: 'plain', pageIndex: 0, rect: rect(50, 500, 100, 20) })
    const plain = extractFormModel(await reload(doc)).fields.find((f) => f.name === 'plain')!
    expect(validateValue(plain, 'anything')).toEqual({ ok: true, value: 'anything' })
  })
})

describe('tab order', () => {
  async function form(): Promise<PDFDocument> {
    const doc = await PDFDocument.load((await createFieldsForm()).bytes)
    return doc
  }
  const order = (doc: PDFDocument): string[] => readTabInfo(doc)[0].entries.map((e) => e.name)

  it('reads /Annots order and /Tabs', async () => {
    const doc = await form()
    expect(order(doc)).toEqual(['first', 'second', 'third', 'agree'])
    expect(readTabInfo(doc)[0].mode).toBeNull()
  })

  it('every permutation of the keys lands in /Annots exactly, and sets /Tabs /S', async () => {
    const keys = ['first#0', 'second#0', 'third#0', 'agree#0']
    const perms = (a: string[]): string[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])))
    for (const p of perms(keys)) {
      const doc = await reload(await form())
      setTabOrder(doc, 0, p)
      const back = await reload(doc)
      expect(readTabInfo(back)[0].entries.map((e) => e.key)).toEqual(p)
      expect(readTabInfo(back)[0].mode).toBe('S')
      expect(back.getPage(0).node.Annots()!.size()).toBe(4) // nothing lost or duplicated
    }
  })

  it('keeps other annotations in their slots and appends unlisted widgets in their old order', async () => {
    const doc = await form()
    const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Border: [0, 0, 0] }))
    doc.getPage(0).node.Annots()!.insert(1, link) // first, LINK, second, third, agree
    setTabOrder(doc, 0, ['third#0', 'first#0'])
    const annots = doc.getPage(0).node.Annots()!
    expect(annots.get(1)).toBe(link)
    expect(readTabInfo(doc)[0].entries.map((e) => e.name)).toEqual(['third', 'first', 'second', 'agree'])
    expect(() => setTabOrder(doc, 0, ['nope#0'])).toThrow(/not on this page/)
  })

  it('row / column presets order by what the reader sees, also on rotated pages', async () => {
    for (const rot of [0, 90, 180, 270]) {
      const doc = await PDFDocument.create()
      const page = doc.addPage([600, 800])
      if (rot) page.setRotation(degrees(rot))
      // Two rows of two fields in the page as displayed; created via a frame so they are visually aligned.
      const { PageFrame } = await import('../../src/renderer/src/features/formbuilder/logic/frame')
      const f = new PageFrame([0, 0, 600, 800], rot as 0)
      const vis = [
        ['a', 50, 700],
        ['b', 300, 700],
        ['c', 50, 600],
        ['d', 300, 600]
      ] as const
      for (const [name, vx, vy] of [...vis].reverse()) {
        const u = f.boxToUser({ x0: vx, y0: vy, x1: vx + 100, y1: vy + 20 })
        await createField(doc, { kind: 'text', name, pageIndex: 0, rect: { x1: u.x0, y1: u.y0, x2: u.x1, y2: u.y1 } })
      }
      applyTabPreset(doc, 0, 'row')
      expect(readTabInfo(doc)[0].entries.map((e) => e.name), `row, rotate ${rot}`).toEqual(['a', 'b', 'c', 'd'])
      expect(readTabInfo(doc)[0].mode).toBe('R')
      applyTabPreset(doc, 0, 'column')
      expect(readTabInfo(doc)[0].entries.map((e) => e.name), `column, rotate ${rot}`).toEqual(['a', 'c', 'b', 'd'])
      expect(readTabInfo(doc)[0].mode).toBe('C')
    }
  })

  it("the forms feature's own Tab sequence follows /Tabs /S (annots order), /Tabs /C and the default row order", async () => {
    const doc = await form()
    const seq = async (d: PDFDocument): Promise<string[]> => tabStops(extractFormModel(await reload(d))).map((s) => s.field)
    expect(await seq(doc)).toEqual(['first', 'second', 'third', 'agree']) // row order by position (no /Tabs)
    setTabOrder(doc, 0, ['third#0', 'agree#0', 'first#0', 'second#0'])
    expect(await seq(doc)).toEqual(['third', 'agree', 'first', 'second'])
    const model = extractFormModel(await reload(doc))
    expect(model.pageTabs).toEqual({ 0: 'S' })
    // Tab / Shift+Tab walk exactly that list.
    const stops = tabStops(model)
    expect(stepStop(stops, model, stops[0].key, 1)?.field).toBe('agree')
    expect(stepStop(stops, model, stops[3].key, -1)?.field).toBe('first')
    setPageTabs(doc, 0, 'R')
    expect(await seq(doc)).toEqual(['first', 'second', 'third', 'agree']) // R: back to reading order
    setPageTabs(doc, 0, null)
    expect(readTabInfo(doc)[0].mode).toBeNull()
  })

  it('visualOrder is stable for ties', () => {
    const e = (key: string, x: number, y: number) => ({ key, name: key, index: 0, kind: 'text' as const, label: key, rect: rect(x, y, 50, 20) })
    expect(visualOrder([e('b', 200, 500), e('a', 50, 501)], 0, 'row')).toEqual(['a', 'b'])
  })
})

describe('align / distribute / same size (in the reader\'s view)', () => {
  const it3 = (rot = 0) => [
    { id: 'a', rect: rect(10, 10, 20, 10), rotation: rot },
    { id: 'b', rect: rect(50, 30, 40, 10), rotation: rot },
    { id: 'c', rect: rect(120, 60, 10, 30), rotation: rot }
  ]
  it('aligns to edges and centres of the selection', () => {
    expect(align(it3(), 'left').get('b')).toEqual(rect(10, 30, 40, 10))
    expect(align(it3(), 'right').get('a')).toEqual(rect(110, 10, 20, 10))
    expect(align(it3(), 'top').get('a')).toEqual(rect(10, 80, 20, 10))
    expect(align(it3(), 'bottom').get('c')).toEqual(rect(120, 10, 10, 30))
    expect(align(it3(), 'hcenter').get('a')).toEqual(rect(60, 10, 20, 10))
    expect(align(it3(), 'vcenter').get('b')).toEqual(rect(50, 45, 40, 10))
    expect(align(it3().slice(0, 1), 'left').size).toBe(0) // nothing to align to
  })
  it('distributes with equal gaps and keeps the outer two in place', () => {
    const d = distribute(it3(), 'horizontal')
    expect(d.get('a')).toEqual(rect(10, 10, 20, 10))
    expect(d.get('c')).toEqual(rect(120, 60, 10, 30))
    const gapAB = d.get('b')!.x1 - d.get('a')!.x2
    const gapBC = d.get('c')!.x1 - d.get('b')!.x2
    expect(gapAB).toBeCloseTo(gapBC, 9)
    expect(distribute(it3().slice(0, 2), 'vertical').size).toBe(0)
  })
  it('same size copies the first item; nudge and resize are visual', () => {
    expect(sameSize(it3(), 'width').get('c')).toEqual(rect(120, 60, 20, 30))
    expect(sameSize(it3(), 'height').get('b')).toEqual(rect(50, 30, 40, 10))
    expect(sameSize(it3(), 'both').get('c')).toEqual(rect(120, 80, 20, 10)) // keeps its top edge
    expect(nudge(it3(), 1, -2).get('a')).toEqual(rect(11, 8, 20, 10))
    expect(resizeBy(it3(), 5, -5).get('a')).toEqual(rect(10, 5, 25, 15))
  })
  it('on rotated pages "left" is the reader\'s left, not user-space x', () => {
    // Rotate 90: the reader's left is user-space bottom (smaller y).
    const items = [
      { id: 'a', rect: rect(100, 40, 10, 20), rotation: 90 },
      { id: 'b', rect: rect(200, 10, 10, 20), rotation: 90 }
    ]
    const out = align(items, 'left')
    expect(out.get('a')!.y1).toBe(10)
    expect(out.get('a')!.x1).toBe(100) // only moved along the reader's horizontal = user y
  })
})

describe('list of fields as CSV', () => {
  it('has a header, one row per field, and quotes commas, quotes and newlines', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.addPage()
    await createField(doc, { kind: 'text', name: 'city', pageIndex: 0, rect: rect(50, 600, 100, 20), tooltip: 'City, "town"', required: true, maxLength: 30 })
    await createField(doc, { kind: 'radio', name: 'size', pageIndex: 1, rect: rect(0, 0, 10, 10), buttons: [{ rect: rect(50, 500, 12, 12), value: 'S' }, { rect: rect(90, 500, 12, 12), value: 'L' }] })
    await createField(doc, { kind: 'text', name: 'zip', pageIndex: 0, rect: rect(50, 500, 100, 20), format: { type: 'special', special: 'zip' } })
    const csv = fieldsToCsv(readBuilderModel(await reload(doc)).fields)
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('Name,Type,Page,Required,Read-only,Tooltip,Options,Default value,Max length,Format')
    expect(lines).toContain('city,Text field,1,Yes,No,"City, ""town""",,,30,')
    expect(lines).toContain('size,Radio group,2,No,No,,S; L,,,')
    expect(lines).toContain('zip,Text field,1,No,No,,,,,ZIP code')
    expect(lines).toHaveLength(4)
  })
})

describe('detect -> review -> apply on the mixed flat form', () => {
  it('creates the accepted fields as real AcroForm fields at the detected places', async () => {
    const fx = await createMixed()
    const pdf = await PDFDocument.load(fx.bytes)
    const results = await detectDocument(pdf)
    const proposals = results.flatMap((r) => r.proposals).filter((p) => p.confidence >= 0.5)
    expect(proposals).toHaveLength(9)
    const report = await applyProposals(pdf, proposals)
    expect(report.skipped).toEqual([])
    expect(report.created.sort()).toEqual(proposals.map((p) => p.name).sort())

    const back = await reload(pdf)
    const model = extractFormModel(back)
    const byName = Object.fromEntries(model.fields.map((f) => [f.name, f]))
    expect(byName.Full_name.kind).toBe('text')
    expect(byName.Full_name.label).toBe('Full name') // the printed label became the tooltip
    expect(byName.Date_of_birth.scripts?.format).toContain('AFDate_FormatEx("dd/mm/yyyy")')
    expect(byName.Comments.multiline).toBe(true)
    expect(byName.I_agree_to_the_terms.kind).toBe('checkbox')
    expect(byName.Level.kind).toBe('radio')
    expect(byName.Level.widgets.map((w) => w.onValue)).toEqual(['Basic', 'Plus', 'Pro'])
    expect(byName.Signature.kind).toBe('signature')
    // The widget sits where the detection said (page is unrotated: visual = user space).
    const spec = proposalToSpec(pdf, proposals.find((p) => p.name === 'Full_name')!)
    const w = byName.Full_name.widgets[0].rect
    expect(w.x1).toBeCloseTo(spec.rect.x1, 3)
    expect(w.y2).toBeCloseTo(spec.rect.y2, 3)
    // Transparent overlay style: no border or background of its own over the printed rule.
    const look = readBuilderModel(back).fields.find((f) => f.name === 'Full_name')!.style
    expect(look.borderColor).toBeNull()
    expect(look.backgroundColor).toBeNull()
  })

  it('on a rotated page the widgets land in user space (rect rotated back) and carry /MK /R', async () => {
    const fx = await createMixed(90)
    const pdf = await PDFDocument.load(fx.bytes)
    const proposals = (await detectDocument(pdf)).flatMap((r) => r.proposals).filter((p) => p.confidence >= 0.5)
    expect(proposals).toHaveLength(9)
    await applyProposals(pdf, proposals)
    const back = await reload(pdf)
    const m = extractFormModel(back)
    expect(m.fields).toHaveLength(9)
    expect(m.fields.every((f) => f.widgets.every((w) => w.pageRotation === 90))).toBe(true)
    // Reading order in the rotated view: Full name is the top-most field, the signature the bottom-most.
    const stops = tabStops(m).map((s) => s.field)
    expect(stops[0]).toBe('Full_name')
    expect(stops.filter((s) => s !== 'Signature')).toContain('Level')
    const info = readTabInfo(back)[0]
    expect(info.entries.length).toBeGreaterThan(9 - 1)
  })

  it('names never collide with fields that already exist', async () => {
    const pdf = await PDFDocument.load(await (await createMixed()).bytes)
    await createField(pdf, { kind: 'text', name: 'Full_name', pageIndex: 0, rect: rect(10, 10, 50, 20) })
    const results = await detectDocument(pdf)
    const names = results.flatMap((r) => r.proposals).map((p) => p.name)
    expect(names).toContain('Full_name_2')
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
    const proposals = results.flatMap((r) => r.proposals).filter((p) => p.confidence >= 0.5)
    const report = await applyProposals(pdf, proposals)
    expect(report.skipped).toEqual([])
  })

  it('reports fields that cannot be created instead of failing the batch', async () => {
    const pdf = await PDFDocument.load((await createMixed()).bytes)
    const proposals = (await detectDocument(pdf)).flatMap((r) => r.proposals).filter((p) => p.confidence >= 0.5)
    const broken = { ...proposals[0], pageIndex: 7 }
    const report = await applyProposals(pdf, [broken, ...proposals.slice(1)])
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0].reason).toMatch(/page/)
    expect(report.created).toHaveLength(proposals.length - 1)
  })
})

describe('sanity of helper types', () => {
  it('PDFRef is exported for annots handling', () => {
    expect(PDFRef).toBeDefined()
  })
})
