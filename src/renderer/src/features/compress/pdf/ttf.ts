/**
 * TrueType glyph pruning ("subsetting that keeps glyph ids").
 *
 * A PDF that embeds a whole font (e.g. all 4000 glyphs of Noto Sans for a page that uses 40) can be shrunk without touching
 * the text in the document: the content stream addresses glyphs by id, so we keep every id but give the unused glyphs an
 * empty outline, and drop tables a PDF renderer never reads (GSUB, GPOS, GDEF, kern, ...). Used glyphs, including the parts
 * of composite glyphs (accented letters), are copied byte for byte.
 */

// hdmx / VDMX / LTSH (per-size metrics) stay: FreeType uses them when it hints, so without them the pruned font
// rendered a little differently on Linux than the original.
const DROP = new Set(['GSUB', 'GPOS', 'GDEF', 'DSIG', 'kern', 'JSTF', 'BASE', 'MATH'])
/** Colour / bitmap glyph tables: pruning outlines would break them, so such fonts are left alone. */
const COLOUR = new Set(['COLR', 'CPAL', 'SVG ', 'sbix', 'CBDT', 'CBLC', 'EBDT', 'EBLC', 'EBSC', 'CFF ', 'CFF2', 'fvar', 'gvar'])

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1]
const i16 = (b: Uint8Array, o: number): number => (u16(b, o) << 16) >> 16
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

const tagOf = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])

export interface Sfnt {
  scaler: number
  tables: Map<string, Uint8Array>
}

export function parseSfnt(b: Uint8Array): Sfnt | null {
  if (b.length < 12) return null
  const scaler = u32(b, 0)
  if (scaler !== 0x00010000 && scaler !== 0x74727565) return null // plain TrueType only (not OpenType/CFF, not a collection)
  const n = u16(b, 4)
  if (n === 0 || n > 64 || 12 + n * 16 > b.length) return null
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    const off = u32(b, o + 8)
    const len = u32(b, o + 12)
    if (off + len > b.length) return null
    tables.set(tagOf(b, o), b.subarray(off, off + len))
  }
  return { scaler, tables }
}

function checksum(b: Uint8Array): number {
  let sum = 0
  const n = b.length & ~3
  for (let i = 0; i < n; i += 4) sum = (sum + u32(b, i)) >>> 0
  if (b.length & 3) {
    let last = 0
    for (let i = 0; i < 4; i++) last = (last << 8) | (n + i < b.length ? b[n + i] : 0)
    sum = (sum + (last >>> 0)) >>> 0
  }
  return sum
}

/** Glyph ids that make up glyph `gid` (itself plus, for composite glyphs, all components, transitively). */
function closure(glyf: Uint8Array, offsets: number[], gids: Iterable<number>, numGlyphs: number): Set<number> | null {
  const out = new Set<number>()
  const stack = [...gids]
  while (stack.length) {
    const g = stack.pop()!
    if (g < 0 || g >= numGlyphs) return null
    if (out.has(g)) continue
    out.add(g)
    const start = offsets[g]
    const end = offsets[g + 1]
    if (end - start < 10) continue
    if (i16(glyf, start) >= 0) continue
    let p = start + 10
    for (let guard = 0; guard < 512; guard++) {
      if (p + 4 > end) return null
      const flags = u16(glyf, p)
      stack.push(u16(glyf, p + 2))
      p += 4
      p += flags & 0x1 ? 4 : 2
      if (flags & 0x8) p += 2
      else if (flags & 0x40) p += 4
      else if (flags & 0x80) p += 8
      if (!(flags & 0x20)) break
    }
  }
  return out
}

export interface PruneResult {
  bytes: Uint8Array
  glyphsKept: number
  glyphsTotal: number
}

/** Rebuilds the font keeping only the outlines of `keep` (glyph 0 is always kept). Null if the font is not something we can prune safely. */
export function pruneTrueType(font: Uint8Array, keep: Iterable<number>): PruneResult | null {
  const sfnt = parseSfnt(font)
  if (!sfnt) return null
  const { tables } = sfnt
  for (const t of COLOUR) if (tables.has(t)) return null
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  if (!head || !maxp || !loca || !glyf || head.length < 54 || maxp.length < 6) return null
  const numGlyphs = u16(maxp, 4)
  const longLoca = i16(head, 50) === 1
  if (loca.length < (numGlyphs + 1) * (longLoca ? 4 : 2)) return null
  const offsets: number[] = []
  for (let i = 0; i <= numGlyphs; i++) offsets.push(longLoca ? u32(loca, i * 4) : u16(loca, i * 2) * 2)
  for (let i = 0; i < numGlyphs; i++) if (offsets[i + 1] < offsets[i] || offsets[i + 1] > glyf.length) return null
  const wanted = closure(glyf, offsets, [0, ...keep], numGlyphs)
  if (!wanted) return null

  // new glyf + loca (long format)
  const chunks: Uint8Array[] = []
  const newLoca = new Uint8Array((numGlyphs + 1) * 4)
  const dv = new DataView(newLoca.buffer)
  let pos = 0
  for (let g = 0; g < numGlyphs; g++) {
    dv.setUint32(g * 4, pos)
    if (wanted.has(g) && offsets[g + 1] > offsets[g]) {
      const data = glyf.subarray(offsets[g], offsets[g + 1])
      const padded = (data.length + 3) & ~3
      const c = new Uint8Array(padded)
      c.set(data)
      chunks.push(c)
      pos += padded
    }
  }
  dv.setUint32(numGlyphs * 4, pos)
  const newGlyf = new Uint8Array(pos)
  let o = 0
  for (const c of chunks) (newGlyf.set(c, o), (o += c.length))
  const newHead = head.slice()
  newHead[50] = 0
  newHead[51] = 1
  newHead.fill(0, 8, 12) // checkSumAdjustment: recomputed below

  const out = new Map<string, Uint8Array>()
  for (const [tag, data] of tables) if (!DROP.has(tag)) out.set(tag, data)
  out.set('glyf', newGlyf)
  out.set('loca', newLoca)
  out.set('head', newHead)
  const tags = [...out.keys()].sort()
  const n = tags.length
  let sr = 1
  let es = 0
  while (sr * 2 <= n) (sr *= 2, es++)
  const dirLen = 12 + n * 16
  let total = dirLen
  for (const t of tags) total += (out.get(t)!.length + 3) & ~3
  const file = new Uint8Array(total)
  const fdv = new DataView(file.buffer)
  fdv.setUint32(0, sfnt.scaler)
  fdv.setUint16(4, n)
  fdv.setUint16(6, sr * 16)
  fdv.setUint16(8, es)
  fdv.setUint16(10, n * 16 - sr * 16)
  let off = dirLen
  tags.forEach((t, i) => {
    const d = out.get(t)!
    const e = 12 + i * 16
    for (let k = 0; k < 4; k++) file[e + k] = t.charCodeAt(k)
    fdv.setUint32(e + 4, checksum(d))
    fdv.setUint32(e + 8, off)
    fdv.setUint32(e + 12, d.length)
    file.set(d, off)
    off += (d.length + 3) & ~3
  })
  const adj = (0xb1b0afba - checksum(file)) >>> 0
  const headOff = fdv.getUint32(12 + tags.indexOf('head') * 16 + 8)
  fdv.setUint32(headOff + 8, adj)
  return { bytes: file, glyphsKept: wanted.size, glyphsTotal: numGlyphs }
}
