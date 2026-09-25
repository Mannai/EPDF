import { describe, expect, it } from 'vitest'
import {
  ContentParseError,
  bytesToLatin1,
  fmtNum,
  formatObj,
  formatOp,
  latin1ToBytes,
  mkOp,
  name,
  num,
  objEquals,
  parseContent,
  serializeContent,
  str,
  withArgs,
  arr,
  dict
} from '../../src/renderer/src/features/textedit/pdfcontent/content'

const enc = (s: string): Uint8Array => latin1ToBytes(s)
const parse = (s: string) => parseContent(enc(s))
const roundTrip = (s: string): string => {
  const p = parseContent(enc(s))
  return bytesToLatin1(serializeContent(p.ops, p.tail))
}
const ops = (s: string): string[] => parse(s).ops.map(formatOp)

describe('content stream tokenizer', () => {
  it('parses numbers in all PDF spellings', () => {
    const p = parse('1 -2 +3 4.5 -.5 .25 6. 0 0 m')
    const nums = p.ops[0].args.map((a) => (a.t === 'num' ? a.v : NaN))
    expect(nums).toEqual([1, -2, 3, 4.5, -0.5, 0.25, 6, 0, 0])
    expect(p.ops[0].op).toBe('m')
  })

  it('parses literal strings with escapes, nesting and line continuations', () => {
    const p = parse('(a\\(b\\)c \\\\ \\n\\r\\t\\b\\f (nested (deep)) \\101\\60\\7x \\\nnext) Tj')
    const s = p.ops[0].args[0]
    expect(s.t).toBe('str')
    if (s.t !== 'str') return
    expect(bytesToLatin1(s.b)).toBe('a(b)c \\ \n\r\t\b\f (nested (deep)) A0\x07x next')
    expect(s.hex).toBe(false)
  })

  it('normalizes raw CR and CRLF inside a string to LF', () => {
    const s = parse('(a\r\nb\rc) Tj').ops[0].args[0]
    expect(s.t === 'str' && bytesToLatin1(s.b)).toBe('a\nb\nc')
  })

  it('parses hex strings with whitespace and an odd digit count', () => {
    const a = parse('<48 65\n6c6C6F> Tj').ops[0].args[0]
    expect(a.t === 'str' && bytesToLatin1(a.b)).toBe('Hello')
    const b = parse('<414> Tj').ops[0].args[0]
    expect(b.t === 'str' && Array.from(b.b)).toEqual([0x41, 0x40])
    const c = parse('<> Tj').ops[0].args[0]
    expect(c.t === 'str' && c.b.length).toBe(0)
  })

  it('parses names with #xx escapes', () => {
    const p = parse('/F#31 /A#20B /Ab#2 /#41 gs')
    expect(p.ops[0].args.map((a) => (a.t === 'name' ? a.v : ''))).toEqual(['F1', 'A B', 'Ab#2', 'A'])
  })

  it('parses arrays and dictionaries, nested', () => {
    const p = parse('[(a) -120 [1 2] <</K [/A /B] /D <</X 1>> /T true /N null>>] TJ')
    const a = p.ops[0].args[0]
    expect(a.t).toBe('arr')
    if (a.t !== 'arr') return
    expect(a.v.length).toBe(4)
    const d = a.v[3]
    expect(d.t).toBe('dict')
    if (d.t !== 'dict') return
    expect([...d.v.keys()]).toEqual(['K', 'D', 'T', 'N'])
    expect(d.v.get('T')).toEqual({ t: 'bool', v: true })
    expect(d.v.get('N')).toEqual({ t: 'null' })
  })

  it('knows every operator spelling, including * and quote operators', () => {
    const src = "q Q BT ET T* b* B* f* W* ' \" d0 d1 BX EX MP DP BMC BDC EMC sh"
    expect(parse(src).ops.map((o) => o.op)).toEqual(src.split(' '))
  })

  it('separates operators glued to delimiters', () => {
    const p = parse('[(a)]TJ(b)Tj/F1 12 Tf<41>Tj')
    expect(p.ops.map((o) => o.op)).toEqual(['TJ', 'Tj', 'Tf', 'Tj'])
  })

  it('ignores comments but keeps them in the round trip', () => {
    const src = '% header\nq % begin\n1 0 0 1 % mid operand\n5 6 cm\n% trailing'
    const p = parse(src)
    expect(p.ops.map((o) => o.op)).toEqual(['q', 'cm'])
    expect(roundTrip(src)).toBe(src)
  })

  it('parses inline images with computed data length (binary data containing "EI")', () => {
    const data = 'AB EI CD' // 8 bytes = 2x2 RGB? use 4x2 gray 8bpc
    const src = `q BI /W 4 /H 2 /CS /G /BPC 8 ID\n${data}\nEI Q`
    const p = parse(src)
    expect(p.ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q'])
    const bi = p.ops[1]
    expect(bi.inline && bytesToLatin1(bi.inline.data)).toBe(data)
    expect(roundTrip(src)).toBe(src)
  })

  it('parses inline images with filters by searching for EI', () => {
    const src = 'BI /W 2 /H 2 /CS /RGB /BPC 8 /F [/AHx] ID 00ff00 ff0000 00ff00 ff0000 >\nEI\nBT ET'
    const p = parse(src)
    expect(p.ops.map((o) => o.op)).toEqual(['BI', 'BT', 'ET'])
    expect(roundTrip(src)).toBe(src)
  })

  it('parses inline images with abbreviated and full key names', () => {
    const src = 'BI /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 ID \x80\nEI'
    const p = parse(src)
    expect(p.ops).toHaveLength(1)
    expect(p.ops[0].inline?.data.length).toBe(1)
  })

  it('handles an inline image mask', () => {
    const src = 'BI /IM true /W 8 /H 2 ID \xaa\x55\nEI Q'
    const p = parse(src)
    expect(p.ops.map((o) => o.op)).toEqual(['BI', 'Q'])
  })

  it('keeps dangling operands and trailing whitespace in the tail', () => {
    const src = 'q 1 2 3\n'
    const p = parse(src)
    expect(p.ops.map((o) => o.op)).toEqual(['q'])
    expect(bytesToLatin1(p.tail)).toBe(' 1 2 3\n')
    expect(roundTrip(src)).toBe(src)
  })

  it('handles empty and whitespace-only streams', () => {
    expect(parse('').ops).toHaveLength(0)
    expect(roundTrip('')).toBe('')
    expect(roundTrip('  \n\t ')).toBe('  \n\t ')
  })

  it('treats unknown keywords as operators (compatibility sections)', () => {
    expect(ops('BX 1 2 frobnicate EX')).toEqual(['BX', '1 2 frobnicate', 'EX'])
  })
})

describe('malformed streams are rejected, not guessed at', () => {
  const bad: [string, string][] = [
    ['unterminated literal string', 'BT (abc Tj ET'],
    ['unterminated hex string', 'BT <4142 Tj'],
    ['bad hex digit', '<41Z2> Tj'],
    ['unterminated array', '[(a) 1 TJ'],
    ['stray array close', '1 2 ] cm'],
    ['unterminated dictionary', '<</A 1 /B BDC'],
    ['dictionary key not a name', '<<1 2>> BDC'],
    ['stray dictionary close', '>> Q'],
    ['single greater-than', '1 > 2 Tj'],
    ['stray close paren', ') Tj'],
    ['unterminated inline image', 'BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 Q'],
    ['inline image dictionary junk', 'BI 1 2 ID x EI'],
    ['keyword inside array', '[(a) Tj] TJ']
  ]
  for (const [label, src] of bad) {
    it(label, () => {
      expect(() => parse(src)).toThrow(ContentParseError)
    })
  }

  it('rejects absurd nesting depth', () => {
    expect(() => parse('['.repeat(200) + ']'.repeat(200) + ' TJ')).toThrow(ContentParseError)
  })

  it('reports the byte offset', () => {
    try {
      parse('q 1 2 cm\n(oops')
      expect.unreachable()
    } catch (e) {
      expect((e as ContentParseError).offset).toBe(9)
    }
  })
})

describe('serializer', () => {
  it('round-trips byte for byte on a realistic hand-written page stream', () => {
    const src = [
      'q',
      '0.1 0.2 0.3 rg',
      '1 0 0 1 72 720 cm',
      'BT',
      '/F1 12 Tf',
      '14 TL',
      '0 0 Td',
      '(Hello, \\(world\\)!) Tj',
      "T*",
      '[(Kern) 30 (ing) -250 (test)] TJ',
      '(next) \'',
      '1 2 (both) "',
      'ET',
      'Q',
      ''
    ].join('\n')
    expect(roundTrip(src)).toBe(src)
  })

  it('round-trips CRLF files, tabs, form feeds and NUL separators', () => {
    const src = 'q\r\n1 0 0 1 0 0 cm\r\n\tBT\f/F1 9 Tf\x00(x)Tj ET\r\nQ\r\n'
    expect(roundTrip(src)).toBe(src)
  })

  it('round-trips awkward number and string spellings (nothing is normalized unless edited)', () => {
    const src = '+1 -.5 00012 1.0000 (a\\\nb) <4a4B> /N#41me [ 1 2 ] << /A  1 >> BDC'
    expect(roundTrip(src)).toBe(src)
  })

  it('round-trips binary bytes inside strings', () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i)
    const hex = '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '> Tj'
    expect(roundTrip(hex)).toBe(hex)
  })

  it('re-serializes only modified operations and keeps everything else verbatim', () => {
    const src = 'q  1 0 0 1 5 5 cm % keep me\n  BT (Old)Tj ET  Q'
    const p = parse(src)
    const tj = p.ops.findIndex((o) => o.op === 'Tj')
    p.ops[tj] = withArgs(p.ops[tj], [str('New')])
    expect(bytesToLatin1(serializeContent(p.ops, p.tail))).toBe('q  1 0 0 1 5 5 cm % keep me\n  BT (New) Tj ET  Q')
  })

  it('writes strings with escapes, octal for control and high bytes', () => {
    const o = mkOp('Tj', str(Uint8Array.from([0x41, 0x28, 0x29, 0x5c, 0x0a, 0x00, 0xe9, 0x7f])))
    expect(bytesToLatin1(serializeContent([o]))).toBe('\n(A\\(\\)\\\\\\012\\000\\351\\177) Tj')
  })

  it('writes hex strings, names (with escapes), arrays, dictionaries and booleans', () => {
    expect(formatObj(str(Uint8Array.from([1, 0xab]), true))).toBe('<01AB>')
    expect(formatObj(name('A B#/'))).toBe('/A#20B#23#2F')
    expect(formatObj(name('/F1'))).toBe('/F1')
    expect(formatObj(arr(num(1), str('x'), arr()))).toBe('[1 (x) []]')
    expect(formatObj(dict({ K: num(2), V: { t: 'bool', v: true } }))).toBe('<< /K 2 /V true >>')
    expect(formatObj({ t: 'null' })).toBe('null')
  })

  it('formats numbers without exponents and with bounded precision', () => {
    expect(fmtNum(0)).toBe('0')
    expect(fmtNum(-0)).toBe('0')
    expect(fmtNum(12)).toBe('12')
    expect(fmtNum(0.5)).toBe('0.5')
    expect(fmtNum(1 / 3)).toBe('0.333333')
    expect(fmtNum(-1e-9)).toBe('0')
    expect(fmtNum(123456.789)).toBe('123456.789')
    expect(fmtNum(1e-7)).toBe('0')
    expect(() => fmtNum(NaN)).toThrow(ContentParseError)
    expect(() => fmtNum(Infinity)).toThrow(ContentParseError)
    expect(() => fmtNum(1e21)).toThrow(ContentParseError)
  })

  it('refuses to write an operator that would corrupt the stream', () => {
    expect(() => serializeContent([mkOp('T j')])).toThrow(ContentParseError)
    expect(() => serializeContent([mkOp('a(b')])).toThrow(ContentParseError)
    expect(() => serializeContent([mkOp('')])).toThrow(ContentParseError)
  })

  it('re-serialized streams parse back to the same operations', () => {
    const src = 'q 1 0 0 1 10.5 20.25 cm BT /F1 12 Tf [(A) -10.5 (B)] TJ ET Q'
    const p = parse(src)
    const rebuilt = p.ops.map((o) => ({ ...o, raw: null }))
    const again = parseContent(serializeContent(rebuilt))
    expect(again.ops.map(formatOp)).toEqual(p.ops.map(formatOp))
    again.ops.forEach((o, i) => o.args.forEach((a, j) => expect(objEquals(a, p.ops[i].args[j])).toBe(true)))
  })

  it('serializes an edited inline image operation', () => {
    const src = 'BI /W 2 /H 1 /CS /G /BPC 8 ID \x10\x20\nEI'
    const p = parse(src)
    const dirty = { ...p.ops[0], raw: null }
    const out = serializeContent([dirty])
    const again = parseContent(out)
    expect(again.ops).toHaveLength(1)
    expect(again.ops[0].inline && Array.from(again.ops[0].inline.data)).toEqual([0x10, 0x20])
  })
})

