// Fixtures for the forms + signing features: node tests/fixtures/forms-signing.mjs <outDir>
//   forms.pdf          2 pages, every field type (text, multiline, MaxLen 5, password, read-only, checkbox,
//                      radio group, dropdown, option list, push button, signature field), fields have /TU tooltips
//   forms-rotated.pdf  1 page with /Rotate 90 and a text field + checkbox at known places
//   flat.pdf           2 pages of plain text, no fields (for Add text / stamps / signatures)
//   forms-encrypted.pdf  a form encrypted with RC4-40 and an empty user password (opens without a prompt)
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, PDFHexString, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib'

const tip = (field, text) => field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(text))
const style = { borderWidth: 1, borderColor: rgb(0.2, 0.2, 0.2) }

/** Sets the font size in a field's default appearance (0 = auto) and, for a fixed size, regenerates its look. */
function setSize(field, font, n) {
  const da = field.acroField.getDefaultAppearance() ?? ''
  field.acroField.setDefaultAppearance(da.replace(/(\d*\.\d+|\d+)\s+Tf/, `${n} Tf`))
  if (n > 0) field.updateAppearances(font)
}

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
  setSize(name, font, 12)

  const notes = form.createTextField('notes')
  notes.enableMultiline()
  tip(notes, 'Notes')
  notes.addToPage(p1, { x: 72, y: 590, width: 300, height: 80, font, ...style })
  setSize(notes, font, 10)

  const code = form.createTextField('code')
  code.setMaxLength(5)
  tip(code, 'Code (max 5 characters)')
  code.addToPage(p1, { x: 72, y: 550, width: 100, height: 22, font, ...style })
  setSize(code, font, 0)

  const pin = form.createTextField('pin')
  pin.enablePassword()
  tip(pin, 'PIN')
  pin.addToPage(p1, { x: 200, y: 550, width: 100, height: 22, font, ...style })
  setSize(pin, font, 11)

  const ro = form.createTextField('readonly_id')
  ro.setText('ID-0001')
  ro.enableReadOnly()
  tip(ro, 'Customer id (read only)')
  ro.addToPage(p1, { x: 340, y: 550, width: 120, height: 22, font, ...style })
  setSize(ro, font, 11)

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
  setSize(country, font, 11)

  const langs = form.createOptionList('langs')
  langs.addOptions(['English', 'French', 'German'])
  langs.enableMultiselect()
  tip(langs, 'Languages')
  langs.addToPage(p1, { x: 300, y: 380, width: 140, height: 62, font, ...style })
  setSize(langs, font, 11)

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
  setSize(p2field, font, 14)

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

// ---- an RC4-40 encrypted form (empty user password) written by hand: no PDF tool needed ----------------
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest()
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  let a = 0
  let b = 0
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255
    b = (b + s[a]) & 255
    ;[s[a], s[b]] = [s[b], s[a]]
    out[n] = data[n] ^ s[(s[a] + s[b]) & 255]
  }
  return out
}

export function createEncryptedFormPdf() {
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const P = -4
  const pBytes = Buffer.alloc(4)
  pBytes.writeInt32LE(P)
  const O = rc4(md5(PAD).subarray(0, 5), PAD)
  const key = md5(PAD, O, pBytes, id).subarray(0, 5)
  const U = rc4(key, PAD)
  const objKey = (n) => {
    const k = Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])
    return md5(key, k).subarray(0, 10)
  }
  const hex = (b) => `<${Buffer.from(b).toString('hex')}>`
  const str = (n, s) => hex(rc4(objKey(n), Buffer.from(s, 'latin1')))
  const content = 'BT /F1 20 Tf 72 700 Td (Encrypted form) Tj ET'
  const enc = rc4(objKey(6), Buffer.from(content, 'latin1'))
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA ' + str(1, '/Helv 12 Tf 0 g') + ' >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 6 0 R /Annots [4 0 R] >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T ' + str(4, 'locked_field') + ' /Rect [72 600 272 624] /F 4 /P 3 0 R /DA ' + str(4, '/Helv 12 Tf 0 g') + ' >>',
    '<< /Producer ' + str(5, 'fixture') + ' >>'
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets = []
  const add = (n, body) => {
    offsets[n] = parts.reduce((s, p) => s + p.length, 0)
    parts.push(Buffer.from(`${n} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n'))
  }
  add(1, objs[0])
  add(2, objs[1])
  add(3, objs[2])
  add(4, objs[3])
  add(5, objs[4])
  add(6, Buffer.concat([Buffer.from(`<< /Length ${enc.length} >>\nstream\n`), enc, Buffer.from('\nendstream')]))
  add(7, `<< /Filter /Standard /V 1 /R 2 /O ${hex(O)} /U ${hex(U)} /P ${P} >>`)
  const xref = parts.reduce((s, p) => s + p.length, 0)
  let table = 'xref\n0 8\n0000000000 65535 f \n'
  for (let n = 1; n <= 7; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  parts.push(Buffer.from(table + `trailer\n<< /Size 8 /Root 1 0 R /Info 5 0 R /Encrypt 7 0 R /ID [${hex(id)} ${hex(id)}] >>\nstartxref\n${xref}\n%%EOF\n`))
  return new Uint8Array(Buffer.concat(parts))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'forms.pdf'), await createFormsPdf())
  writeFileSync(join(out, 'forms-rotated.pdf'), await createRotatedFormPdf())
  writeFileSync(join(out, 'flat.pdf'), await createFlatPdf())
  writeFileSync(join(out, 'forms-encrypted.pdf'), createEncryptedFormPdf())
  console.log('forms/signing fixtures written to', out)
}
