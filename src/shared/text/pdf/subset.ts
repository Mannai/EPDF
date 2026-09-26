import { loadResource } from '../env'

/**
 * Font subsetting with HarfBuzz's subsetter (harfbuzz-subset.wasm from harfbuzzjs, MIT): keeps only the glyphs a
 * document uses, for both TrueType (glyf) and CFF outlines, with glyph ids preserved so PDF character codes are
 * simply glyph ids.
 */

interface SubsetExports {
  memory: WebAssembly.Memory
  malloc(n: number): number
  free(p: number): void
  _initialize?(): void
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number
  hb_blob_destroy(b: number): void
  hb_blob_get_length(b: number): number
  hb_blob_get_data(b: number, lenPtr: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy(f: number): void
  hb_face_reference_blob(f: number): number
  hb_set_add(s: number, v: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(i: number): void
  hb_subset_input_glyph_set(i: number): number
  hb_subset_input_set(i: number, setType: number): number
  hb_subset_input_set_flags(i: number, flags: number): void
  hb_subset_input_pin_all_axes_to_default(i: number, face: number): number
  hb_subset_or_fail(face: number, input: number): number
}

const FLAG_NO_HINTING = 0x1
const FLAG_RETAIN_GIDS = 0x2
const FLAG_NOTDEF_OUTLINE = 0x40
const SET_DROP_TABLE_TAG = 4
const tag = (s: string): number => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)

let instance: Promise<SubsetExports> | null = null

function subsetter(): Promise<SubsetExports> {
  instance ??= loadResource('text/harfbuzz-subset.wasm')
    .then(async (bytes) => {
      const { instance: inst } = await WebAssembly.instantiate(bytes as BufferSource, {})
      const x = inst.exports as unknown as SubsetExports
      x._initialize?.()
      return x
    })
    .catch((e) => {
      instance = null
      throw e
    })
  return instance
}

/** Tables never needed inside a PDF font (layout is done before drawing; the PDF only positions glyphs). */
const DROP_TABLES = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'MATH', 'kern', 'morx', 'mort', 'feat', 'ankr', 'kerx', 'trak', 'STAT', 'avar', 'DSIG', 'gasp', 'meta', 'SVG ', 'CBDT', 'CBLC', 'sbix', 'COLR', 'CPAL']

export interface SubsetOptions {
  /** Glyph ids to keep (plus .notdef and composite components, added automatically). */
  glyphs: Iterable<number>
  /** Keep glyph ids unchanged (default). False lets the subsetter renumber; only for CID-keyed CFF, where PDF codes are CIDs. */
  retainGids?: boolean
}

/** Returns a font file containing only `glyphs` (glyph ids unchanged; every other glyph is empty). */
export async function subsetFont(font: Uint8Array, opts: SubsetOptions): Promise<Uint8Array> {
  const x = await subsetter()
  const heap = (): Uint8Array => new Uint8Array(x.memory.buffer)
  const dataPtr = x.malloc(font.length)
  heap().set(font, dataPtr)
  const blob = x.hb_blob_create(dataPtr, font.length, 0 /* DUPLICATE */, 0, 0)
  const face = x.hb_face_create(blob, 0)
  const input = x.hb_subset_input_create_or_fail()
  if (!input) throw new Error('subset input allocation failed')
  try {
    const gs = x.hb_subset_input_glyph_set(input)
    x.hb_set_add(gs, 0)
    for (const g of opts.glyphs) x.hb_set_add(gs, g)
    x.hb_subset_input_set_flags(input, FLAG_NO_HINTING | FLAG_NOTDEF_OUTLINE | (opts.retainGids === false ? 0 : FLAG_RETAIN_GIDS))
    const drop = x.hb_subset_input_set(input, SET_DROP_TABLE_TAG)
    for (const t of DROP_TABLES) x.hb_set_add(drop, tag(t))
    x.hb_subset_input_pin_all_axes_to_default(input, face)
    const sub = x.hb_subset_or_fail(face, input)
    if (!sub) throw new Error('Font subsetting failed (the font may be damaged or use an unsupported format)')
    const outBlob = x.hb_face_reference_blob(sub)
    const len = x.hb_blob_get_length(outBlob)
    const ptr = x.hb_blob_get_data(outBlob, 0)
    const out = heap().slice(ptr, ptr + len)
    x.hb_blob_destroy(outBlob)
    x.hb_face_destroy(sub)
    return out
  } finally {
    x.hb_subset_input_destroy(input)
    x.hb_face_destroy(face)
    x.hb_blob_destroy(blob)
    x.free(dataPtr)
  }
}

