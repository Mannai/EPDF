// Fixtures for the page organizer and printing tests: node tests/fixtures/pages-print.mjs <outDir>
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from 'pdf-lib'

const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
mkdirSync(out, { recursive: true })

async function textDoc(n, prefix, sizes = []) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) {
    const [w, h] = sizes[i - 1] ?? [612, 792]
    const p = doc.addPage([w, h])
    p.drawText(`${prefix} ${i}`, { x: 60, y: h - 100, size: 32, font, color: rgb(0, 0, 0) })
    p.drawRectangle({ x: 60, y: 60, width: w - 120, height: 40, borderColor: rgb(0, 0, 0), borderWidth: 2 })
  }
  return doc
}

const N = (s) => PDFName.of(s)

/** A 6-page document with a nested outline, a named destination, a bad title and a page-less heading. */
async function outline() {
  const doc = await textDoc(6, 'Outline page')
  const ctx = doc.context
  const rootRef = ctx.nextRef()
  const root = ctx.obj({ Type: 'Outlines' })
  ctx.assign(rootRef, root)
  const dests = ctx.obj({})
  dests.set(N('chapter3'), ctx.obj([doc.getPage(3).ref, 'Fit']))
  doc.catalog.set(N('Dests'), dests)
  const items = [
    { title: 'Chapter 1: Intro', page: 0, children: [{ title: 'Section 1.1', page: 1 }] },
    { title: '../../evil', page: 2 },
    { title: 'CON', named: 'chapter3' },
    { title: 'Broken', named: 'does-not-exist' },
    { title: 'Epilogue', page: 5 }
  ]
  const build = (list, parent) => {
    const refs = list.map(() => ctx.nextRef())
    list.forEach((it, i) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent })
      if (i > 0) d.set(N('Prev'), refs[i - 1])
      if (i < list.length - 1) d.set(N('Next'), refs[i + 1])
      if (it.named) d.set(N('Dest'), N(it.named))
      else if (it.page !== undefined) d.set(N('Dest'), ctx.obj([doc.getPage(it.page).ref, 'Fit']))
      if (it.children) {
        const [f, l] = build(it.children, refs[i])
        d.set(N('First'), f)
        d.set(N('Last'), l)
        d.set(N('Count'), ctx.obj(it.children.length))
      }
      ctx.assign(refs[i], d)
    })
    return [refs[0], refs[refs.length - 1]]
  }
  const [f, l] = build(items, rootRef)
  root.set(N('First'), f)
  root.set(N('Last'), l)
  root.set(N('Count'), ctx.obj(6))
  doc.catalog.set(N('Outlines'), rootRef)
  writeFileSync(join(out, 'outline.pdf'), await doc.save())
}

/** Pages with a highlight and a comment on page 1: for print annotation on/off tests. Page 3 is landscape. */
async function annotated() {
  const doc = await textDoc(3, 'Print page', [[612, 792], [612, 792], [792, 612]])
  const ctx = doc.context
  const ap = (r, g, b, w, h) =>
    ctx.register(ctx.stream(`${r} ${g} ${b} rg 0 0 ${w} ${h} re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }))
  const highlight = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [60, 640, 360, 690],
      QuadPoints: [60, 690, 360, 690, 60, 640, 360, 640],
      C: [1, 1, 0],
      F: 4,
      Contents: 'A highlight',
      AP: { N: ap(1, 1, 0, 300, 50) }
    })
  )
  const note = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [400, 700, 430, 730],
      Name: 'Comment',
      Contents: 'A comment',
      F: 4,
      AP: { N: ap(1, 0, 0, 30, 30) }
    })
  )
  doc.getPage(0).node.set(N('Annots'), ctx.obj([highlight, note]))
  writeFileSync(join(out, 'annotated.pdf'), await doc.save())
}

async function other() {
  writeFileSync(join(out, 'other.pdf'), await (await textDoc(3, 'Other page')).save())
}

/** Looks encrypted to pdf-lib (an /Encrypt entry in the trailer), so inserting from it must fail politely. */
async function encrypted() {
  const doc = await textDoc(2, 'Secret page')
  const enc = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 }))
  doc.context.trailerInfo.Encrypt = enc
  writeFileSync(join(out, 'encrypted.pdf'), await doc.save({ useObjectStreams: false }))
}

/** 6 pages of ~120 KB each (incompressible padding) plus a 700 KB page 4, for the split-by-size tests. */
async function heavy() {
  const doc = await textDoc(6, 'Heavy page')
  const sizes = [120, 120, 120, 700, 120, 120]
  doc.getPages().forEach((p, i) => {
    const pad = doc.context.register(doc.context.stream(randomBytes(sizes[i] * 1024)))
    p.node.set(N('EpdfPad'), pad)
  })
  writeFileSync(join(out, 'heavy.pdf'), await doc.save())
}

await outline()
await annotated()
await other()
await encrypted()
await heavy()
console.log('pages-print fixtures written to', out)
