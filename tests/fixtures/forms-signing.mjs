// Fixtures for the forms + signing features: node tests/fixtures/forms-signing.mjs <outDir>
//   forms.pdf          2 pages, every field type (text, multiline, MaxLen 5, password, read-only, checkbox,
//                      radio group, dropdown, option list, push button, signature field), fields have /TU tooltips
//   forms-rotated.pdf  1 page with /Rotate 90 and a text field + checkbox at known places
//   flat.pdf           2 pages of plain text, no fields (for Add text / stamps / signatures)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, PDFHexString, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib'

const tip = (field, text) => field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(text))
const style = { borderWidth: 1, borderColor: rgb(0.2, 0.2, 0.2) }

export async function createFormsPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([612, 792])
  const p2 = doc.addPage([612, 792])
  p1.drawText('Registration form', { x: 72, y: 740, size: 20, font })
  p2.drawText('Page two of the form', { x: 72, y: 740, size: 20, font })
  const form = doc.getForm()

  const name = form.createTextField('full_name')
  tip(name, 'Full name')
  name.addToPage(p1, { x: 72, y: 690, width: 260, height: 22, font, ...style })

  const notes = form.createTextField('notes')
  notes.enableMultiline()
  tip(notes, 'Notes')
  notes.addToPage(p1, { x: 72, y: 590, width: 300, height: 80, font, ...style })

  const code = form.createTextField('code')
  code.setMaxLength(5)
  tip(code, 'Code (max 5 characters)')
  code.addToPage(p1, { x: 72, y: 550, width: 100, height: 22, font, ...style })

  const pin = form.createTextField('pin')
  pin.enablePassword()
  tip(pin, 'PIN')
  pin.addToPage(p1, { x: 200, y: 550, width: 100, height: 22, font, ...style })

  const ro = form.createTextField('readonly_id')
  ro.setText('ID-0001')
  ro.enableReadOnly()
  tip(ro, 'Customer id (read only)')
  ro.addToPage(p1, { x: 340, y: 550, width: 120, height: 22, font, ...style })

  const agree = form.createCheckBox('agree')
  tip(agree, 'I agree to the terms')
  agree.addToPage(p1, { x: 72, y: 510, width: 18, height: 18, ...style })

  const color = form.createRadioGroup('color')
  color.addOptionToPage('red', p1, { x: 72, y: 470, width: 16, height: 16, ...style })
  color.addOptionToPage('green', p1, { x: 132, y: 470, width: 16, height: 16, ...style })
  color.addOptionToPage('blue', p1, { x: 192, y: 470, width: 16, height: 16, ...style })

  const country = form.createDropdown('country')
  country.addOptions(['France', 'Germany', 'Spain'])
  tip(country, 'Country')
  country.addToPage(p1, { x: 72, y: 420, width: 180, height: 22, font, ...style })

  const langs = form.createOptionList('langs')
  langs.addOptions(['English', 'French', 'German'])
  langs.enableMultiselect()
  tip(langs, 'Languages')
  langs.addToPage(p1, { x: 300, y: 380, width: 140, height: 62, font, ...style })

  const button = form.createButton('submit')
  button.addToPage('Submit', p1, { x: 72, y: 340, width: 90, height: 24, font, ...style })

  // A signature field (pdf-lib cannot create one, so the objects are written by hand).
  const sigRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFHexString.fromText('sig_field'),
      Rect: [72, 280, 260, 320],
      F: 4,
      P: p1.ref
    })
  )
  form.acroForm.addField(sigRef)
  p1.node.addAnnot(sigRef)

  const p2field = form.createTextField('page2_field')
  tip(p2field, 'Page two field')
  p2field.addToPage(p2, { x: 72, y: 690, width: 240, height: 22, font, ...style })

  return doc.save()
}

/** Page rotated 90 degrees clockwise (792 x 612 on screen); fields sit at known user-space places. */
export async function createRotatedFormPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.setRotation(degrees(90))
  page.drawText('Rotated page', { x: 72, y: 700, size: 20, font, rotate: degrees(0) })
  const form = doc.getForm()
  const t = form.createTextField('rot_text')
  t.addToPage(page, { x: 72, y: 600, width: 200, height: 24, font, ...style })
  const c = form.createCheckBox('rot_check')
  c.addToPage(page, { x: 72, y: 500, width: 20, height: 20, ...style })
  return doc.save()
}

export async function createFlatPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Flat document page ${i}`, { x: 72, y: 700, size: 24, font })
    p.drawText('There are no form fields here.', { x: 72, y: 660, size: 14, font })
  }
  return doc.save()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'forms.pdf'), await createFormsPdf())
  writeFileSync(join(out, 'forms-rotated.pdf'), await createRotatedFormPdf())
  writeFileSync(join(out, 'flat.pdf'), await createFlatPdf())
  console.log('forms/signing fixtures written to', out)
}
