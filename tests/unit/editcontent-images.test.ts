import { PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { formatOp } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import {
  addImage,
  boxMap,
  centeredPlacement,
  deleteImage,
  fitPlacement,
  replaceImage,
  transformImage
} from '../../src/renderer/src/features/textedit/pdfcontent/imageEdit'
import type { Rect } from '../../src/renderer/src/features/textedit/pdfcontent/matrix'
import { EditRefusedError } from '../../src/renderer/src/features/textedit/pdfcontent/write'
import { addRawImage, buildPdf, helvetica, makeFakeJpeg, makePng } from './helpers/pdfBuilder'

const near = (a: number, b: number, eps = 1e-4): void => expect(Math.abs(a - b)).toBeLessThan(eps)
const rect = (r: Rect, x0: number, y0: number, x1: number, y1: number): void => {
  near(r.x0, x0)
  near(r.y0, y0)
  near(r.x1, x1)
  near(r.y1, y1)
}

async function withImage(content: string, size: [number, number] = [4, 3]) {
  const { doc } = await buildPdf([{ content, fonts: { F1: helvetica } }])
  const img = addRawImage(doc, size[0], size[1])
  doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Im1: img }))
  return { bytes: await doc.save(), img }
}

async function run<T>(bytes: Uint8Array, fn: (doc: PDFDocument) => T | Promise<T>): Promise<{ bytes: Uint8Array; value: T }> {
  const doc = await PDFDocument.load(bytes)
  const value = await fn(doc)
  return { bytes: await doc.save(), value }
}

const imagesOf = async (bytes: Uint8Array, page = 0) => analyzePage(await PDFDocument.load(bytes), page).images
const opsOf = async (bytes: Uint8Array, page = 0): Promise<string[]> => {
  const a = analyzePage(await PDFDocument.load(bytes), page)
  return [...a.sources.values()].flatMap((s) => s.slots.flatMap((sl) => sl.ops.map(formatOp)))
}

describe('pure image math', () => {
  it('boxMap maps the old box onto the new one', () => {
    const A = boxMap({ x0: 10, y0: 20, x1: 110, y1: 70 }, { x0: 0, y0: 0, x1: 50, y1: 100 })
    near(A[0], 0.5)
    near(A[3], 2)
    near(10 * A[0] + A[4], 0)
    near(20 * A[3] + A[5], 0)
    near(110 * A[0] + A[4], 50)
    near(70 * A[3] + A[5], 100)
  })
  it('boxMap refuses an empty box', () => {
    expect(() => boxMap({ x0: 0, y0: 0, x1: 0, y1: 5 }, { x0: 0, y0: 0, x1: 1, y1: 1 })).toThrow(EditRefusedError)
  })
  it('fit/fill placement inside the unit square', () => {
    let p = fitPlacement(2, 2, 'fit') // same aspect: the whole box
    expect([p.ew, p.eh, p.ex, p.ey]).toEqual([1, 1, 0, 0])
    p = fitPlacement(2, 1, 'fit') // wide image in a square box: full width, centred vertically
    expect([p.ew, p.eh, p.ex, p.ey]).toEqual([1, 0.5, 0, 0.25])
    p = fitPlacement(1, 2, 'fit') // square image in a wide box: half width? (aspect image 1 < box 2)
    near(p.ew, 0.5)
    near(p.eh, 1)
    near(p.ex, 0.25)
    p = fitPlacement(2, 1, 'fill') // wide image covering a square box: height fills, width overflows
    near(p.eh, 1)
    near(p.ew, 2)
    p = fitPlacement(4, 1, 'fill') // very wide image covering a wide box: taller than the box is impossible; overflows in x
    near(p.eh, 1)
    near(p.ew, 4)
    near(p.ex, -1.5)
    p = fitPlacement(1, 1, 'fit')
    expect([p.ew, p.eh]).toEqual([1, 1])
  })
  it('centeredPlacement keeps aspect and caps the long side', () => {
    const m = centeredPlacement(400, 200, 300, 300, 100)
    near(m[0], 100)
    near(m[3], 50)
    near(m[4], 250)
    near(m[5], 275)
    const small = centeredPlacement(20, 10, 0, 0, 100)
    near(small[0], 20)
  })
})

