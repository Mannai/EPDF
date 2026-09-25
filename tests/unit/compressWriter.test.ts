import { unzlibSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS, type CompressOptions } from '../../src/renderer/src/features/compress/pdf/options'
import { writePdf } from '../../src/renderer/src/features/compress/pdf/writer'
import { addRawImage, baseDoc, photoRGB, placeAt } from './compressHelpers'
import { addLink, addOutline, makeDoc } from './pdfTestUtils'

/**
 * pdf-lib and PDF.js both REBUILD a broken cross-reference table instead of failing, so "they open it" does not prove our
 * writer's offsets are right. This test parses the file the way a strict reader does: startxref -> xref (table or stream) ->
 * every entry must point at the object it claims to, object streams must contain the objects the xref says they do.
 */

const latin = (b: Uint8Array, from = 0, to = b.length): string => Buffer.from(b.subarray(from, to)).toString('latin1')

function parseDictText(s: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*([^/>]+|\\[[^\\]]*\\])`).exec(s)
  return m ? m[1].trim() : null
}

interface Entry {
  type: 0 | 1 | 2
  a: number
  b: number
}

function readXref(bytes: Uint8Array): { entries: Map<number, Entry>; size: number; trailer: string } {
  const text = latin(bytes)
  const sx = text.lastIndexOf('startxref')
  const start = parseInt(/startxref\s+(\d+)/.exec(text.slice(sx))![1], 10)
  expect(text.slice(text.length - 6)).toBe('%%EOF\n')
  const entries = new Map<number, Entry>()
  if (text.slice(start, start + 4) === 'xref') {
    // classic table
    const lines = text.slice(start).split('\n')
    const [first, count] = lines[1].split(' ').map(Number)
    expect(first).toBe(0)
    for (let i = 0; i < count; i++) {
      const l = lines[2 + i]
      expect(l.length, `xref line ${i}`).toBe(19) // 20 bytes with the newline
      const [off, gen, kind] = [parseInt(l.slice(0, 10), 10), parseInt(l.slice(11, 16), 10), l[17]]
      entries.set(i, kind === 'n' ? { type: 1, a: off, b: gen } : { type: 0, a: 0, b: gen })
    }
    const trailer = text.slice(text.indexOf('trailer', start))
    return { entries, size: count, trailer }
  }
  // cross-reference stream
  const head = text.slice(start, start + 600)
  expect(head).toMatch(/^\d+ 0 obj/)
  const dictEnd = head.indexOf('stream')
  const dict = head.slice(0, dictEnd)
  const size = parseInt(parseDictText(dict, 'Size')!, 10)
  const w = parseDictText(dict, 'W')!.replace(/[\[\]]/g, '').trim().split(/\s+/).map(Number)
  const columns = parseInt(/\/Columns\s+(\d+)/.exec(dict)![1], 10)
  const len = parseInt(parseDictText(dict, 'Length')!, 10)
  const dataStart = start + dictEnd + 'stream\n'.length
  const inflated = unzlibSync(bytes.subarray(dataStart, dataStart + len))
  // undo PNG "Up" predictor (12)
  const rowLen = columns
  const rows = inflated.length / (rowLen + 1)
  const raw = new Uint8Array(rows * rowLen)
  for (let y = 0; y < rows; y++) {
    expect(inflated[y * (rowLen + 1)]).toBe(2)
    for (let x = 0; x < rowLen; x++) raw[y * rowLen + x] = (inflated[y * (rowLen + 1) + 1 + x] + (y ? raw[(y - 1) * rowLen + x] : 0)) & 255
  }
  expect(rows).toBe(size)
  const num = (o: number, n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + raw[o + i]
    return v
  }
  for (let i = 0; i < rows; i++) {
    const o = i * rowLen
    entries.set(i, { type: num(o, w[0]) as 0 | 1 | 2, a: num(o + w[0], w[1]), b: num(o + w[0] + w[1], w[2]) })
  }
  return { entries, size, trailer: dict }
}

function verify(bytes: Uint8Array): { objects: number; compressed: number } {
  const { entries, size, trailer } = readXref(bytes)
  expect(entries.size).toBe(size)
  expect(entries.get(0)).toMatchObject({ type: 0 })
  const text = latin(bytes)
  expect(trailer).toMatch(/\/Root \d+ 0 R/)
  const rootNum = parseInt(/\/Root (\d+) 0 R/.exec(trailer)![1], 10)
  expect(entries.get(rootNum)!.type).not.toBe(0)
  let compressed = 0
  const objstm = new Map<number, { n: number; nums: number[] }>()
  for (const [n, e] of entries) {
    if (e.type === 1) {
      expect(text.slice(e.a, e.a + `${n} 0 obj`.length), `object ${n} at ${e.a}`).toBe(`${n} 0 obj`)
      expect(text.indexOf('endobj', e.a)).toBeGreaterThan(e.a)
    } else if (e.type === 2) {
      compressed++
      if (!objstm.has(e.a)) {
        const host = entries.get(e.a)!
        expect(host.type).toBe(1) // object streams are never themselves compressed
        const h = latin(bytes, host.a, host.a + 400)
        expect(h).toMatch(/\/Type\s*\/ObjStm/)
        const count = parseInt(/\/N (\d+)/.exec(h)![1], 10)
        const first = parseInt(/\/First (\d+)/.exec(h)![1], 10)
        const len = parseInt(/\/Length (\d+)/.exec(h)![1], 10)
        const ds = host.a + h.indexOf('stream\n') + 'stream\n'.length
        const body = unzlibSync(bytes.subarray(ds, ds + len))
        const header = latin(body, 0, first).trim().split(/\s+/).map(Number)
        const nums: number[] = []
        for (let i = 0; i < count; i++) nums.push(header[i * 2])
        objstm.set(e.a, { n: count, nums })
      }
      expect(objstm.get(e.a)!.nums[e.b], `object ${n} is entry ${e.b} of stream ${e.a}`).toBe(n)
    }
  }
  return { objects: entries.size - 1, compressed }
}

const run = (bytes: Uint8Array, extra: Partial<CompressOptions> = {}) => compressPdf(bytes, { ...PRESETS.balanced, ...extra }, { codec: pureCodec })

describe('writer: strict cross-reference integrity (not just "the loader recovered")', () => {
  it('xref stream + object streams: every offset and every object-stream slot is exact', async () => {
    const doc = await makeDoc(30)
    addOutline(doc, [{ title: 'A', page: 0 }, { title: 'B', page: 10, children: [{ title: 'B1', page: 12 }] }])
    addLink(doc, 0, 5)
    const r = await run(await doc.save({ useObjectStreams: false }), { objectStreams: true })
    expect(r.kept).toBe('result')
    const v = verify(r.bytes)
    expect(v.compressed).toBeGreaterThan(30)
    expect(v.objects).toBeGreaterThan(60)
  })

  it('classic table: 20-byte entries, exact offsets, free head', async () => {
    const doc = await makeDoc(12)
    const loaded = await PDFDocument.load(await doc.save())
    const out = writePdf(loaded.context, { objectStreams: false })
    expect(verify(out.bytes).compressed).toBe(0)
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(12)
  })

  it('with big streams in the middle (offsets must account for stream data), both layouts', async () => {
    const { doc, page } = await baseDoc()
    for (let i = 0; i < 4; i++) placeAt(page, addRawImage(doc, { w: 300, h: 200, data: photoRGB(300, 200, i), cs: 'DeviceRGB' }), 10, 10 + i * 50, 60, 40)
    const input = await doc.save()
    for (const objectStreams of [true, false]) {
      const loaded = await PDFDocument.load(input)
      const out = writePdf(loaded.context, { objectStreams })
      verify(out.bytes)
      expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(1)
    }
    // and through the whole pipeline
    const r = await run(input, { images: false, dedupe: false })
    if (r.kept === 'result') verify(r.bytes)
  })

  it('stream /Length values are exact (data + endstream follow immediately)', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 100, h: 100, data: photoRGB(100, 100, 3), cs: 'DeviceRGB' }), 10, 10, 60, 60)
    const loaded = await PDFDocument.load(await doc.save())
    const out = writePdf(loaded.context, { objectStreams: true }).bytes
    const t = latin(out)
    let checked = 0
    for (const m of t.matchAll(/\/Length (\d+)[^>]*>>\nstream\n/g)) {
      const len = parseInt(m[1], 10)
      const s = (m.index ?? 0) + m[0].length
      expect(t.slice(s + len, s + len + '\nendstream'.length), `stream at ${s}`).toBe('\nendstream')
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })

  it('startxref points at the xref and the file ends with %%EOF', async () => {
    const r = await run(await (await makeDoc(3)).save(), {})
    const t = latin(r.bytes)
    const off = parseInt(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(t)![1], 10)
    expect(t.slice(off, off + 12)).toMatch(/^\d+ 0 obj|^xref/)
  })
})
