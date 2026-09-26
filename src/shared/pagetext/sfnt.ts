/**
 * A minimal, defensive reader for embedded TrueType/OpenType font programs (FontFile2, or FontFile3/OpenType): just
 * what text extraction needs when a font has no usable /ToUnicode, and for the ink boxes of zero-width glyphs
 * (combining marks). Never throws: malformed tables give `undefined`.
 *
 *   - cmap (formats 0, 4, 6, 12): code/Unicode -> glyph id, and the reverse (glyph id -> Unicode)
 *   - post (format 2.0): glyph names
 *   - head/loca/glyf: glyph bounding boxes (from each glyph's header, which covers composite glyphs too)
 */

export interface Sfnt {
  unitsPerEm: number
  numGlyphs: number
  /** Glyph for a code in a (platform, encoding) subtable, e.g. (3,0) symbol, (1,0) Mac Roman, (3,1) Unicode BMP. */
  lookup(platform: number, encoding: number, code: number): number | undefined
  /** Unicode for a glyph from the font's Unicode cmap (reverse lookup); base letters preferred over presentation forms. */
  unicodeOf(gid: number): string | undefined
  /** Glyph name from the post table. */
  nameOf(gid: number): string | undefined
  /** Glyph bounding box in font units [xMin, yMin, xMax, yMax]. */
  bbox(gid: number): [number, number, number, number] | undefined
  hasCmap(platform: number, encoding: number): boolean
}

interface Sub {
  platform: number
  encoding: number
  map: (code: number) => number | undefined
  entries: () => Iterable<[number, number]>
}

export function readSfnt(b: Uint8Array): Sfnt | undefined {
  try {
    return parse(b)
  } catch {
    return undefined
  }
}

function parse(b: Uint8Array): Sfnt | undefined {
  if (b.length < 12) return undefined
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u16 = (o: number): number => dv.getUint16(o)
  const i16 = (o: number): number => dv.getInt16(o)
  const u32 = (o: number): number => dv.getUint32(o)
  let base = 0
  const tag0 = u32(0)
  if (tag0 === 0x74746366) base = u32(12) // 'ttcf': first font of a collection
  const sig = u32(base)
  if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) return undefined // 1.0, 'OTTO', 'true'
  const numTables = u16(base + 4)
  const tables = new Map<string, { off: number; len: number }>()
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16
    if (r + 16 > b.length) break
    const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3])
    const off = u32(r + 8)
    const len = u32(r + 12)
    if (off + len <= b.length) tables.set(tag, { off, len })
  }
  const head = tables.get('head')
  const unitsPerEm = head && head.len >= 54 ? u16(head.off + 18) || 1000 : 1000
  const locFormat = head && head.len >= 54 ? i16(head.off + 50) : 0
  const maxp = tables.get('maxp')
  const numGlyphs = maxp && maxp.len >= 6 ? u16(maxp.off + 4) : 0

  // ---- cmap
  const subs: Sub[] = []
  const cmap = tables.get('cmap')
  if (cmap && cmap.len >= 4) {
    const n = u16(cmap.off + 2)
    for (let i = 0; i < n; i++) {
      const r = cmap.off + 4 + i * 8
      if (r + 8 > cmap.off + cmap.len) break
      const platform = u16(r)
      const encoding = u16(r + 2)
      const so = cmap.off + u32(r + 4)
      if (so + 4 > b.length) continue
      const sub = readSub(dv, b, so)
      if (sub) subs.push({ platform, encoding, ...sub })
    }
  }
  const find = (p: number, e: number): Sub | undefined => subs.find((s) => s.platform === p && s.encoding === e)
  const uniSub = find(3, 10) ?? find(0, 6) ?? find(0, 4) ?? find(3, 1) ?? find(0, 3) ?? find(0, 2) ?? find(0, 1) ?? find(0, 0)
  let reverse: Map<number, number> | undefined
  const reverseMap = (): Map<number, number> => {
    if (reverse) return reverse
    reverse = new Map()
    if (uniSub) {
      for (const [cp, gid] of uniSub.entries()) {
        if (!gid) continue
        const prev = reverse.get(gid)
        // prefer base letters over presentation forms, and the lowest code point otherwise
        if (prev === undefined || (isPresentation(prev) && !isPresentation(cp)) || (isPresentation(prev) === isPresentation(cp) && cp < prev)) reverse.set(gid, cp)
      }
    }
    return reverse
  }

  // ---- post names
  let names: (string | undefined)[] | undefined
  const post = tables.get('post')
  const namesOf = (): (string | undefined)[] => {
    if (names) return names
    names = []
    if (post && post.len >= 34 && u32(post.off) === 0x00020000) {
      const n = u16(post.off + 32)
      const idx: number[] = []
      for (let i = 0; i < n; i++) idx.push(u16(post.off + 34 + i * 2))
      const custom: string[] = []
      let p = post.off + 34 + n * 2
      const end = post.off + post.len
      while (p < end) {
        const l = b[p]
        custom.push(String.fromCharCode(...b.subarray(p + 1, Math.min(end, p + 1 + l))))
        p += 1 + l
      }
      for (let g = 0; g < n; g++) names[g] = idx[g] < 258 ? MAC_GLYPHS[idx[g]] : custom[idx[g] - 258]
    }
    return names
  }

  // ---- glyph boxes
  const loca = tables.get('loca')
  const glyf = tables.get('glyf')
  const glyphOffset = (gid: number): [number, number] | undefined => {
    if (!loca || !glyf || gid < 0 || (numGlyphs && gid >= numGlyphs)) return undefined
    if (locFormat === 0) {
      if (loca.off + gid * 2 + 4 > loca.off + loca.len) return undefined
      return [u16(loca.off + gid * 2) * 2, u16(loca.off + gid * 2 + 2) * 2]
    }
    if (loca.off + gid * 4 + 8 > loca.off + loca.len) return undefined
    return [u32(loca.off + gid * 4), u32(loca.off + gid * 4 + 4)]
  }

  return {
    unitsPerEm,
    numGlyphs,
    hasCmap: (p, e) => !!find(p, e),
    lookup(p, e, code) {
      const s = find(p, e)
      return s ? s.map(code) : undefined
    },
    unicodeOf(gid) {
      const cp = reverseMap().get(gid)
      return cp === undefined ? undefined : String.fromCodePoint(cp)
    },
    nameOf(gid) {
      return namesOf()[gid]
    },
    bbox(gid) {
      const o = glyphOffset(gid)
      if (!o || o[1] - o[0] < 10) return undefined
      const at = glyf!.off + o[0]
      if (at + 10 > glyf!.off + glyf!.len) return undefined
      return [i16(at + 2), i16(at + 4), i16(at + 6), i16(at + 8)]
    }
  }
}