// ---- SFNT table access (used to pull the CFF table out of an OpenType font) ----------------------------------

export function sfntTable(font: Uint8Array, name: string): Uint8Array | undefined {
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const n = dv.getUint16(4)
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    const t = String.fromCharCode(font[o]!, font[o + 1]!, font[o + 2]!, font[o + 3]!)
    if (t === name) {
      const off = dv.getUint32(o + 8)
      const len = dv.getUint32(o + 12)
      return font.subarray(off, off + len)
    }
  }
  return undefined
}

// ---- CFF: glyph id -> CID (CID-keyed fonts) ------------------------------------------------------------------

function cffIndex(b: Uint8Array, pos: number): { count: number; offsets: number[]; dataStart: number; end: number } {
  const count = (b[pos]! << 8) | b[pos + 1]!
  if (count === 0) return { count: 0, offsets: [], dataStart: pos + 2, end: pos + 2 }
  const offSize = b[pos + 2]!
  const offsets: number[] = []
  let p = pos + 3
  for (let i = 0; i <= count; i++) {
    let v = 0
    for (let k = 0; k < offSize; k++) v = v * 256 + b[p++]!
    offsets.push(v)
  }
  const dataStart = p - 1
  return { count, offsets, dataStart, end: dataStart + offsets[count]! }
}

function parseDict(b: Uint8Array, s: number, e: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let operands: number[] = []
  let p = s
  while (p < e) {
    const v = b[p]!
    if (v <= 21) {
      let op = v
      p++
      if (v === 12) {
        op = 1200 + b[p]!
        p++
      }
      out.set(op, operands)
      operands = []
    } else if (v === 28) {
      operands.push((((b[p + 1]! << 8) | b[p + 2]!) << 16) >> 16)
      p += 3
    } else if (v === 29) {
      operands.push((b[p + 1]! << 24) | (b[p + 2]! << 16) | (b[p + 3]! << 8) | b[p + 4]!)
      p += 5
    } else if (v === 30) {
      p++
      while (p < e) {
        const byte = b[p++]!
        if ((byte & 0x0f) === 0x0f || byte >> 4 === 0x0f) break
      }
      operands.push(0)
    } else if (v >= 32 && v <= 246) {
      operands.push(v - 139)
      p++
    } else if (v >= 247 && v <= 250) {
      operands.push((v - 247) * 256 + b[p + 1]! + 108)
      p += 2
    } else if (v >= 251 && v <= 254) {
      operands.push(-(v - 251) * 256 - b[p + 1]! - 108)
      p += 2
    } else p++
  }
  return out
}

/**
 * For a CID-keyed CFF font: the CID of every glyph id (charset). Returns null for name-keyed fonts, where the PDF
 * character code is the glyph id itself.
 */
export function cffGidToCid(cff: Uint8Array): Uint16Array | null {
  const hdrSize = cff[2]!
  const nameIdx = cffIndex(cff, hdrSize)
  const topIdx = cffIndex(cff, nameIdx.end)
  if (topIdx.count < 1) return null
  const top = parseDict(cff, topIdx.dataStart + topIdx.offsets[0]!, topIdx.dataStart + topIdx.offsets[1]!)
  if (!top.has(1230)) return null // no ROS operator: not CID-keyed
  const csOff = top.get(17)?.[0]
  const chOff = top.get(15)?.[0]
  if (csOff === undefined || chOff === undefined) return null
  const nGlyphs = cffIndex(cff, csOff).count
  const cids = new Uint16Array(nGlyphs)
  if (chOff <= 2) return null
  let p = chOff
  const fmt = cff[p++]!
  let gid = 1
  if (fmt === 0) {
    while (gid < nGlyphs) {
      cids[gid++] = (cff[p]! << 8) | cff[p + 1]!
      p += 2
    }
  } else if (fmt === 1 || fmt === 2) {
    while (gid < nGlyphs) {
      const first = (cff[p]! << 8) | cff[p + 1]!
      p += 2
      let left: number
      if (fmt === 1) left = cff[p++]!
      else {
        left = (cff[p]! << 8) | cff[p + 1]!
        p += 2
      }
      for (let k = 0; k <= left && gid < nGlyphs; k++) cids[gid++] = first + k
    }
  } else return null
  return cids
}
