/**
 * /ToUnicode CMaps: what makes copy, search and text extraction work for text drawn with subset fonts.
 * One glyph code may stand for several Unicode characters (ligatures, lam-alef, clusters), which is why the
 * destination is a *string* (UTF-16BE hex), not a single code point.
 */

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')

/** UTF-16BE hex of a JavaScript string (surrogate pairs stay pairs). */
export function utf16beHex(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i))
  return out
}

/** Build a ToUnicode CMap for 2-byte codes: `map` is code -> text. */
export function buildToUnicode(map: Map<number, string>): string {
  const entries = [...map].filter(([, t]) => t.length > 0).sort((a, b) => a[0] - b[0])
  let out =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    out += `${chunk.length} beginbfchar\n`
    for (const [code, text] of chunk) out += `<${hex4(code)}> <${utf16beHex(text)}>\n`
    out += 'endbfchar\n'
  }
  out += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  return out
}

/** Parse a ToUnicode CMap back into code -> text (bfchar and bfrange). Used by tests and by the extraction helpers. */
export function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>()
  const hexToString = (h: string): string => {
    let s = ''
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    return s
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) out.set(parseInt(m[1]!, 16), hexToString(m[2]!))
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1]!, 16)
      const hi = parseInt(m[2]!, 16)
      if (m[3] !== undefined) {
        const start = hexToString(m[3])
        for (let c = lo; c <= hi; c++) out.set(c, start.slice(0, -1) + String.fromCharCode(start.charCodeAt(start.length - 1) + (c - lo)))
      } else if (m[4] !== undefined) {
        const items = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToString(x[1]!))
        for (let c = lo; c <= hi; c++) out.set(c, items[c - lo] ?? '')
      }
    }
  }
  return out
}
