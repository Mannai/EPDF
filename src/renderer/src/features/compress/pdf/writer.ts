import { PDFArray, PDFDict, PDFInvalidObject, PDFRef, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib'
import { reachable, trailerRoots, type Alias, type Reached } from './graph'
import { deflateMax, encodedBytes, refKey } from './streams'

/**
 * Our own PDF serialiser. pdf-lib's writer cannot drop unreachable objects, renumber, compress its object streams at
 * maximum level, or keep a deterministic layout; this one writes exactly the objects reachable from the trailer, numbered
 * densely in document order, either as a classic file or (PDF 1.5+) with compressed object streams and a cross-reference
 * stream.
 */

export interface WriteOptions {
  objectStreams: boolean
  /** References to replace by another object (deduplication). */
  alias?: Alias
  /** Leave the Info dictionary out. */
  dropInfo?: boolean
}

export interface WriteResult {
  bytes: Uint8Array
  /** Number of indirect objects written (not counting object streams / xref). */
  objects: number
}

class Sink {
  buf = new Uint8Array(1 << 20)
  n = 0
  private ensure(k: number): void {
    if (this.n + k <= this.buf.length) return
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.n + k))
    nb.set(this.buf.subarray(0, this.n))
    this.buf = nb
  }
  ascii(s: string): void {
    this.ensure(s.length)
    for (let i = 0; i < s.length; i++) this.buf[this.n++] = s.charCodeAt(i) & 0xff
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length)
    this.buf.set(b, this.n)
    this.n += b.length
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.n)
  }
}

type NumberOf = (r: PDFRef) => number | undefined

function writeValue(s: Sink, o: PDFObject, num: NumberOf, alias: Alias | undefined): void {
  if (o instanceof PDFRef) {
    const n = num(alias?.get(refKey(o)) ?? o)
    s.ascii(n === undefined ? 'null' : `${n} 0 R`)
  } else if (o instanceof PDFDict) {
    s.ascii('<<')
    for (const [k, v] of o.entries()) {
      s.ascii(k.toString())
      s.ascii(' ')
      writeValue(s, v, num, alias)
      s.ascii(' ')
    }
    s.ascii('>>')
  } else if (o instanceof PDFArray) {
    s.ascii('[')
    const items = o.asArray()
    for (let i = 0; i < items.length; i++) {
      if (i) s.ascii(' ')
      writeValue(s, items[i], num, alias)
    }
    s.ascii(']')
  } else if (o instanceof PDFInvalidObject) {
    const b = new Uint8Array(o.sizeInBytes())
    o.copyBytesInto(b, 0)
    s.bytes(b)
  } else s.ascii(o.toString())
}

function serializeObject(o: PDFObject, num: NumberOf, alias: Alias | undefined): Uint8Array {
  const s = new Sink()
  s.buf = new Uint8Array(256)
  writeValue(s, o, num, alias)
  return s.result()
}

function streamHead(st: PDFStream, length: number, num: NumberOf, alias: Alias | undefined): Uint8Array {
  const s = new Sink()
  s.buf = new Uint8Array(512)
  s.ascii('<<')
  for (const [k, v] of st.dict.entries()) {
    if (k.toString() === '/Length') continue
    s.ascii(k.toString())
    s.ascii(' ')
    writeValue(s, v, num, alias)
    s.ascii(' ')
  }
  s.ascii(`/Length ${length}>>`)
  return s.result()
}

const be = (v: number, w: number): number[] => {
  const out: number[] = []
  for (let i = w - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** (8 * i)) & 255)
  return out
}

const bytesNeeded = (v: number): number => (v < 256 ? 1 : v < 65536 ? 2 : v < 16777216 ? 3 : 4)

/** PNG "Up" filter over fixed-width rows (predictor 12): makes the xref table compress well. */
function upFilter(rows: Uint8Array, rowLen: number): Uint8Array {
  const n = rows.length / rowLen
  const out = new Uint8Array(n * (rowLen + 1))
  for (let y = 0; y < n; y++) {
    out[y * (rowLen + 1)] = 2
    for (let i = 0; i < rowLen; i++) out[y * (rowLen + 1) + 1 + i] = (rows[y * rowLen + i] - (y ? rows[(y - 1) * rowLen + i] : 0)) & 255
  }
  return out
}

const OBJSTM_MAX_OBJECTS = 256
const OBJSTM_MAX_BYTES = 1 << 20

