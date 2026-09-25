import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractFormModel, parseDefaultAppearance, type FormModel } from '../../src/renderer/src/features/forms/model'
import { compareWidgets, stepStop, tabStops } from '../../src/renderer/src/features/forms/tabOrder'
import { createFlatPdf, createFormsPdf, createRotatedFormPdf } from '../fixtures/forms-signing.mjs'

let model: FormModel
const field = (name: string) => model.fields.find((f) => f.name === name)!

beforeAll(async () => {
  model = extractFormModel(await PDFDocument.load(await createFormsPdf()))
})

describe('extractFormModel', () => {
  it('finds every field type with its widgets and page', () => {
    expect(model.error).toBeUndefined()
    expect(Object.fromEntries(model.fields.map((f) => [f.name, f.kind]))).toEqual({
      full_name: 'text',
      notes: 'text',
      code: 'text',
      pin: 'text',
      readonly_id: 'text',
      agree: 'checkbox',
      color: 'radio',
      country: 'dropdown',
      langs: 'list',
      submit: 'button',
      sig_field: 'signature',
      page2_field: 'text'
    })
    expect(field('full_name').widgets[0].pageIndex).toBe(0)
    expect(field('page2_field').widgets[0].pageIndex).toBe(1)
    expect(field('color').widgets).toHaveLength(3)
    expect(field('color').widgets.map((w) => w.onValue)).toEqual(['red', 'green', 'blue'])
  })

  it('reads text-field flags, MaxLen and read-only state', () => {
    expect(field('notes').multiline).toBe(true)
    expect(field('full_name').multiline).toBe(false)
    expect(field('code').maxLength).toBe(5)
    expect(field('pin').password).toBe(true)
    expect(field('readonly_id').readOnly).toBe(true)
    expect(field('readonly_id').value).toBe('ID-0001')
    expect(field('full_name').readOnly).toBe(false)
  })

  it('uses the tooltip as the accessible label, falling back to the name', () => {
    expect(field('full_name').label).toBe('Full name')
    expect(field('agree').label).toBe('I agree to the terms')
    expect(field('color').label).toBe('color')
  })

  it('reads choices', () => {
    expect(field('country').options).toEqual(['France', 'Germany', 'Spain'])
    expect(field('langs').multiSelect).toBe(true)
    expect(field('langs').options).toHaveLength(3)
  })

  it('reports widget geometry in user space, normalised', () => {
    const w = field('full_name').widgets[0]
    // pdf-lib grows the rectangle by half the border width on each side.
    expect(w.rect).toEqual({ x1: 71.5, y1: 689.5, x2: 332.5, y2: 712.5 })
    expect(w.borderWidth).toBe(1)
    expect(w.rect.x1).toBeLessThan(w.rect.x2)
  })

  it('reports the page rotation of each widget', async () => {
    const m = extractFormModel(await PDFDocument.load(await createRotatedFormPdf()))
    expect(m.fields.map((f) => f.widgets[0].pageRotation)).toEqual([90, 90])
  })

  it('returns no fields for a flat PDF and never throws', async () => {
    const m = extractFormModel(await PDFDocument.load(await createFlatPdf()))
    expect(m.fields).toEqual([])
    expect(m.error).toBeUndefined()
  })
})

describe('parseDefaultAppearance', () => {
  it('reads size and color from /DA strings', () => {
    expect(parseDefaultAppearance('/Helv 12 Tf 0 0 1 rg')).toEqual({ fontSize: 12, color: 'rgb(0 0 255)' })
    expect(parseDefaultAppearance('0.5 g /Helv 0 Tf')).toEqual({ fontSize: 0, color: 'rgb(128 128 128)' })
    expect(parseDefaultAppearance('/Helv 9.5 Tf')).toEqual({ fontSize: 9.5, color: undefined })
    expect(parseDefaultAppearance(undefined)).toEqual({})
  })
})

describe('tab order', () => {
  it('goes page by page, top to bottom, skipping read-only fields and buttons, one stop per radio group', () => {
    const stops = tabStops(model)
    expect(stops.map((s) => s.field)).toEqual(['full_name', 'notes', 'code', 'pin', 'agree', 'color', 'country', 'langs', 'page2_field'])
  })

  it('steps forward and backward across pages and ends at both ends', () => {
    const stops = tabStops(model)
    const first = stops[0]
    const last = stops[stops.length - 1]
    expect(stepStop(stops, model, first.key, -1)).toBeNull()
    expect(stepStop(stops, model, last.key, 1)).toBeNull()
    expect(stepStop(stops, model, stops[7].key, 1)?.field).toBe('page2_field')
    expect(stepStop(stops, model, last.key, -1)?.field).toBe('langs')
  })

  it('treats any button of a radio group as that group when stepping', () => {
    const stops = tabStops(model)
    const green = field('color').widgets[1].key
    expect(stepStop(stops, model, green, 1)?.field).toBe('country')
    expect(stepStop(stops, model, green, -1)?.field).toBe('agree')
  })

  it('orders widgets in reading order as displayed on rotated pages', () => {
    const w = (x1: number, y1: number, x2: number, y2: number, rot: number) =>
      ({ key: '', pageIndex: 0, pageRotation: rot, rect: { x1, y1, x2, y2 }, align: 'left', borderWidth: 0 }) as never
    // Page rotated 90 clockwise: user +x runs down the screen, user +y runs to the right.
    const up = w(100, 100, 150, 120, 90) // higher on screen (smaller x)
    const down = w(400, 100, 450, 120, 90)
    expect(compareWidgets(up, down)).toBeLessThan(0)
    const left = w(100, 100, 150, 120, 90)
    const right = w(100, 300, 150, 320, 90)
    expect(compareWidgets(left, right)).toBeLessThan(0)
    // Unrotated: higher y is higher on the page.
    expect(compareWidgets(w(0, 700, 10, 710, 0), w(0, 100, 10, 110, 0))).toBeLessThan(0)
  })
})
