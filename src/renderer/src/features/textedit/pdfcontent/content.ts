/**
 * PDF content-stream tokenizer, parser and serializer.
 *
 * `parseContent` turns bytes into a list of operations (operands + operator). Every operation remembers the
 * exact bytes it came from (and the whitespace/comments before it), so `serializeContent(parseContent(b))`
 * returns `b` byte-for-byte; only operations that were modified or created are re-serialized.
 * Anything that is not valid syntax (unterminated strings, unbalanced arrays, truncated inline images, ...)
 * throws `ContentParseError` so callers can refuse to edit instead of emitting garbage.
 */

export class ContentParseError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`)
    this.name = 'ContentParseError'
  }
}

export type PdfObj =
  | { t: 'num'; v: number }
  | { t: 'str'; b: Uint8Array; hex: boolean }
  | { t: 'name'; v: string }
  | { t: 'arr'; v: PdfObj[] }
  | { t: 'dict'; v: Map<string, PdfObj> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }

export interface InlineImage {
  /** Raw dictionary as written (keys may use the abbreviations W, H, BPC, CS, F, ...). */
  dict: Map<string, PdfObj>
  /** The (still encoded) image data between `ID` and `EI`. */
  data: Uint8Array
}

export interface Op {
  /** Operator keyword: `Tj`, `cm`, `BI`, `'`, ... */
  op: string
  args: PdfObj[]
  /** Whitespace and comments that precede this operation, verbatim. */
  pre: Uint8Array
  /** The exact original bytes of the operation (operands + operator); null once modified / for new ops. */
  raw: Uint8Array | null
  /** Set for `BI` operations only. */
  inline?: InlineImage
}

export interface ParsedContent {
  ops: Op[]
  /** Anything after the last operation (whitespace, comments, dangling operands). */
  tail: Uint8Array
}

// ---------------------------------------------------------------------------------------------------------
// Constructors

export const num = (v: number): PdfObj => ({ t: 'num', v })
export const name = (v: string): PdfObj => ({ t: 'name', v: v.startsWith('/') ? v.slice(1) : v })
export const arr = (...v: PdfObj[]): PdfObj => ({ t: 'arr', v })
export const dict = (entries: Record<string, PdfObj>): PdfObj => ({ t: 'dict', v: new Map(Object.entries(entries)) })
export const str = (b: Uint8Array | string, hex = false): PdfObj => ({
  t: 'str',
  b: typeof b === 'string' ? latin1ToBytes(b) : b,
  hex
})

const NEWLINE = new Uint8Array([10])
/** A new operation (serialized on demand, preceded by a newline). */
export const mkOp = (op: string, ...args: PdfObj[]): Op => ({ op, args, pre: NEWLINE, raw: null })
/** A copy of `op` with different operands that keeps its leading whitespace. */
export const withArgs = (op: Op, args: PdfObj[]): Op => ({ op: op.op, args, pre: op.pre, raw: null, inline: op.inline })

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
export function bytesToLatin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}

// ---------------------------------------------------------------------------------------------------------
// Lexer

const isWs = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0
const isDelim = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
const isRegular = (c: number): boolean => !isWs(c) && !isDelim(c)
const hexVal = (c: number): number =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x41 + 10 : c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : -1

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/
const MAX_DEPTH = 64

type Token =
  | { k: 'obj'; v: PdfObj }
  | { k: 'kw'; v: string }
  | { k: 'close'; v: ']' | '>>' }
  | { k: 'eof' }

class Lexer {
  pos = 0
  constructor(readonly buf: Uint8Array) {}