const isPresentation = (cp: number): boolean => (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff) || (cp >= 0xfb1d && cp <= 0xfb4f)

function readSub(dv: DataView, b: Uint8Array, o: number): Omit<Sub, 'platform' | 'encoding'> | undefined {
  const u16 = (x: number): number => dv.getUint16(x)
  const u32 = (x: number): number => dv.getUint32(x)
  const format = u16(o)
  if (format === 0) {
    if (o + 262 > b.length) return undefined
    return {
      map: (c) => (c >= 0 && c < 256 ? b[o + 6 + c] || undefined : undefined),
      *entries() {
        for (let c = 0; c < 256; c++) if (b[o + 6 + c]) yield [c, b[o + 6 + c]] as [number, number]
      }
    }
  }
  if (format === 4) {
    const segX2 = u16(o + 6)
    const ends = o + 14
    const starts = ends + segX2 + 2
    const deltas = starts + segX2
    const ranges = deltas + segX2
    if (ranges + segX2 > b.length) return undefined
    const segs = segX2 / 2
    const glyphAt = (seg: number, c: number): number | undefined => {
      const start = u16(starts + seg * 2)
      const delta = dv.getInt16(deltas + seg * 2)
      const ro = u16(ranges + seg * 2)
      if (ro === 0) return (c + delta) & 0xffff || undefined
      const addr = ranges + seg * 2 + ro + (c - start) * 2
      if (addr + 2 > b.length) return undefined
      const g = u16(addr)
      return g ? (g + delta) & 0xffff || undefined : undefined
    }
    return {
      map(c) {
        if (c < 0 || c > 0xffff) return undefined
        let lo = 0
        let hi = segs - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (u16(ends + mid * 2) < c) lo = mid + 1
          else hi = mid
        }
        if (u16(ends + lo * 2) < c || u16(starts + lo * 2) > c) return undefined
        return glyphAt(lo, c)
      },
      *entries() {
        for (let s = 0; s < segs; s++) {
          const start = u16(starts + s * 2)
          const end = u16(ends + s * 2)
          if (end - start > 0x4000) continue
          for (let c = start; c <= end && c !== 0xffff; c++) {
            const g = glyphAt(s, c)
            if (g) yield [c, g] as [number, number]
          }
        }
      }
    }
  }
  if (format === 6) {
    const first = u16(o + 6)
    const count = u16(o + 8)
    if (o + 10 + count * 2 > b.length) return undefined
    return {
      map: (c) => (c >= first && c < first + count ? u16(o + 10 + (c - first) * 2) || undefined : undefined),
      *entries() {
        for (let i = 0; i < count; i++) {
          const g = u16(o + 10 + i * 2)
          if (g) yield [first + i, g] as [number, number]
        }
      }
    }
  }
  if (format === 12) {
    const n = u32(o + 12)
    if (o + 16 + n * 12 > b.length || n > 100000) return undefined
    return {
      map(c) {
        let lo = 0
        let hi = n - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          const r = o + 16 + mid * 12
          const s = u32(r)
          const e = u32(r + 4)
          if (c < s) hi = mid - 1
          else if (c > e) lo = mid + 1
          else return u32(r + 8) + (c - s) || undefined
        }
        return undefined
      },
      *entries() {
        for (let i = 0; i < n; i++) {
          const r = o + 16 + i * 12
          const s = u32(r)
          const e = u32(r + 4)
          if (e - s > 0x10000) continue
          for (let c = s; c <= e; c++) yield [c, u32(r + 8) + (c - s)] as [number, number]
        }
      }
    }
  }
  return undefined
}

/** The 258 standard Macintosh glyph names (post table format 2.0). */
const MAC_GLYPHS = (
  '.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
  'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater ' +
  'question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave ' +
  'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde ' +
  'Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave ' +
  'icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent ' +
  'sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus ' +
  'lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown ' +
  'exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde ' +
  'Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency ' +
  'guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex ' +
  'Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi ' +
  'circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron ' +
  'brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter ' +
  'threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat'
).split(' ')