describe('move and resize', () => {
  it('moves an image wrapped in q cm Do Q by editing only its cm', async () => {
    const { bytes } = await withImage('BT /F1 12 Tf 10 10 Td (keep) Tj ET q 100 0 0 50 72 600 cm /Im1 Do Q BT /F1 12 Tf 10 20 Td (after) Tj ET')
    const before = await opsOf(bytes)
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => transformImage(d, 0, id, { x0: 150, y0: 500, x1: 250, y1: 550 }))
    expect(out.value.message).toBe('Image moved')
    const after = await opsOf(out.bytes)
    expect(after.length).toBe(before.length) // no operations added
    const changed = before.map((o, i) => [o, after[i]]).filter(([a, b]) => a !== b)
    expect(changed).toEqual([['100 0 0 50 72 600 cm', '100 0 0 50 150 500 cm']])
    rect((await imagesOf(out.bytes))[0].bbox, 150, 500, 250, 550)
  })

  it('resizes about the box (top-left stays wherever the caller puts it) and leaves other content alone', async () => {
    const { bytes } = await withImage('q 100 0 0 50 72 600 cm /Im1 Do Q BT /F1 12 Tf 10 20 Td (after) Tj ET')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => transformImage(d, 0, id, { x0: 72, y0: 550, x1: 272, y1: 650 }))
    expect(out.value.message).toBe('Image resized')
    rect((await imagesOf(out.bytes))[0].bbox, 72, 550, 272, 650)
    expect(await opsOf(out.bytes)).toContain('200 0 0 100 72 550 cm')
    expect((await opsOf(out.bytes)).filter((o) => o.endsWith(' Tj')).length).toBe(1)
  })

  it('wraps in q/Q when there is no wrapper, so following content keeps its coordinate system', async () => {
    const { bytes } = await withImage('100 0 0 50 72 600 cm /Im1 Do BT /F1 12 Tf 1 0 0 1 0 0 Tm (follows) Tj ET')
    const before = analyzePage(await PDFDocument.load(bytes), 0)
    const id = before.images[0].id
    const out = await run(bytes, (d) => transformImage(d, 0, id, { x0: 0, y0: 0, x1: 300, y1: 100 }))
    const after = analyzePage(await PDFDocument.load(out.bytes), 0)
    rect(after.images[0].bbox, 0, 0, 300, 100)
    // the text after the image is exactly where it was
    expect(after.runs[0].matrix.map((v) => Math.round(v * 1e4) / 1e4)).toEqual(before.runs[0].matrix.map((v) => Math.round(v * 1e4) / 1e4))
    expect((await opsOf(out.bytes)).slice(0, 5)).toEqual(['100 0 0 50 72 600 cm', 'q', expect.stringMatching(/cm$/), '/Im1 Do', 'Q'])
  })

  it('works through nested scaling transforms', async () => {
    const { bytes } = await withImage('q 2 0 0 2 10 10 cm q 50 0 0 25 5 5 cm /Im1 Do Q Q')
    const before = (await imagesOf(bytes))[0]
    rect(before.bbox, 20, 20, 120, 70)
    const out = await run(bytes, (d) => transformImage(d, 0, before.id, { x0: 40, y0: 60, x1: 90, y1: 110 }))
    rect((await imagesOf(out.bytes))[0].bbox, 40, 60, 90, 110)
  })

  it('handles a 90° rotated image (resize allowed) and only moves an arbitrarily rotated one', async () => {
    const r90 = await withImage('q 0 40 -40 0 300 300 cm /Im1 Do Q')
    const id90 = (await imagesOf(r90.bytes))[0].id
    const o1 = await run(r90.bytes, (d) => transformImage(d, 0, id90, { x0: 100, y0: 100, x1: 200, y1: 180 }))
    rect((await imagesOf(o1.bytes))[0].bbox, 100, 100, 200, 180)

    const r45 = await withImage('q 28 28 -28 28 100 100 cm /Im1 Do Q')
    const im = (await imagesOf(r45.bytes))[0]
    const w = im.bbox.x1 - im.bbox.x0
    const h = im.bbox.y1 - im.bbox.y0
    const o2 = await run(r45.bytes, (d) => transformImage(d, 0, im.id, { x0: 10, y0: 20, x1: 10 + w, y1: 20 + h }))
    rect((await imagesOf(o2.bytes))[0].bbox, 10, 20, 10 + w, 20 + h)
    await expect(run(r45.bytes, (d) => transformImage(d, 0, im.id, { x0: 10, y0: 20, x1: 10 + 2 * w, y1: 20 + h }))).rejects.toThrow(/rotated or skewed/)
  })

  it('moves an inline image', async () => {
    const { bytes } = await buildPdf([{ content: 'q 30 0 0 30 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x40\x80\xff\nEI Q', fonts: {} }])
    const im = (await imagesOf(bytes))[0]
    expect(im.kind).toBe('inline')
    const out = await run(bytes, (d) => transformImage(d, 0, im.id, { x0: 100, y0: 100, x1: 130, y1: 130 }))
    const moved = (await imagesOf(out.bytes))[0]
    expect(moved.kind).toBe('inline')
    rect(moved.bbox, 100, 100, 130, 130)
    // the pixel data is untouched
    const a = analyzePage(await PDFDocument.load(out.bytes), 0)
    const bi = [...a.sources.values()][0].slots[0].ops.find((o) => o.op === 'BI')!
    expect(Array.from(bi.inline!.data)).toEqual([0, 0x40, 0x80, 0xff])
  })

  it('rejects invalid boxes and stale ids without touching the document', async () => {
    const { bytes } = await withImage('q 100 0 0 50 72 600 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    await expect(run(bytes, (d) => transformImage(d, 0, id, { x0: 0, y0: 0, x1: 0.2, y1: 100 }))).rejects.toThrow(/too small/)
    await expect(run(bytes, (d) => transformImage(d, 0, id, { x0: NaN, y0: 0, x1: 10, y1: 10 }))).rejects.toThrow(/not valid/)
    await expect(run(bytes, (d) => transformImage(d, 0, 'page:9:9', { x0: 0, y0: 0, x1: 10, y1: 10 }))).rejects.toThrow(/no longer/)
  })
})

