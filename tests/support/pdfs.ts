import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts, rgb } from 'pdf-lib'

/** PDF fixtures built with pdf-lib, for tests. */

export interface FixtureOutline {
  title: string
  page: number
  children?: FixtureOutline[]
}

export interface FixturePdfOptions {
  /** Page sizes; one entry per page. */
  sizes?: [number, number][]
  pages?: number
  label?: string
  outline?: FixtureOutline[]
  /** Text fields to create on page 1 (top-level names). */
  fields?: string[]
  /** `[fromPage, toPage]` (1-based) internal links, added as /Dest link annotations on `fromPage`. */
  links?: [number, number][]
  rotate?: Record<number, number>
}

export async function makePdf(o: FixturePdfOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const sizes = o.sizes ?? Array.from({ length: o.pages ?? 1 }, (): [number, number] => [612, 792])
  const label = o.label ?? 'Doc'
  const pages = sizes.map(([w, h], i) => {
    const p = doc.addPage([w, h])
    p.drawText(`${label} page ${i + 1}`, { x: 40, y: h - 60, size: 20, font, color: rgb(0, 0, 0) })
    if (o.rotate?.[i + 1]) p.setRotation({ type: 'degrees' as never, angle: o.rotate[i + 1] } as never)
    return p
  })
  if (o.fields?.length) {
    const form = doc.getForm()
    o.fields.forEach((name, i) => {
      const f = form.createTextField(name)
      f.setText(`${label}:${name}`)
      f.addToPage(pages[0], { x: 40, y: 500 - i * 40, width: 200, height: 24 })
    })
  }
  if (o.links) {
    for (const [from, to] of o.links) {
      const link = doc.context.register(
        doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 300, 200, 320], Border: [0, 0, 0], Dest: [pages[to - 1].ref, PDFName.of('Fit')] })
      )
      const existing = pages[from - 1].node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      if (existing) existing.push(link)
      else pages[from - 1].node.set(PDFName.of('Annots'), doc.context.obj([link]))
    }
  }
  if (o.outline) {
    const ctx = doc.context
    const rootRef = ctx.nextRef()
    const build = (items: FixtureOutline[], parent: PDFRef): PDFRef[] => {
      const refs = items.map(() => ctx.nextRef())
      items.forEach((it, i) => {
        const d = ctx.obj({}) as PDFDict
        d.set(PDFName.of('Title'), PDFHexString.fromText(it.title))
        d.set(PDFName.of('Parent'), parent)
        if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1])
        if (i < items.length - 1) d.set(PDFName.of('Next'), refs[i + 1])
        d.set(PDFName.of('Dest'), ctx.obj([pages[it.page - 1].ref, PDFName.of('XYZ'), 0, 700, 0]))
        if (it.children?.length) {
          const kids = build(it.children, refs[i])
          d.set(PDFName.of('First'), kids[0])
          d.set(PDFName.of('Last'), kids[kids.length - 1])
          d.set(PDFName.of('Count'), PDFNumber.of(it.children.length))
        }
        ctx.assign(refs[i], d)
      })
      return refs
    }
    const tops = build(o.outline, rootRef)
    ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: tops[0], Last: tops[tops.length - 1], Count: o.outline.length }))
    doc.catalog.set(PDFName.of('Outlines'), rootRef)
  }
  return doc.save()
}

/** A structurally "encrypted" PDF (has an /Encrypt entry), enough for readers that refuse to open it. */
export async function makeEncryptedLookingPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  const enc = doc.context.register(
    doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFString.of('x'.repeat(32)), U: PDFString.of('y'.repeat(32)), P: -4 })
  )
  doc.context.trailerInfo.Encrypt = enc
  return doc.save()
}

export interface OutlineNode {
  title: string
  pageIndex: number | null
  children: OutlineNode[]
}

/** Reads the outline of a saved PDF, resolving destinations to 0-based page indexes. */
export function readOutline(doc: PDFDocument): OutlineNode[] {
  const pageIndex = new Map<string, number>()
  doc.getPages().forEach((p, i) => pageIndex.set(p.ref.tag, i))
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)
  if (!root) return []
  const walk = (first: unknown): OutlineNode[] => {
    const out: OutlineNode[] = []
    let cur = first ? doc.context.lookupMaybe(first as PDFRef, PDFDict) : undefined
    while (cur) {
      const t = cur.lookup(PDFName.of('Title')) as PDFHexString | PDFString
      const dest = cur.lookupMaybe(PDFName.of('Dest'), PDFArray)
      const ref = dest?.get(0)
      out.push({
        title: t.decodeText(),
        pageIndex: ref instanceof PDFRef ? (pageIndex.get(ref.tag) ?? null) : null,
        children: walk(cur.get(PDFName.of('First')))
      })
      const next = cur.get(PDFName.of('Next'))
      cur = next ? doc.context.lookupMaybe(next as PDFRef, PDFDict) : undefined
    }
    return out
  }
  return walk(root.get(PDFName.of('First')))
}
