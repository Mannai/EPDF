import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
  type PDFObject
} from 'pdf-lib'

const N = (s: string): PDFName => PDFName.of(s)

/** A document whose page i (1-based) shows the unique text "Page i"; `sizes` overrides page sizes. */
export async function makeDoc(n: number, opts: { sizes?: [number, number][]; prefix?: string } = {}): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) {
    const [w, h] = opts.sizes?.[i - 1] ?? [612, 792]
    const p = doc.addPage([w, h])
    p.drawText(`${opts.prefix ?? 'Page'} ${i}`, { x: 40, y: h - 80, size: 24, font, color: rgb(0, 0, 0) })
  }
  return doc
}

export const reload = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes)

/** pdf-lib writes standard-font text as hex strings (`<50616765> Tj`); show them as `(Page)` so tests can match text. */
const showHexStrings = (s: string): string =>
  s.replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_m, hex: string) => `(${Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1')}) Tj`)

const decodeStream = (s: PDFObject): string => {
  try {
    if (s instanceof PDFRawStream) return showHexStrings(Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
    if (s instanceof PDFStream) return showHexStrings(Buffer.from((s as unknown as { getContents(): Uint8Array }).getContents()).toString('latin1'))
  } catch {
    /* not decodable */
  }
  return ''
}

/** The text drawn on a page (concatenated content streams), for asserting page order. */
export function pageText(pdf: PDFDocument, index: number): string {
  const page = pdf.getPage(index)
  const contents = page.node.lookup(N('Contents'))
  const parts: (PDFObject | undefined)[] = contents instanceof PDFArray ? contents.asArray().map((r) => (r instanceof PDFRef ? pdf.context.lookup(r) : r)) : contents ? [contents] : []
  return parts.map((p) => (p ? decodeStream(p) : '')).join('\n')
}

/** "Page 3" markers in page order, e.g. ['Page 1','Page 3']. */
export function pageLabelsOf(pdf: PDFDocument, prefix = 'Page'): string[] {
  const re = new RegExp(`\\((${prefix} \\d+)\\)`)
  return pdf.getPages().map((_, i) => re.exec(pageText(pdf, i))?.[1] ?? '(blank)')
}

/** True if any object in the file (streams decoded) contains `needle`. Used to prove deleted content is gone. */
export function fileContains(pdf: PDFDocument, needle: string): boolean {
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (decodeStream(obj).includes(needle)) return true
  }
  return false
}

/** Adds a Link annotation on page `from` that jumps to page `to` (explicit destination array). */
export function addLink(doc: PDFDocument, from: number, to: number): PDFRef {
  const link = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], Border: [0, 0, 0], Dest: [doc.getPage(to).ref, 'Fit'] })
  )
  const page = doc.getPage(from)
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
  if (annots) annots.push(link)
  else page.node.set(N('Annots'), doc.context.obj([link]))
  return link
}

/** The destination page index of a Link annotation (or undefined when it has none). */
export function linkTarget(doc: PDFDocument, pageIndex: number, annotIndex = 0): number | undefined {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(N('Annots'), PDFArray)
  const a = annots?.lookup(annotIndex)
  if (!(a instanceof PDFDict)) return undefined
  const dest = a.lookupMaybe(N('Dest'), PDFArray)
  const ref = dest?.get(0)
  if (!(ref instanceof PDFRef)) return undefined
  const i = doc.getPages().findIndex((p) => p.ref.tag === ref.tag)
  return i < 0 ? undefined : i
}

export interface OutlineSpec {
  title: string
  page?: number
  /** Destination given as a name looked up in the /Dests dictionary instead of an explicit array. */
  named?: string
  children?: OutlineSpec[]
}

/** Builds a bookmark tree. `named` entries are also registered in the catalog's /Dests dictionary. */
export function addOutline(doc: PDFDocument, items: OutlineSpec[]): void {
  const ctx = doc.context
  const rootRef = ctx.nextRef()
  const root = ctx.obj({ Type: 'Outlines' }) as PDFDict
  ctx.assign(rootRef, root)
  const dests = ctx.obj({}) as PDFDict
  let hasNamed = false
  const build = (list: OutlineSpec[], parent: PDFRef): [PDFRef, PDFRef, number] => {
    const refs = list.map(() => ctx.nextRef())
    let count = list.length
    list.forEach((it, i) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent }) as PDFDict
      if (i > 0) d.set(N('Prev'), refs[i - 1])
      if (i < list.length - 1) d.set(N('Next'), refs[i + 1])
      if (it.named !== undefined) {
        hasNamed = true
        d.set(N('Dest'), N(it.named))
        if (it.page !== undefined) dests.set(N(it.named), ctx.obj([doc.getPage(it.page).ref, 'Fit']))
      } else if (it.page !== undefined) d.set(N('Dest'), ctx.obj([doc.getPage(it.page).ref, 'XYZ', null, 700, null]))
      if (it.children?.length) {
        const [f, l, c] = build(it.children, refs[i])
        d.set(N('First'), f)
        d.set(N('Last'), l)
        d.set(N('Count'), ctx.obj(c))
        count += c
      }
      ctx.assign(refs[i], d)
    })
    return [refs[0], refs[refs.length - 1], count]
  }
  const [f, l, c] = build(items, rootRef)
  root.set(N('First'), f)
  root.set(N('Last'), l)
  root.set(N('Count'), ctx.obj(c))
  doc.catalog.set(N('Outlines'), rootRef)
  if (hasNamed) doc.catalog.set(N('Dests'), dests)
}