describe('delete', () => {
  it('removes the whole q cm Do Q wrapper and drops the now-unreferenced image data', async () => {
    const { bytes, img } = await withImage('BT /F1 12 Tf 10 10 Td (keep) Tj ET q 100 0 0 50 72 600 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => deleteImage(d, 0, id))
    expect(out.value.message).toBe('Image deleted')
    expect(await opsOf(out.bytes)).toEqual(['BT', '/F1 12 Tf', '10 10 Td', '(keep) Tj', 'ET'])
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.context.lookup(img)).toBeUndefined()
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')) as unknown as { keys(): unknown[] }
    expect(xo.keys()).toHaveLength(0)
    expect((await imagesOf(out.bytes))).toHaveLength(0)
  })

  it('removes only the Do when there is no wrapper', async () => {
    const { bytes } = await withImage('1 0 0 1 5 5 cm /Im1 Do BT ET')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => deleteImage(d, 0, id))
    expect(await opsOf(out.bytes)).toEqual(['1 0 0 1 5 5 cm', 'BT', 'ET'])
  })

  it('keeps the data when the same image is still drawn elsewhere on the page', async () => {
    const { bytes, img } = await withImage('q 10 0 0 10 0 0 cm /Im1 Do Q q 10 0 0 10 50 50 cm /Im1 Do Q')
    const ims = await imagesOf(bytes)
    const out = await run(bytes, (d) => deleteImage(d, 0, ims[0].id))
    expect(out.value.message).toBe('Image removed from the page')
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.context.lookup(img)).toBeDefined()
    expect((await imagesOf(out.bytes))).toHaveLength(1)
  })

  it('keeps the data when another page uses the image', async () => {
    const { doc } = await buildPdf([
      { content: 'q 10 0 0 10 0 0 cm /Im1 Do Q', fonts: {} },
      { content: 'q 20 0 0 20 0 0 cm /Im1 Do Q', fonts: {} }
    ])
    const img = addRawImage(doc, 2, 2)
    for (const i of [0, 1]) doc.getPage(i).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Im1: img }))
    const bytes = await doc.save()
    const id = (await imagesOf(bytes, 0))[0].id
    const out = await run(bytes, (d) => deleteImage(d, 0, id))
    expect((await imagesOf(out.bytes, 0))).toHaveLength(0)
    expect((await imagesOf(out.bytes, 1))).toHaveLength(1)
    expect(await opsOf(out.bytes, 1)).toContain('/Im1 Do')
  })

  it('keeps the data when the resource dictionary itself is shared between pages', async () => {
    const { doc } = await buildPdf([
      { content: 'q 10 0 0 10 0 0 cm /Im1 Do Q', fonts: {} },
      { content: 'q 20 0 0 20 0 0 cm /Im1 Do Q', fonts: {} }
    ])
    const img = addRawImage(doc, 2, 2)
    const shared = doc.context.register(doc.context.obj({ XObject: { Im1: img } }))
    for (const i of [0, 1]) doc.getPage(i).node.set(PDFName.of('Resources'), shared)
    const bytes = await doc.save()
    const id = (await imagesOf(bytes, 0))[0].id
    const out = await run(bytes, (d) => deleteImage(d, 0, id))
    expect((await imagesOf(out.bytes, 1))).toHaveLength(1)
    expect((await PDFDocument.load(out.bytes)).context.lookup(img)).toBeDefined()
  })

  it('removes inline images', async () => {
    const { bytes } = await buildPdf([{ content: 'q 30 0 0 30 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x40\x80\xff\nEI Q BT ET', fonts: {} }])
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => deleteImage(d, 0, id))
    expect(await opsOf(out.bytes)).toEqual(['BT', 'ET'])
  })
})

