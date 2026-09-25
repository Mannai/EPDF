import { ContentParseError, parseContent, type PdfObj } from './content'

/**
 * A small CMap reader for /ToUnicode streams and embedded /Encoding CMaps: code space ranges, `bfchar`,
 * `bfrange`, `cidchar` and `cidrange`. PostScript wrapper code is skipped (the content tokenizer reads it as
 * operators, which we ignore).
 */

export interface CodeSpaceRange {
  /** Number of bytes in a code of this range. */
  n: number
  lo: number
  hi: number
}

interface BfRange {
  lo: number
  hi: number
  n: number
  dst: string | string[]
}

interface CidRange {
  lo: number
  hi: number
  n: number
  cid: number
}

export interface CMap {
  codespace: CodeSpaceRange[]
  /** Individual bfchar (and small expanded bfrange) mappings: key = `n * 2**32 + code`. */
  bf: Map<number, string>
  bfRanges: BfRange[]
  cidRanges: CidRange[]
  cidChars: Map<number, number>
  useCMap?: string
  wmode: 0 | 1
}

const key = (n: number, code: number): number => n * 0x100000000 + code

const bytesToNumber = (b: Uint8Array): number => {
  let v = 0
  for (const x of b) v = v * 256 + x
  return v
}

/** UTF-16BE bytes to a string (a 1-byte destination is treated as a Latin-1 code). */
export function utf16beToString(b: Uint8Array): string {
  if (b.length === 1) return String.fromCharCode(b[0])
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1])
  return s
}

const strArg = (o: PdfObj | undefined): Uint8Array | null => (o?.t === 'str' ? o.b : null)

/** Increments the last UTF-16 unit of a bfrange destination. */
function incrementDst(s: string, by: number): string {
  if (!s) return s
  return s.slice(0, -1) + String.fromCharCode((s.charCodeAt(s.length - 1) + by) & 0xffff)
}

export function parseCMap(bytes: Uint8Array): CMap {
  const cm: CMap = { codespace: [], bf: new Map(), bfRanges: [], cidRanges: [], cidChars: new Map(), wmode: 0 }
  let ops
  try {
    ops = parseContent(bytes).ops
  } catch (e) {
    if (e instanceof ContentParseError) throw new ContentParseError(`Unreadable CMap: ${e.message}`)
    throw e
  }
  let expanded = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const a = op.args
    switch (op.op) {
      case 'endcodespacerange':
        for (let k = 0; k + 1 < a.length; k += 2) {
          const lo = strArg(a[k])
          const hi = strArg(a[k + 1])
          if (lo && hi && lo.length === hi.length && lo.length >= 1 && lo.length <= 4) {
            cm.codespace.push({ n: lo.length, lo: bytesToNumber(lo), hi: bytesToNumber(hi) })
          }
        }
        break
      case 'endbfchar':
        for (let k = 0; k + 1 < a.length; k += 2) {
          const src = strArg(a[k])
          const dst = strArg(a[k + 1])
          if (src && dst) cm.bf.set(key(src.length, bytesToNumber(src)), utf16beToString(dst))
        }
        break
      case 'endbfrange':
        for (let k = 0; k + 2 < a.length; k += 3) {
          const lo = strArg(a[k])
          const hi = strArg(a[k + 1])
          const d = a[k + 2]
          if (!lo || !hi) continue
          const n = lo.length
          const l = bytesToNumber(lo)
          const h = bytesToNumber(hi)
          if (h < l) continue
          let dst: string | string[] | null = null
          if (d?.t === 'str') dst = utf16beToString(d.b)
          else if (d?.t === 'arr') dst = d.v.map((x) => (x.t === 'str' ? utf16beToString(x.b) : ''))
          if (dst === null) continue
          if (h - l < 512 && expanded < 200000) {
            for (let c = l; c <= h; c++) {
              cm.bf.set(key(n, c), Array.isArray(dst) ? (dst[c - l] ?? '') : incrementDst(dst, c - l))
              expanded++
            }
          } else cm.bfRanges.push({ lo: l, hi: h, n, dst })
        }
        break
      case 'endcidchar':
        for (let k = 0; k + 1 < a.length; k += 2) {
          const src = strArg(a[k])
          const cid = a[k + 1]
          if (src && cid?.t === 'num') cm.cidChars.set(key(src.length, bytesToNumber(src)), cid.v)
        }
        break
      case 'endcidrange':
        for (let k = 0; k + 2 < a.length; k += 3) {
          const lo = strArg(a[k])
          const hi = strArg(a[k + 1])
          const cid = a[k + 2]
          if (lo && hi && cid?.t === 'num') cm.cidRanges.push({ lo: bytesToNumber(lo), hi: bytesToNumber(hi), n: lo.length, cid: cid.v })
        }
        break
      case 'usecmap':
        if (a[a.length - 1]?.t === 'name') cm.useCMap = (a[a.length - 1] as { v: string }).v
        break
      case 'def':
        if (a.length >= 2 && a[a.length - 2].t === 'name' && (a[a.length - 2] as { v: string }).v === 'WMode' && a[a.length - 1].t === 'num') {
          cm.wmode = (a[a.length - 1] as { v: number }).v === 1 ? 1 : 0
        }
        break
    }
  }
  return cm
}