export function writePdf(ctx: PDFContext, opts: WriteOptions): WriteResult {
  const { root, info } = trailerRoots(ctx)
  if (!root) throw new Error('The document has no catalog.')
  const alias = opts.alias
  const list: Reached[] = reachable(ctx, [root, opts.dropInfo ? undefined : info], alias)
  const numbers = new Map<string, number>()
  list.forEach((r, i) => numbers.set(refKey(r.ref), i + 1))
  const num: NumberOf = (r) => numbers.get(refKey(r))
  const count = list.length

  const out = new Sink()
  const vm = /%PDF-(\d)\.(\d)/.exec(ctx.header.toString())
  const maj = vm ? parseInt(vm[1], 10) : 1
  const min = vm ? parseInt(vm[2], 10) : 7
  const version = `${maj}.${min}`
  const v15 = maj > 1 || min >= 5
  out.ascii(`%PDF-${opts.objectStreams && !v15 ? '1.5' : version}\n%`)
  out.bytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]))
  out.ascii('\n')

  // Encode each object.
  const offsets = new Array<number>(count + 1).fill(-1)
  const inStream = new Map<number, { stm: number; index: number }>()
  interface Pending {
    n: number
    bytes: Uint8Array
  }
  const packable: Pending[] = []

  const writeIndirect = (n: number, head: Uint8Array, data?: Uint8Array): void => {
    offsets[n] = out.n
    out.ascii(`${n} 0 obj\n`)
    out.bytes(head)
    if (data) {
      out.ascii('\nstream\n')
      out.bytes(data)
      out.ascii('\nendstream')
    }
    out.ascii('\nendobj\n')
  }

  for (let i = 0; i < list.length; i++) {
    const n = i + 1
    const o = list[i].obj
    if (o instanceof PDFStream) {
      const data = encodedBytes(o)
      writeIndirect(n, streamHead(o, data.length, num, alias), data)
    } else if (opts.objectStreams) {
      packable.push({ n, bytes: serializeObject(o, num, alias) })
    } else {
      writeIndirect(n, serializeObject(o, num, alias))
    }
  }

  let nextNum = count + 1
  if (opts.objectStreams) {
    for (let i = 0; i < packable.length; ) {
      let j = i
      let size = 0
      while (j < packable.length && j - i < OBJSTM_MAX_OBJECTS && size < OBJSTM_MAX_BYTES) size += packable[j++].bytes.length + 1
      const chunk = packable.slice(i, j)
      i = j
      const stmNum = nextNum++
      let header = ''
      let body = 0
      const parts: Uint8Array[] = []
      chunk.forEach((p, idx) => {
        header += `${p.n} ${body} `
        parts.push(p.bytes)
        body += p.bytes.length + 1
        inStream.set(p.n, { stm: stmNum, index: idx })
      })
      const head = new TextEncoder().encode(header + '\n')
      const raw = new Uint8Array(head.length + body)
      raw.set(head, 0)
      let o = head.length
      for (const p of parts) {
        raw.set(p, o)
        o += p.length
        raw[o++] = 10
      }
      const z = deflateMax(raw)
      writeIndirect(stmNum, new TextEncoder().encode(`<</Type/ObjStm/N ${chunk.length}/First ${head.length}/Filter/FlateDecode/Length ${z.length}>>`), z)
    }
  }

  // Trailer entries.
  const trailer = new Sink()
  trailer.buf = new Uint8Array(256)
  trailer.ascii(`/Root ${numbers.get(refKey(alias?.get(refKey(root)) ?? root))} 0 R`)
  if (info && !opts.dropInfo && numbers.has(refKey(alias?.get(refKey(info)) ?? info))) {
    trailer.ascii(` /Info ${numbers.get(refKey(alias?.get(refKey(info)) ?? info))} 0 R`)
  }
  const idObj = ctx.trailerInfo.ID
  const idArr = idObj instanceof PDFArray ? idObj : idObj instanceof PDFRef ? ctx.lookup(idObj) : undefined
  if (idArr instanceof PDFArray) {
    trailer.ascii(' /ID ')
    writeValue(trailer, idArr, num, alias)
  }
  const trailerBody = trailer.result()

  const xrefStart = out.n
  if (opts.objectStreams) {
    const xrefNum = nextNum++
    const size = xrefNum + 1
    offsets[xrefNum] = xrefStart
    const w2 = bytesNeeded(xrefStart)
    const rowLen = 1 + w2 + 2
    const rows = new Uint8Array(size * rowLen)
    for (let n = 0; n < size; n++) {
      let row: number[]
      if (n === 0) row = [0, ...be(0, w2), ...be(65535, 2)]
      else if (inStream.has(n)) {
        const p = inStream.get(n)!
        row = [2, ...be(p.stm, w2), ...be(p.index, 2)]
      } else row = [1, ...be(n === xrefNum ? xrefStart : (offsets[n] < 0 ? 0 : offsets[n]), w2), ...be(0, 2)]
      rows.set(row, n * rowLen)
    }
    // Object-stream objects have offsets recorded in `offsets` (they are written before the xref).
    const z = deflateMax(upFilter(rows, rowLen))
    out.ascii(`${xrefNum} 0 obj\n`)
    out.ascii(`<</Type/XRef/Size ${size}/W[1 ${w2} 2]/Filter/FlateDecode/DecodeParms<</Columns ${rowLen}/Predictor 12>>/Length ${z.length} `)
    out.bytes(trailerBody)
    out.ascii('>>')
    out.ascii('\nstream\n')
    out.bytes(z)
    out.ascii('\nendstream\nendobj\n')
  } else {
    const size = count + 1
    out.ascii(`xref\n0 ${size}\n0000000000 65535 f \n`)
    for (let n = 1; n < size; n++) out.ascii(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
    out.ascii(`trailer\n<</Size ${size} `)
    out.bytes(trailerBody)
    out.ascii('>>\n')
  }
  out.ascii(`startxref\n${xrefStart}\n%%EOF\n`)
  return { bytes: out.result(), objects: count }
}