  skipWs(): void {
    const { buf } = this
    while (this.pos < buf.length) {
      const c = buf[this.pos]
      if (isWs(c)) this.pos++
      else if (c === 0x25) {
        while (this.pos < buf.length && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos++
      } else break
    }
  }

  next(depth = 0): Token {
    this.skipWs()
    const { buf } = this
    if (this.pos >= buf.length) return { k: 'eof' }
    const start = this.pos
    const c = buf[start]
    switch (c) {
      case 0x28:
        return { k: 'obj', v: this.literalString() }
      case 0x3c:
        if (buf[start + 1] === 0x3c) {
          this.pos += 2
          return { k: 'obj', v: this.dictBody(depth + 1) }
        }
        return { k: 'obj', v: this.hexString() }
      case 0x3e:
        if (buf[start + 1] === 0x3e) {
          this.pos += 2
          return { k: 'close', v: '>>' }
        }
        throw new ContentParseError('Unexpected ">"', start)
      case 0x5b:
        this.pos++
        return { k: 'obj', v: this.arrayBody(depth + 1) }
      case 0x5d:
        this.pos++
        return { k: 'close', v: ']' }
      case 0x7b:
      case 0x7d:
        this.pos++
        return { k: 'kw', v: String.fromCharCode(c) }
      case 0x29:
        throw new ContentParseError('Unbalanced ")"', start)
      case 0x2f:
        return { k: 'obj', v: this.nameToken() }
    }
    while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++
    const word = bytesToLatin1(buf.subarray(start, this.pos))
    if (NUMBER_RE.test(word)) return { k: 'obj', v: { t: 'num', v: Number(word) } }
    if (word === 'true') return { k: 'obj', v: { t: 'bool', v: true } }
    if (word === 'false') return { k: 'obj', v: { t: 'bool', v: false } }
    if (word === 'null') return { k: 'obj', v: { t: 'null' } }
    return { k: 'kw', v: word }
  }

  private nameToken(): PdfObj {
    const { buf } = this
    const start = ++this.pos
    while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++
    const bytes: number[] = []
    for (let i = start; i < this.pos; i++) {
      const c = buf[i]
      if (c === 0x23 && i + 2 < this.pos && hexVal(buf[i + 1]) >= 0 && hexVal(buf[i + 2]) >= 0) {
        bytes.push(hexVal(buf[i + 1]) * 16 + hexVal(buf[i + 2]))
        i += 2
      } else bytes.push(c)
    }
    return { t: 'name', v: String.fromCharCode(...bytes) }
  }

  private literalString(): PdfObj {
    const { buf } = this
    const start = this.pos
    this.pos++ // (
    const out: number[] = []
    let depth = 1
    while (true) {
      if (this.pos >= buf.length) throw new ContentParseError('Unterminated string', start)
      const c = buf[this.pos++]
      if (c === 0x5c) {
        if (this.pos >= buf.length) throw new ContentParseError('Unterminated string', start)
        const e = buf[this.pos++]
        switch (e) {
          case 0x6e: out.push(10); break
          case 0x72: out.push(13); break
          case 0x74: out.push(9); break
          case 0x62: out.push(8); break
          case 0x66: out.push(12); break
          case 13:
            if (buf[this.pos] === 10) this.pos++
            break
          case 10:
            break
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30
              for (let k = 0; k < 2 && this.pos < buf.length && buf[this.pos] >= 0x30 && buf[this.pos] <= 0x37; k++) {
                v = v * 8 + (buf[this.pos++] - 0x30)
              }
              out.push(v & 0xff)
            } else out.push(e)
        }
      } else if (c === 0x28) {
        depth++
        out.push(c)
      } else if (c === 0x29) {
        if (--depth === 0) break
        out.push(c)
      } else if (c === 13) {
        if (buf[this.pos] === 10) this.pos++
        out.push(10)
      } else out.push(c)
    }
    return { t: 'str', b: Uint8Array.from(out), hex: false }
  }