describe('round trip over many generated streams (fuzz)', () => {
  // A tiny deterministic PRNG so failures are reproducible.
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const pick = <T,>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)]

  it('parse → serialize is the identity for 400 random valid streams', () => {
    const r = rng(42)
    const atoms = ['1', '-2.5', '.5', '0', '(x)', '(a\\)b)', '<4142>', '/F1', '/Fo#20x', '[(a) 1 (b)]', '<</A 1>>', 'true']
    const opsList = ['q', 'Q', 'cm', 'BT', 'ET', 'Tj', 'TJ', 'Tf', 'Td', 'Tm', 're', 'f', 'Do', 'gs', 'rg', "'", 'T*']
    const seps = [' ', '\n', '\r\n', '  ', '\t', ' % note\n', '%x\n']
    for (let n = 0; n < 400; n++) {
      let s = ''
      const count = 1 + Math.floor(r() * 30)
      for (let i = 0; i < count; i++) {
        const nargs = Math.floor(r() * 4)
        for (let k = 0; k < nargs; k++) s += pick(r, atoms) + pick(r, seps)
        s += pick(r, opsList) + pick(r, seps)
      }
      expect(roundTrip(s)).toBe(s)
    }
  })

  it('never throws anything but ContentParseError on random garbage', () => {
    const r = rng(7)
    const alphabet = '()<>[]{}/% \n\\0123456789abcQqTjEIBID.-+'
    for (let n = 0; n < 500; n++) {
      let s = ''
      const len = Math.floor(r() * 60)
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)]
      try {
        const p = parse(s)
        // whatever parsed must round-trip exactly
        expect(bytesToLatin1(serializeContent(p.ops, p.tail))).toBe(s)
      } catch (e) {
        expect(e).toBeInstanceOf(ContentParseError)
      }
    }
  })
})
