/**
 * Cluster glyph synthesis for TrueType (glyf) fonts.
 *
 * A shaped cluster is often several glyphs: a base letter with its dot/vowel marks placed by GPOS, Devanagari
 * conjunct pieces, reordered vowel signs. Drawn as separate glyphs they extract as garbage (the extra glyphs have no
 * Unicode of their own) and need vertical repositioning that text extractors read as line breaks.
 *
 * So each such cluster becomes ONE new glyph appended to the font subset: a composite glyph whose components are the
 * shaped glyphs at their exact offsets. The PDF then draws one glyph per cluster, the /ToUnicode entry of that glyph
 * is the cluster's whole source text ("مُ", "क्षि", ...), and extraction returns logical text.
 */

export interface CompositeSpec {
  /** Components in drawing order; offsets in font units relative to the cluster origin (y up). */
  components: { gid: number; dx: number; dy: number }[]
  /** Advance width of the new glyph in font units. */
  advance: number
}

class Reader {
  constructor(readonly b: Uint8Array) {}
  u16(o: number): number {
    return (this.b[o]! << 8) | this.b[o + 1]!
  }
  i16(o: number): number {
    return (this.u16(o) << 16) >> 16
  }
  u32(o: number): number {
    return ((this.b[o]! << 24) | (this.b[o + 1]! << 16) | (this.b[o + 2]! << 8) | this.b[o + 3]!) >>> 0
  }
}

function put16(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >> 8) & 0xff
  b[o + 1] = v & 0xff
}
function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff
  b[o + 1] = (v >>> 16) & 0xff
  b[o + 2] = (v >>> 8) & 0xff
  b[o + 3] = v & 0xff
}

function parseTables(font: Uint8Array): Map<string, Uint8Array> {
  const r = new Reader(font)
  const n = r.u16(4)
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    const tag = String.fromCharCode(font[o]!, font[o + 1]!, font[o + 2]!, font[o + 3]!)
    const off = r.u32(o + 8)
    const len = r.u32(o + 12)
    tables.set(tag, font.slice(off, off + len))
  }
  return tables
}

function checksum(b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i += 4) {
    sum = (sum + (((b[i] ?? 0) * 0x1000000 + (b[i + 1] ?? 0) * 0x10000 + (b[i + 2] ?? 0) * 0x100 + (b[i + 3] ?? 0)) >>> 0)) >>> 0
  }
  return sum
}

function buildFont(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort()
  const n = tags.length
  let entrySelector = 0
  while (1 << (entrySelector + 1) <= n) entrySelector++
  const searchRange = (1 << entrySelector) * 16
  let offset = 12 + n * 16
  const placed = tags.map((tag) => {
    const data = tables.get(tag)!
    const at = offset
    offset += Math.ceil(data.length / 4) * 4
    return { tag, data, at }
  })
  const out = new Uint8Array(offset)
  put32(out, 0, 0x00010000)
  put16(out, 4, n)
  put16(out, 6, searchRange)
  put16(out, 8, entrySelector)
  put16(out, 10, n * 16 - searchRange)
  placed.forEach((p, i) => {
    const o = 12 + i * 16
    for (let k = 0; k < 4; k++) out[o + k] = p.tag.charCodeAt(k)
    put32(out, o + 4, checksum(p.data))
    put32(out, o + 8, p.at)
    put32(out, o + 12, p.data.length)
    out.set(p.data, p.at)
  })
  const head = placed.find((p) => p.tag === 'head')
  if (head) {
    put32(out, head.at + 8, 0)
    put32(out, head.at + 8, (0xb1b0afba - checksum(out)) >>> 0)
  }
  return out
}

/**
 * Append composite glyphs to a TrueType font (glyf outlines). New glyph ids are baseGid, baseGid + 1, ...; glyph ids
 * between the font's current glyph count and baseGid become empty glyphs (a subset made with retained glyph ids may
 * have dropped trailing glyphs). Throws for fonts without glyf outlines.
 */
