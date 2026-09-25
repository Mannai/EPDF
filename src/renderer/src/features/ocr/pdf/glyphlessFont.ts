/**
 * A "glyphless" TrueType font: every glyph is empty, but each has a real advance width. It is the standard
 * device for OCR text layers (Tesseract's own PDF renderer does the same): the text is drawn with render mode
 * 3 (invisible), so no outlines are needed, while the character codes still map to Unicode through a
 * ToUnicode CMap, so any script (Latin, CJK, Arabic, Devanagari, ...) can be selected, searched and copied
 * without shipping a font that covers it.
 *
 * The font has `count` glyphs besides .notdef; with an Identity CIDToGIDMap, CID n draws glyph n.
 */

const UNITS = 1000
const ASCENT = 800
const DESCENT = -200

class Writer {
  private bytes: number[] = []
  u8(v: number): this {
    this.bytes.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v)
  }
  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff)
  }
  tag(t: string): this {
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i))
    return this
  }
  zero(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0)
    return this
  }
  get length(): number {
    return this.bytes.length
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

const checksum = (data: Uint8Array): number => {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const v = ((data[i] ?? 0) * 0x1000000 + (data[i + 1] ?? 0) * 0x10000 + (data[i + 2] ?? 0) * 0x100 + (data[i + 3] ?? 0)) >>> 0
    sum = (sum + v) >>> 0
  }
  return sum
}

function utf16be(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 0xff)
  return out
}

/** `widths[i]` is the advance (1000 units per em) of glyph i + 1; glyph 0 (.notdef) gets 500. */
export function buildGlyphlessFont(widths: number[], family = 'EpdfGlyphless'): Uint8Array {
  const numGlyphs = widths.length + 1
  if (numGlyphs > 65535) throw new Error('Too many distinct characters for one OCR font')
  const adv = [500, ...widths.map((w) => Math.max(0, Math.min(65535, Math.round(w))))]
  const maxAdv = Math.max(...adv)

  const tables = new Map<string, Uint8Array>()

  // head (checkSumAdjustment patched in at the end)
  tables.set(
    'head',
    new Writer()
      .u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5)
      .u16(0x000b).u16(UNITS).zero(16) // flags, unitsPerEm, created + modified
      .i16(0).i16(DESCENT).i16(maxAdv).i16(ASCENT) // bbox
      .u16(0).u16(8).i16(2).i16(0).i16(0) // macStyle, lowestRecPPEM, fontDirectionHint, indexToLocFormat (short), glyphDataFormat
      .done()
  )
  tables.set(
    'hhea',
    new Writer()
      .u32(0x00010000).i16(ASCENT).i16(DESCENT).i16(0).u16(maxAdv).i16(0).i16(0).i16(maxAdv)
      .i16(1).i16(0).i16(0).zero(8).i16(0).u16(numGlyphs)
      .done()
  )
  tables.set(
    'maxp',
    new Writer().u32(0x00010000).u16(numGlyphs).u16(0).u16(0).u16(0).u16(0).u16(1).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).done()
  )
  const hmtx = new Writer()
  for (const a of adv) hmtx.u16(a).i16(0)
  tables.set('hmtx', hmtx.done())
  // Every glyph is empty: all loca offsets are 0 (short format = offset / 2).
  tables.set('loca', new Writer().zero((numGlyphs + 1) * 2).done())
  tables.set('glyf', new Writer().zero(4).done())
  // cmap: one Unicode BMP subtable that maps nothing (required by some sanitizers; CID fonts ignore it).
  tables.set(
    'cmap',
    new Writer()
      .u16(0).u16(1).u16(3).u16(1).u32(12)
      .u16(4).u16(24).u16(0).u16(2).u16(2).u16(0).u16(0)
      .u16(0xffff).u16(0).u16(0xffff).i16(1).u16(0)
      .done()
  )
  const names = [
    [1, family],
    [4, family],
    [6, family]
  ] as const
  const strings = names.map(([, s]) => utf16be(s))
  const nameW = new Writer().u16(0).u16(names.length).u16(6 + names.length * 12)
  let off = 0
  names.forEach(([id], i) => {
    nameW.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i].length).u16(off)
    off += strings[i].length
  })
  for (const s of strings) for (const b of s) nameW.u8(b)
  tables.set('name', nameW.done())
  tables.set('post', new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).done())
  tables.set(
    'OS/2',
    new Writer()
      .u16(1).i16(500).u16(400).u16(5).u16(0)
      .i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(300)
      .i16(0).zero(10).u32(0).u32(0).u32(0).u32(0).tag('    ')
      .u16(0x40).u16(0x20).u16(0xffff).i16(ASCENT).i16(DESCENT).i16(0).u16(ASCENT).u16(-DESCENT)
      .u32(1).u32(0)
      .done()
  )

  const order = [...tables.keys()].sort()
  const dirLen = 12 + order.length * 16
  let entrySelector = 0
  while (1 << (entrySelector + 1) <= order.length) entrySelector++
  const searchRange = (1 << entrySelector) * 16
  const dir = new Writer().u32(0x00010000).u16(order.length).u16(searchRange).u16(entrySelector).u16(order.length * 16 - searchRange)
  let cursor = dirLen
  const placed: { tag: string; data: Uint8Array; offset: number }[] = []
  for (const tag of order) {
    const data = tables.get(tag)!
    dir.tag(tag).u32(checksum(data)).u32(cursor).u32(data.length)
    placed.push({ tag, data, offset: cursor })
    cursor += Math.ceil(data.length / 4) * 4
  }
  const file = new Uint8Array(cursor)
  file.set(dir.done(), 0)
  for (const p of placed) file.set(p.data, p.offset)
  // whole-file checksum -> head.checkSumAdjustment
  const headOffset = placed.find((p) => p.tag === 'head')!.offset
  const adj = (0xb1b0afba - checksum(file)) >>> 0
  file[headOffset + 8] = adj >>> 24
  file[headOffset + 9] = (adj >>> 16) & 0xff
  file[headOffset + 10] = (adj >>> 8) & 0xff
  file[headOffset + 11] = adj & 0xff
  return file
}