describe('replace', () => {
  it('fits a PNG inside the same box, keeping aspect ratio and centring it', async () => {
    const { bytes, img } = await withImage('q 200 0 0 100 72 600 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => replaceImage(d, 0, id, { kind: 'png', bytes: makePng(50, 50) }, 'fit'))
    expect(out.value.message).toMatch(/fitted/)
    const after = await imagesOf(out.bytes)
    expect(after).toHaveLength(1)
    // a square image in a 2:1 box: 100x100 centred horizontally
    rect(after[0].bbox, 72 + 50, 600, 72 + 150, 700)
    expect([after[0].width, after[0].height]).toEqual([50, 50])
    expect(after[0].name).toMatch(/^EpdfIm/)
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.context.lookup(img)).toBeUndefined() // the old picture data is gone
  })

  it('fills the box and clips the overflow', async () => {
    const { bytes } = await withImage('q 200 0 0 100 72 600 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => replaceImage(d, 0, id, { kind: 'png', bytes: makePng(50, 50) }, 'fill'))
    expect(out.value.message).toMatch(/filling/)
    const ops = await opsOf(out.bytes)
    expect(ops).toContain('0 0 1 1 re')
    expect(ops).toContain('W')
    expect(ops).toContain('n')
    const after = await imagesOf(out.bytes)
    // unclipped extent is 200x200 (square image covering a 2:1 box), centred vertically
    rect(after[0].bbox, 72, 550, 272, 750)
  })

  it('accepts JPEG pictures', async () => {
    const { bytes } = await withImage('q 100 0 0 100 10 10 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => replaceImage(d, 0, id, { kind: 'jpg', bytes: makeFakeJpeg(40, 20) }, 'fit'))
    const a = await imagesOf(out.bytes)
    expect([a[0].width, a[0].height]).toEqual([40, 20])
    rect(a[0].bbox, 10, 35, 110, 85)
  })

  it('rejects files that are not a valid PNG/JPEG and leaves the document untouched', async () => {
    const { bytes } = await withImage('q 100 0 0 100 10 10 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const doc = await PDFDocument.load(bytes)
    await expect(replaceImage(doc, 0, id, { kind: 'png', bytes: new Uint8Array([1, 2, 3]) }, 'fit')).rejects.toThrow(/could not be read/)
    expect(await opsOf(await doc.save())).toEqual(await opsOf(bytes))
  })

  it('keeps a rotated placement (the new picture turns with the old box)', async () => {
    const { bytes } = await withImage('q 0 100 -50 0 300 300 cm /Im1 Do Q')
    const id = (await imagesOf(bytes))[0].id
    const out = await run(bytes, (d) => replaceImage(d, 0, id, { kind: 'png', bytes: makePng(10, 10) }, 'fit'))
    const after = (await imagesOf(out.bytes))[0]
    rect(after.bbox, 250, 325, 300, 375) // a square picture inside a 50x100 box: 50x50 centred
  })
})

describe('add', () => {
  it('appends a new stream with the image and leaves existing streams untouched', async () => {
    const { bytes } = await withImage('BT /F1 12 Tf 10 10 Td (hello) Tj ET')
    const before = await opsOf(bytes)
    const out = await run(bytes, (d) => addImage(d, 0, { kind: 'png', bytes: makePng(30, 20) }, centeredPlacement(30, 20, 300, 400, 200)))
    expect(out.value.message).toBe('Image added')
    const doc = await PDFDocument.load(out.bytes)
    const contents = doc.getPage(0).node.Contents() as unknown as { size(): number }
    expect(contents.size()).toBe(2)
    const after = await opsOf(out.bytes)
    expect(after.slice(0, before.length)).toEqual(before)
    const ims = await imagesOf(out.bytes)
    expect(ims).toHaveLength(1)
    rect(ims[0].bbox, 285, 390, 315, 410)
  })

  it('closes unbalanced q operators first so the CTM is the page default', async () => {
    const { bytes } = await withImage('q 0.5 0 0 0.5 100 100 cm BT ET')
    const out = await run(bytes, (d) => addImage(d, 0, { kind: 'png', bytes: makePng(10, 10) }, [40, 0, 0, 40, 200, 200]))
    const ims = await imagesOf(out.bytes)
    rect(ims[0].bbox, 200, 200, 240, 240)
  })

  it('works on a page without any content', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([300, 300])
    const bytes = await doc.save()
    const out = await run(bytes, (d) => addImage(d, 0, { kind: 'png', bytes: makePng(10, 10) }, [50, 0, 0, 50, 10, 10]))
    rect((await imagesOf(out.bytes))[0].bbox, 10, 10, 60, 60)
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(1)
  })

  it('places an upright image on a rotated page when given the viewport-derived matrix', async () => {
    const doc = await PDFDocument.create()
    const p = doc.addPage([300, 200])
    p.setRotation({ type: 'degrees' as never, angle: 90 } as never)
    const bytes = await doc.save()
    // Rotation 90° clockwise: viewport (x right, y down) → user space: (u, v) = (y_vp, x_vp)
    const out = await run(bytes, (d) => addImage(d, 0, { kind: 'png', bytes: makePng(10, 10) }, [0, 20, 20, 0, 100, 50]))
    expect((await imagesOf(out.bytes))).toHaveLength(1)
  })

  it('refuses degenerate placements', async () => {
    const { bytes } = await withImage('')
    await expect(run(bytes, (d) => addImage(d, 0, { kind: 'png', bytes: makePng(10, 10) }, [0, 0, 0, 0, 1, 1]))).rejects.toThrow(/no size/)
  })
})

describe('images inside Form XObjects', () => {
  it('moves and deletes an image that lives in a single-use form', async () => {
    const { doc } = await buildPdf([{ content: '/Fm1 Do', fonts: {} }])
    const img = addRawImage(doc, 2, 2)
    const form = doc.context.register(
      doc.context.flateStream('q 40 0 0 40 0 0 cm /I1 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { XObject: { I1: img } } } as never)
    )
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const bytes = await doc.save()
    const im = (await imagesOf(bytes))[0]
    expect(im.addr.source).toMatch(/^form:/)
    const moved = await run(bytes, (d) => transformImage(d, 0, im.id, { x0: 10, y0: 10, x1: 50, y1: 50 }))
    rect((await imagesOf(moved.bytes))[0].bbox, 10, 10, 50, 50)
    const deleted = await run(bytes, (d) => deleteImage(d, 0, im.id))
    expect(await imagesOf(deleted.bytes)).toHaveLength(0)
    expect((await PDFDocument.load(deleted.bytes)).context.lookup(img)).toBeUndefined()
  })

  it('refuses images in a form that is drawn twice', async () => {
    const { doc } = await buildPdf([{ content: '/Fm1 Do 1 0 0 1 100 0 cm /Fm1 Do', fonts: {} }])
    const img = addRawImage(doc, 2, 2)
    const form = doc.context.register(
      doc.context.flateStream('q 40 0 0 40 0 0 cm /I1 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { XObject: { I1: img } } } as never)
    )
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const bytes = await doc.save()
    const im = (await imagesOf(bytes))[0]
    expect(im.shared).toBe(true)
    await expect(run(bytes, (d) => deleteImage(d, 0, im.id))).rejects.toThrow(/shared/)
  })
})

describe('robustness', () => {
  it('does not lose the ref of the image in resources after edits (document remains loadable)', async () => {
    const { bytes } = await withImage('q 100 0 0 50 72 600 cm /Im1 Do Q')
    let cur = bytes
    for (let i = 0; i < 5; i++) {
      const id = (await imagesOf(cur))[0].id
      cur = (await run(cur, (d) => transformImage(d, 0, id, { x0: 72 + i * 10, y0: 600, x1: 172 + i * 10, y1: 650 }))).bytes
    }
    const doc = await PDFDocument.load(cur)
    expect(doc.getPageCount()).toBe(1)
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')) as unknown as { get(k: PDFName): unknown }
    expect(xo.get(PDFName.of('Im1'))).toBeInstanceOf(PDFRef)
    rect((await imagesOf(cur))[0].bbox, 112, 600, 212, 650)
  })
})
