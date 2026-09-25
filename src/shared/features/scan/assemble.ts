import { PDFDocument, PDFRawStream, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib'
import { zlibSync } from 'fflate'
import { applyPngUp, packBilevel } from './enhance'
import type { RgbaImage } from './image'

/**
 * Builds the result PDF page by page from already-encoded page images, so a 200-page scan never holds more than
 * the compressed data in memory. Page size in points is supplied by the pipeline (pixels / dpi * 72).
 */

export type EncodedPage =
  | {
      kind: 'jpeg'
      /** A complete baseline/progressive JPEG file. */
      bytes: Uint8Array
      pageWidthPt: number
      pageHeightPt: number
    }
  | {
      kind: 'bilevel'
      /** zlib stream of PNG-Up filtered 1-bit rows (see `encodeBilevel`). */
      data: Uint8Array
      widthPx: number
      heightPx: number
      pageWidthPt: number
      pageHeightPt: number
    }
  | {
      kind: 'gray8' | 'rgb8'
      /** zlib stream of raw 8-bit samples (lossless option). */
      data: Uint8Array
      widthPx: number
      heightPx: number
      pageWidthPt: number
      pageHeightPt: number
    }

/** 1-bit black/white page -> Flate data for a `/DeviceGray /BitsPerComponent 1` image with a PNG predictor. */
export function encodeBilevel(img: RgbaImage): Extract<EncodedPage, { kind: 'bilevel' }>['data'] {
  const { packed, rowBytes } = packBilevel(img)
  return zlibSync(applyPngUp(packed, rowBytes, img.height), { level: 9 })
}

export function encodeRaw(img: RgbaImage, gray: boolean): Uint8Array {
  const n = img.width * img.height
  const raw = new Uint8Array(n * (gray ? 1 : 3))
  for (let i = 0; i < n; i++) {
    if (gray) raw[i] = img.data[i * 4]
    else {
      raw[i * 3] = img.data[i * 4]
      raw[i * 3 + 1] = img.data[i * 4 + 1]
      raw[i * 3 + 2] = img.data[i * 4 + 2]
    }
  }
  return zlibSync(raw, { level: 6 })
}

export class ScanPdfBuilder {
  private constructor(private readonly doc: PDFDocument) {}

  static async create(meta: { title?: string } = {}): Promise<ScanPdfBuilder> {
    const doc = await PDFDocument.create({ updateMetadata: false })
    doc.setCreator('Epdf')
    doc.setProducer('Epdf')
    doc.setCreationDate(new Date())
    doc.setModificationDate(new Date())
    if (meta.title) doc.setTitle(meta.title)
    return new ScanPdfBuilder(doc)
  }

  get pageCount(): number {
    return this.doc.getPageCount()
  }

  async addPage(p: EncodedPage): Promise<void> {
    if (!(p.pageWidthPt > 0 && p.pageHeightPt > 0) || p.pageWidthPt > 14400 || p.pageHeightPt > 14400) throw new Error('Invalid page size for the scanned page.')
    const page = this.doc.addPage([p.pageWidthPt, p.pageHeightPt])
    if (p.kind === 'jpeg') {
      const img = await this.doc.embedJpg(p.bytes)
      page.drawImage(img, { x: 0, y: 0, width: p.pageWidthPt, height: p.pageHeightPt })
      return
    }
    const bilevel = p.kind === 'bilevel'
    const bpc = bilevel ? 1 : 8
    const colors = p.kind === 'rgb8' ? 3 : 1
    const dict = this.doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: p.widthPx,
      Height: p.heightPx,
      ColorSpace: colors === 3 ? 'DeviceRGB' : 'DeviceGray',
      BitsPerComponent: bpc,
      Filter: 'FlateDecode',
      ...(bilevel ? { DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 1, Columns: p.widthPx } } : {})
    })
    const ref = this.doc.context.register(PDFRawStream.of(dict, p.data))
    const name = page.node.newXObject('Scan', ref)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(p.pageWidthPt, 0, 0, p.pageHeightPt, 0, 0), drawObject(name), popGraphicsState())
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save()
  }
}

export async function assemblePdf(pages: EncodedPage[], meta: { title?: string } = {}): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('There are no pages to put in the PDF.')
  const b = await ScanPdfBuilder.create(meta)
  for (const p of pages) await b.addPage(p)
  return b.save()
}