export function appendComposites(font: Uint8Array, specs: CompositeSpec[], baseGid: number): Uint8Array {
  const tables = parseTables(font)
  const glyf = tables.get('glyf')
  const loca = tables.get('loca')
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const hhea = tables.get('hhea')
  const hmtx = tables.get('hmtx')
  if (!glyf || !loca || !head || !maxp || !hhea || !hmtx) throw new Error('Font has no TrueType outlines')
  const rh = new Reader(head)
  const rm = new Reader(maxp)
  const numGlyphs = rm.u16(4)
  if (baseGid < numGlyphs) throw new Error('baseGid must not be below the font glyph count')
  const longLoca = rh.i16(50) === 1
  const rl = new Reader(loca)
  const offsets: number[] = []
  for (let i = 0; i <= numGlyphs; i++) offsets.push(longLoca ? rl.u32(i * 4) : rl.u16(i * 2) * 2)
  const rg = new Reader(glyf)
  const bboxOf = (gid: number): [number, number, number, number] | null => {
    if (gid >= numGlyphs) return null
    const a = offsets[gid]!
    const b = offsets[gid + 1]!
    if (b - a < 10) return null
    return [rg.i16(a + 2), rg.i16(a + 4), rg.i16(a + 6), rg.i16(a + 8)]
  }

  const records: Uint8Array[] = []
  const boxes: ([number, number, number, number] | null)[] = []
  for (const spec of specs) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const comps = spec.components.filter((c) => bboxOf(c.gid) !== null)
    for (const c of comps) {
      const bb = bboxOf(c.gid)!
      x0 = Math.min(x0, bb[0] + c.dx)
      y0 = Math.min(y0, bb[1] + c.dy)
      x1 = Math.max(x1, bb[2] + c.dx)
      y1 = Math.max(y1, bb[3] + c.dy)
    }
    if (comps.length === 0) {
      records.push(new Uint8Array(0))
      boxes.push(null)
      continue
    }
    const size = 10 + comps.length * 8
    const rec = new Uint8Array(Math.ceil(size / 4) * 4)
    put16(rec, 0, 0xffff) // numberOfContours = -1: composite
    put16(rec, 2, x0 & 0xffff)
    put16(rec, 4, y0 & 0xffff)
    put16(rec, 6, x1 & 0xffff)
    put16(rec, 8, y1 & 0xffff)
    let o = 10
    comps.forEach((c, i) => {
      // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES | (MORE_COMPONENTS)
      put16(rec, o, 0x0001 | 0x0002 | (i < comps.length - 1 ? 0x0020 : 0))
      put16(rec, o + 2, c.gid)
      put16(rec, o + 4, Math.round(c.dx) & 0xffff)
      put16(rec, o + 6, Math.round(c.dy) & 0xffff)
      o += 8
    })
    records.push(rec)
    boxes.push([x0, y0, x1, y1])
  }

  // glyf + loca
  let newGlyfLen = glyf.length
  const newOffsets = [...offsets]
  for (let g = numGlyphs; g < baseGid; g++) newOffsets.push(newGlyfLen) // padding: empty glyphs
  for (const rec of records) {
    newGlyfLen += rec.length
    newOffsets.push(newGlyfLen)
  }
  const needLong = longLoca || newGlyfLen > 0x1fffe || newOffsets.some((v) => v & 1)
  const newGlyf = new Uint8Array(newGlyfLen)
  newGlyf.set(glyf, 0)
  let at = glyf.length
  for (const rec of records) {
    newGlyf.set(rec, at)
    at += rec.length
  }
  const totalGlyphs = baseGid + specs.length
  const newLoca = new Uint8Array((totalGlyphs + 1) * (needLong ? 4 : 2))
  newOffsets.forEach((v, i) => (needLong ? put32(newLoca, i * 4, v) : put16(newLoca, i * 2, v >> 1)))
  const newHead = head.slice()
  put16(newHead, 50, needLong ? 1 : 0)

  // hmtx: rebuild with a full (advance, lsb) entry for every glyph
  const rhh = new Reader(hhea)
  const nHM = rhh.u16(34)
  const rhm = new Reader(hmtx)
  const newHmtx = new Uint8Array(totalGlyphs * 4)
  let lastAdv = 0
  for (let g = 0; g < numGlyphs; g++) {
    let adv: number
    let lsb: number
    if (g < nHM) {
      adv = rhm.u16(g * 4)
      lsb = rhm.i16(g * 4 + 2)
      lastAdv = adv
    } else {
      adv = lastAdv
      const o = nHM * 4 + (g - nHM) * 2
      lsb = o + 1 < hmtx.length ? rhm.i16(o) : 0
    }
    put16(newHmtx, g * 4, adv)
    put16(newHmtx, g * 4 + 2, lsb & 0xffff)
  }
  specs.forEach((s, i) => {
    put16(newHmtx, (baseGid + i) * 4, Math.max(0, Math.round(s.advance)))
    put16(newHmtx, (baseGid + i) * 4 + 2, (boxes[i]?.[0] ?? 0) & 0xffff)
  })
  const newHhea = hhea.slice()
  put16(newHhea, 34, totalGlyphs)

  const newMaxp = maxp.slice()
  put16(newMaxp, 4, totalGlyphs)
  if (newMaxp.length >= 32) {
    const maxElems = Math.max(rm.u16(28), ...specs.map((s) => s.components.length))
    put16(newMaxp, 28, maxElems)
    put16(newMaxp, 30, Math.max(rm.u16(30), 2))
    put16(newMaxp, 10, Math.max(rm.u16(10), rm.u16(6) * 3, 300))
    put16(newMaxp, 12, Math.max(rm.u16(12), rm.u16(8) * 3, 30))
  }

  tables.set('glyf', newGlyf)
  tables.set('loca', newLoca)
  tables.set('head', newHead)
  tables.set('hmtx', newHmtx)
  tables.set('hhea', newHhea)
  tables.set('maxp', newMaxp)
  return buildFont(tables)
}
