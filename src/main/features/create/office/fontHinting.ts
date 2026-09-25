/**
 * Removes TrueType hinting (the `fpgm`/`prep`/`cvt ` tables and every glyph's instructions) from a font.
 *
 * Why: fontkit's subsetter copies glyph programs verbatim but not the hinting state they depend on, so for
 * heavily hinted fonts (Carlito and Noto Sans, which are ttfautohint-ed) the subset embedded in the PDF has
 * glyphs whose instructions fail in FreeType-based viewers and render blank. PDF viewers do not need
 * hinting (they render at arbitrary sizes), so dropping it loses nothing and makes the subset smaller.
 */
export function stripHinting(src: Uint8Array): Uint8Array {
  try {
    return strip(src)
  } catch {
    return src // an unusual/damaged font: use it as it is
  }
}

function strip(src: Uint8Array): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const numTables = dv.getUint16(4)
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    const tag = String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3])
    const off = dv.getUint32(o + 8)
    const len = dv.getUint32(o + 12)
    tables.set(tag, src.slice(off, off + len))
  }
  const head = tables.get('head')
  const maxp = tables.get('maxp')
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  if (!head || !maxp || !loca || !glyf) return src // not a TrueType-outline font: leave it alone

  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const longLoca = hdv.getInt16(50) === 1
  const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4)
  const ldv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
  const offset = (i: number): number => (longLoca ? ldv.getUint32(i * 4) : ldv.getUint16(i * 2) * 2)

  const parts: Uint8Array[] = []
  const newLoca = new Uint8Array((numGlyphs + 1) * 4)
  const ndv = new DataView(newLoca.buffer)
  let pos = 0
  for (let g = 0; g < numGlyphs; g++) {
    ndv.setUint32(g * 4, pos)
    const a = offset(g)
    const b = offset(g + 1)
    if (b <= a) continue
    const gd = glyf.subarray(a, b)
    const gv = new DataView(gd.buffer, gd.byteOffset, gd.byteLength)
    const contours = gv.getInt16(0)
    let out: Uint8Array
    if (contours >= 0) {
      // simple glyph: header, endPtsOfContours, instructionLength, instructions, flags/coordinates
      const instrAt = 10 + contours * 2
      const ilen = gv.getUint16(instrAt)
      out = new Uint8Array(gd.length - ilen)
      out.set(gd.subarray(0, instrAt + 2), 0)
      new DataView(out.buffer).setUint16(instrAt, 0)
      out.set(gd.subarray(instrAt + 2 + ilen), instrAt + 2)
    } else {
      // composite glyph: clear WE_HAVE_INSTRUCTIONS and cut the trailing instructions
      out = gd.slice()
      const ov = new DataView(out.buffer)
      let p = 10
      let hasInstructions = false
      for (;;) {
        const flags = ov.getUint16(p)
        if (flags & 0x0100) hasInstructions = true
        ov.setUint16(p, flags & ~0x0100)
        p += 4 + (flags & 0x0001 ? 4 : 2)
        if (flags & 0x0008) p += 2
        else if (flags & 0x0040) p += 4
        else if (flags & 0x0080) p += 8
        if (!(flags & 0x0020)) break
      }
      if (hasInstructions) out = out.subarray(0, p)
    }
    const padded = new Uint8Array((out.length + 3) & ~3)
    padded.set(out)
    parts.push(padded)
    pos += padded.length
  }
  ndv.setUint32(numGlyphs * 4, pos)
  const newGlyf = new Uint8Array(pos)
  let o = 0
  for (const p of parts) {
    newGlyf.set(p, o)
    o += p.length
  }
  hdv.setInt16(50, 1) // the rebuilt loca table uses long offsets
  hdv.setUint32(8, 0) // checkSumAdjustment: viewers and fontkit do not verify it
  tables.set('glyf', newGlyf)
  tables.set('loca', newLoca)
  for (const t of ['fpgm', 'prep', 'cvt ', 'hdmx', 'LTSH', 'VDMX', 'DSIG']) tables.delete(t)

  const tags = [...tables.keys()].sort()
  const dirLen = 12 + tags.length * 16
  let total = dirLen
  for (const t of tags) total += (tables.get(t)!.length + 3) & ~3
  const out = new Uint8Array(total)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, 0x00010000)
  odv.setUint16(4, tags.length)
  let searchRange = 1
  let entrySelector = 0
  while (searchRange * 2 <= tags.length) {
    searchRange *= 2
    entrySelector++
  }
  odv.setUint16(6, searchRange * 16)
  odv.setUint16(8, entrySelector)
  odv.setUint16(10, tags.length * 16 - searchRange * 16)
  let off = dirLen
  tags.forEach((t, i) => {
    const d = tables.get(t)!
    const e = 12 + i * 16
    for (let k = 0; k < 4; k++) out[e + k] = t.charCodeAt(k)
    odv.setUint32(e + 8, off)
    odv.setUint32(e + 12, d.length)
    out.set(d, off)
    off += (d.length + 3) & ~3
  })
  return out
}