  private hexString(): PdfObj {
    const { buf } = this
    const start = this.pos
    this.pos++ // <
    const digits: number[] = []
    while (true) {
      if (this.pos >= buf.length) throw new ContentParseError('Unterminated hex string', start)
      const c = buf[this.pos++]
      if (c === 0x3e) break
      if (isWs(c)) continue
      const h = hexVal(c)
      if (h < 0) throw new ContentParseError('Invalid character in hex string', this.pos - 1)
      digits.push(h)
    }
    if (digits.length % 2) digits.push(0)
    const out = new Uint8Array(digits.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = digits[2 * i] * 16 + digits[2 * i + 1]
    return { t: 'str', b: out, hex: true }
  }

  /** A value inside an array or dictionary. */
  value(depth: number): PdfObj {
    if (depth > MAX_DEPTH) throw new ContentParseError('Nesting too deep', this.pos)
    const at = this.pos
    const tok = this.next(depth)
    if (tok.k === 'obj') return tok.v
    throw new ContentParseError(tok.k === 'eof' ? 'Unexpected end of data' : `Unexpected "${tok.v}"`, at)
  }

  private arrayBody(depth: number): PdfObj {
    if (depth > MAX_DEPTH) throw new ContentParseError('Nesting too deep', this.pos)
    const items: PdfObj[] = []
    while (true) {
      const at = this.pos
      const tok = this.next(depth)
      if (tok.k === 'close') {
        if (tok.v === ']') return { t: 'arr', v: items }
        throw new ContentParseError('Unbalanced ">>" in array', at)
      }
      if (tok.k === 'obj') items.push(tok.v)
      else throw new ContentParseError(tok.k === 'eof' ? 'Unterminated array' : `Unexpected "${tok.v}" in array`, at)
    }
  }

  private dictBody(depth: number): PdfObj {
    if (depth > MAX_DEPTH) throw new ContentParseError('Nesting too deep', this.pos)
    const map = new Map<string, PdfObj>()
    while (true) {
      const at = this.pos
      const key = this.next(depth)
      if (key.k === 'close') {
        if (key.v === '>>') return { t: 'dict', v: map }
        throw new ContentParseError('Unbalanced "]" in dictionary', at)
      }
      if (key.k !== 'obj' || key.v.t !== 'name') {
        throw new ContentParseError(key.k === 'eof' ? 'Unterminated dictionary' : 'Dictionary key is not a name', at)
      }
      map.set(key.v.v, this.value(depth))
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Inline images

const inlineKey = (d: Map<string, PdfObj>, short: string, long: string): PdfObj | undefined => d.get(short) ?? d.get(long)

function componentsOf(cs: PdfObj | undefined): number {
  if (!cs) return 0
  if (cs.t === 'name') {
    switch (cs.v) {
      case 'G':
      case 'DeviceGray':
      case 'CalGray':
      case 'I':
      case 'Indexed':
        return 1
      case 'RGB':
      case 'DeviceRGB':
      case 'CalRGB':
        return 3
      case 'CMYK':
      case 'DeviceCMYK':
        return 4
    }
    return 0
  }
  if (cs.t === 'arr' && cs.v[0]?.t === 'name' && (cs.v[0].v === 'I' || cs.v[0].v === 'Indexed')) return 1
  return 0
}

function plainLength(d: Map<string, PdfObj>): number | null {
  if (inlineKey(d, 'F', 'Filter')) return null
  const w = inlineKey(d, 'W', 'Width')
  const h = inlineKey(d, 'H', 'Height')
  if (w?.t !== 'num' || h?.t !== 'num') return null
  const mask = inlineKey(d, 'IM', 'ImageMask')
  const isMask = mask?.t === 'bool' && mask.v
  const bpcObj = inlineKey(d, 'BPC', 'BitsPerComponent')
  const bpc = isMask ? 1 : bpcObj?.t === 'num' ? bpcObj.v : 0
  const comps = isMask ? 1 : componentsOf(inlineKey(d, 'CS', 'ColorSpace'))
  if (!bpc || !comps || w.v < 0 || h.v < 0) return null
  return Math.ceil((w.v * comps * bpc) / 8) * h.v
}

function looksLikeContent(buf: Uint8Array, from: number): boolean {
  const end = Math.min(buf.length, from + 12)
  for (let i = from; i < end; i++) {
    const c = buf[i]
    if (!(isWs(c) || (c >= 0x20 && c <= 0x7e))) return false
  }
  return true
}

/** Finds `EI` for an inline image whose data starts at `start`; returns [dataEnd, indexAfterEI]. */
function findInlineEnd(buf: Uint8Array, start: number, dict: Map<string, PdfObj>): [number, number] {
  const eiAt = (i: number): boolean =>
    buf[i] === 0x45 && buf[i + 1] === 0x49 && (i + 2 >= buf.length || isWs(buf[i + 2]) || isDelim(buf[i + 2])) && looksLikeContent(buf, i + 2)
  const len = plainLength(dict)
  if (len !== null && Number.isFinite(len) && start + len <= buf.length) {
    let i = start + len
    while (i < buf.length && isWs(buf[i])) i++
    if (eiAt(i)) return [start + len, i + 2]
  }
  for (let i = start; i + 1 < buf.length; i++) {
    if ((i === start || isWs(buf[i - 1])) && eiAt(i)) {
      return [i > start ? i - 1 : i, i + 2]
    }
  }
  throw new ContentParseError('Unterminated inline image', start)
}

// ---------------------------------------------------------------------------------------------------------
// Parser

export function parseContent(buf: Uint8Array): ParsedContent {
  const lx = new Lexer(buf)
  const ops: Op[] = []
  let args: PdfObj[] = []
  let prevEnd = 0
  let stmtStart = -1

  while (true) {
    lx.skipWs()
    if (lx.pos >= buf.length) break
    const tokStart = lx.pos
    const tok = lx.next()
    if (tok.k === 'eof') break
    if (tok.k === 'close') throw new ContentParseError(`Unbalanced "${tok.v}"`, tokStart)
    if (stmtStart < 0) stmtStart = tokStart
    if (tok.k === 'obj') {
      args.push(tok.v)
      continue
    }
    if (tok.v === 'BI') {
      const dict = new Map<string, PdfObj>()
      while (true) {
        const at = lx.pos
        const key = lx.next()
        if (key.k === 'kw' && key.v === 'ID') break
        if (key.k !== 'obj' || key.v.t !== 'name') throw new ContentParseError('Malformed inline image dictionary', at)
        dict.set(key.v.v, lx.value(1))
      }
      let ds = lx.pos
      if (ds < buf.length && isWs(buf[ds])) {
        if (buf[ds] === 13 && buf[ds + 1] === 10) ds++
        ds++
      }
      const [dataEnd, after] = findInlineEnd(buf, ds, dict)
      lx.pos = after
      ops.push({
        op: 'BI',
        args: [],
        pre: buf.subarray(prevEnd, stmtStart),
        raw: buf.subarray(stmtStart, after),
        inline: { dict, data: buf.subarray(ds, dataEnd) }
      })
      prevEnd = after
      stmtStart = -1
      args = []
      continue
    }
    ops.push({ op: tok.v, args, pre: buf.subarray(prevEnd, stmtStart), raw: buf.subarray(stmtStart, lx.pos) })
    prevEnd = lx.pos
    stmtStart = -1
    args = []
  }
  // Dangling operands (or trailing whitespace/comments) are kept verbatim.
  return { ops, tail: buf.subarray(prevEnd) }
}

// ---------------------------------------------------------------------------------------------------------
// Serializer

class Writer {
  private chunks: Uint8Array[] = []
  private cur = new Uint8Array(4096)
  private n = 0
  byte(b: number): void {
    if (this.n === this.cur.length) this.flush()
    this.cur[this.n++] = b
  }
  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i))
  }
  bytes(b: Uint8Array): void {
    if (b.length > 2048) {
      this.flush()
      this.chunks.push(b)
    } else for (let i = 0; i < b.length; i++) this.byte(b[i])
  }
  private flush(): void {
    if (this.n) this.chunks.push(this.cur.slice(0, this.n))
    this.n = 0
  }
  result(): Uint8Array {
    this.flush()
    let total = 0
    for (const c of this.chunks) total += c.length
    const out = new Uint8Array(total)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
}

/** PDF number syntax (no exponents), at most 10 decimals. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new ContentParseError(`Cannot write the number ${n}`)
  if (Number.isInteger(n)) return String(n)
  const s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' || s === '' ? '0' : s
}

const NAME_SAFE = (c: number): boolean => c > 0x20 && c < 0x7f && !isDelim(c) && c !== 0x23

function writeObj(w: Writer, o: PdfObj): void {
  switch (o.t) {
    case 'num':
      w.ascii(fmtNum(o.v))
      return
    case 'bool':
      w.ascii(o.v ? 'true' : 'false')
      return
    case 'null':
      w.ascii('null')
      return
    case 'name': {
      w.byte(0x2f)
      // Names are byte strings; anything beyond Latin-1 is written as UTF-8.
      const bytes = /^[\u0000-ÿ]*$/.test(o.v) ? latin1ToBytes(o.v) : new TextEncoder().encode(o.v)
      for (const c of bytes) {
        if (NAME_SAFE(c)) w.byte(c)
        else w.ascii('#' + c.toString(16).padStart(2, '0').toUpperCase())
      }
      return
    }
    case 'str':
      if (o.hex) {
        w.byte(0x3c)
        for (const b of o.b) w.ascii(b.toString(16).padStart(2, '0').toUpperCase())
        w.byte(0x3e)
      } else {
        w.byte(0x28)
        for (const b of o.b) {
          if (b === 0x28 || b === 0x29 || b === 0x5c) {
            w.byte(0x5c)
            w.byte(b)
          } else if (b >= 0x20 && b < 0x7f) w.byte(b)
          else {
            w.byte(0x5c)
            w.ascii(b.toString(8).padStart(3, '0'))
          }
        }
        w.byte(0x29)
      }
      return
    case 'arr':
      w.byte(0x5b)
      o.v.forEach((x, i) => {
        if (i) w.byte(0x20)
        writeObj(w, x)
      })
      w.byte(0x5d)
      return
    case 'dict':
      w.ascii('<<')
      for (const [k, v] of o.v) {
        w.byte(0x20)
        writeObj(w, { t: 'name', v: k })
        w.byte(0x20)
        writeObj(w, v)
      }
      w.ascii(' >>')
  }
}

function writeOp(w: Writer, op: Op): void {
  if (op.op === 'BI' && op.inline) {
    w.ascii('BI')
    for (const [k, v] of op.inline.dict) {
      w.byte(0x20)
      writeObj(w, { t: 'name', v: k })
      w.byte(0x20)
      writeObj(w, v)
    }
    w.ascii('\nID\n')
    w.bytes(op.inline.data)
    w.ascii('\nEI')
    return
  }
  if (!/^[^\s()<>[\]{}/%]+$/.test(op.op)) throw new ContentParseError(`Invalid operator "${op.op}"`)
  op.args.forEach((a) => {
    writeObj(w, a)
    w.byte(0x20)
  })
  w.ascii(op.op)
}

export function serializeContent(ops: readonly Op[], tail: Uint8Array = new Uint8Array(0)): Uint8Array {
  const w = new Writer()
  for (const op of ops) {
    w.bytes(op.pre)
    if (op.raw) w.bytes(op.raw)
    else writeOp(w, op)
  }
  w.bytes(tail)
  return w.result()
}

/** Serializes a single operand (for tests and debugging). */
export function formatObj(o: PdfObj): string {
  const w = new Writer()
  writeObj(w, o)
  return bytesToLatin1(w.result())
}

/** One operation as text, e.g. `1 0 0 1 72 700 cm` (inline image data is elided). */
export function formatOp(op: Op): string {
  if (op.op === 'BI' && op.inline) return `BI ${[...op.inline.dict].map(([k, v]) => `/${k} ${formatObj(v)}`).join(' ')} ID <${op.inline.data.length} bytes> EI`
  return [...op.args.map(formatObj), op.op].join(' ')
}

// ---------------------------------------------------------------------------------------------------------
// Small accessors

export const isNum = (o: PdfObj | undefined): o is { t: 'num'; v: number } => o?.t === 'num'
export const isStr = (o: PdfObj | undefined): o is { t: 'str'; b: Uint8Array; hex: boolean } => o?.t === 'str'
export const isName = (o: PdfObj | undefined): o is { t: 'name'; v: string } => o?.t === 'name'
export const numArg = (op: Op, i: number): number => {
  const a = op.args[i]
  if (a?.t !== 'num') throw new ContentParseError(`Operator ${op.op} expects a number as operand ${i + 1}`)
  return a.v
}

/** Structural equality of two operands (used by round-trip tests). */
export function objEquals(a: PdfObj, b: PdfObj, eps = 0): boolean {
  if (a.t !== b.t) return false
  switch (a.t) {
    case 'num':
      return Math.abs(a.v - (b as typeof a).v) <= eps
    case 'bool':
      return a.v === (b as typeof a).v
    case 'name':
      return a.v === (b as typeof a).v
    case 'null':
      return true
    case 'str': {
      const bb = (b as typeof a).b
      return a.b.length === bb.length && a.b.every((x, i) => x === bb[i])
    }
    case 'arr': {
      const bv = (b as typeof a).v
      return a.v.length === bv.length && a.v.every((x, i) => objEquals(x, bv[i], eps))
    }
    case 'dict': {
      const bv = (b as typeof a).v
      if (a.v.size !== bv.size) return false
      for (const [k, v] of a.v) {
        const o = bv.get(k)
        if (!o || !objEquals(v, o, eps)) return false
      }
      return true
    }
  }
}