/** Unicode text for a code, or undefined if the CMap has no mapping for it. */
export function cmapUnicode(cm: CMap, code: number, n: number): string | undefined {
  const hit = cm.bf.get(key(n, code))
  if (hit !== undefined) return hit
  for (const r of cm.bfRanges) {
    if (r.n === n && code >= r.lo && code <= r.hi) return Array.isArray(r.dst) ? r.dst[code - r.lo] : incrementDst(r.dst, code - r.lo)
  }
  return undefined
}

/** CID for a code using cidchar/cidrange mappings, or undefined. */
export function cmapCid(cm: CMap, code: number, n: number): number | undefined {
  const hit = cm.cidChars.get(key(n, code))
  if (hit !== undefined) return hit
  for (const r of cm.cidRanges) if (r.n === n && code >= r.lo && code <= r.hi) return r.cid + (code - r.lo)
  return undefined
}

/** Every (code, n, text) mapping the CMap lists explicitly, for building the reverse (Unicode → code) table. */
export function cmapEntries(cm: CMap): { code: number; n: number; text: string }[] {
  const out: { code: number; n: number; text: string }[] = []
  for (const [k, text] of cm.bf) out.push({ n: Math.floor(k / 0x100000000), code: k % 0x100000000, text })
  for (const r of cm.bfRanges) {
    if (r.hi - r.lo > 70000) continue
    for (let c = r.lo; c <= r.hi; c++) out.push({ code: c, n: r.n, text: Array.isArray(r.dst) ? (r.dst[c - r.lo] ?? '') : incrementDst(r.dst, c - r.lo) })
  }
  return out
}

/**
 * Splits a string into codes using the code space ranges (defaults to `defaultBytes`-byte codes when the
 * CMap declares none). Returns [code, byteLength] pairs; bytes that fit no range are consumed one at a time.
 */
export function splitCodes(b: Uint8Array, space: readonly CodeSpaceRange[], defaultBytes: number): [number, number][] {
  const out: [number, number][] = []
  if (space.length === 0) {
    for (let i = 0; i < b.length; i += defaultBytes) {
      const n = Math.min(defaultBytes, b.length - i)
      out.push([bytesToNumber(b.subarray(i, i + n)), n])
    }
    return out
  }
  const maxN = Math.max(...space.map((s) => s.n))
  let i = 0
  while (i < b.length) {
    let matched = false
    for (let n = 1; n <= Math.min(maxN, b.length - i) && !matched; n++) {
      const code = bytesToNumber(b.subarray(i, i + n))
      if (space.some((s) => s.n === n && byteRangeContains(s, code))) {
        out.push([code, n])
        i += n
        matched = true
      }
    }
    if (!matched) {
      const n = Math.min(space[0].n, b.length - i)
      out.push([bytesToNumber(b.subarray(i, i + n)), n])
      i += n
    }
  }
  return out
}

/** Every byte of the code must lie within the corresponding bytes of lo..hi (per PDF code space semantics). */
function byteRangeContains(s: CodeSpaceRange, code: number): boolean {
  for (let k = 0; k < s.n; k++) {
    const shift = 8 * (s.n - 1 - k)
    const cb = Math.floor(code / 2 ** shift) % 256
    const lb = Math.floor(s.lo / 2 ** shift) % 256
    const hb = Math.floor(s.hi / 2 ** shift) % 256
    if (cb < lb || cb > hb) return false
  }
  return true
}
