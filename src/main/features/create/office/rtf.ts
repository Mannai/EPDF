import { throwIfCancelled, type ConvertEnv } from './env'
import type { BorderSpec, Block, Cell, FlowDocument, HeaderFooterSet, Inline, ParaProps, Paragraph, Row, Section, Table, TabStop, TextStyle } from './flow'
import { DEFAULT_PARA_PROPS } from './flow'
import type { ImageData } from './ops'

/**
 * RTF reader: a tokenizer plus a group-stack interpreter that builds a FlowDocument. Covers text and
 * character/paragraph formatting, tables (merges, borders, shading, header rows), lists (\listtable and legacy
 * \pntext), sections and page setup, headers/footers, fields (PAGE/NUMPAGES/HYPERLINK), embedded PNG/JPEG
 * pictures and footnotes (moved to the end). Everything is stack-based (no recursion), so deeply nested or
 * hostile input cannot overflow the call stack.
 */

// ---------------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------------

type Token =
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'word'; name: string; param: number | undefined }
  | { t: 'sym'; ch: string }
  | { t: 'hex'; code: number }
  | { t: 'text'; bytes: Uint8Array }
  | { t: 'bin'; bytes: Uint8Array }

const isLetter = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
const isDigit = (c: number): boolean => c >= 48 && c <= 57
const hexVal = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1)

class Lexer {
  pos = 0
  constructor(private readonly b: Uint8Array) {}

  next(): Token | null {
    const b = this.b
    const n = b.length
    for (;;) {
      if (this.pos >= n) return null
      const c = b[this.pos]
      if (c === 0x0d || c === 0x0a) {
        this.pos++
        continue
      }
      if (c === 0x7b) {
        this.pos++
        return { t: 'open' }
      }
      if (c === 0x7d) {
        this.pos++
        return { t: 'close' }
      }
      if (c === 0x5c) return this.control()
      const start = this.pos
      while (this.pos < n) {
        const d = b[this.pos]
        if (d === 0x5c || d === 0x7b || d === 0x7d || d === 0x0d || d === 0x0a) break
        this.pos++
      }
      return { t: 'text', bytes: b.subarray(start, this.pos) }
    }
  }

  private control(): Token {
    const b = this.b
    const n = b.length
    this.pos++ // backslash
    if (this.pos >= n) return { t: 'sym', ch: '' }
    const c = b[this.pos]
    if (isLetter(c)) {
      const s = this.pos
      while (this.pos < n && isLetter(b[this.pos]) && this.pos - s < 32) this.pos++
      const name = String.fromCharCode(...b.subarray(s, this.pos))
      let param: number | undefined
      let neg = false
      if (b[this.pos] === 0x2d) {
        neg = true
        this.pos++
      }
      const ds = this.pos
      while (this.pos < n && isDigit(b[this.pos]) && this.pos - ds < 10) this.pos++
      if (this.pos > ds) {
        param = parseInt(String.fromCharCode(...b.subarray(ds, this.pos)), 10)
        if (neg) param = -param
      } else if (neg) this.pos-- // a lone '-' belongs to the text
      if (b[this.pos] === 0x20) this.pos++ // the delimiter space
      if (name === 'bin' && param !== undefined && param > 0) {
        const bytes = b.subarray(this.pos, Math.min(n, this.pos + param))
        this.pos += bytes.length
        return { t: 'bin', bytes }
      }
      return { t: 'word', name, param }
    }
    this.pos++
    if (c === 0x27) {
      // \'hh
      const h = hexVal(b[this.pos] ?? -1)
      const l = hexVal(b[this.pos + 1] ?? -1)
      if (h >= 0 && l >= 0) {
        this.pos += 2
        return { t: 'hex', code: h * 16 + l }
      }
      return { t: 'sym', ch: '' }
    }
    if (c === 0x0d || c === 0x0a) return { t: 'word', name: 'par', param: undefined }
    return { t: 'sym', ch: String.fromCharCode(c) }
  }
}

// ---------------------------------------------------------------------------------------------------
// Code pages
// ---------------------------------------------------------------------------------------------------

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ '

const decoders = new Map<number, (bytes: Uint8Array) => string>()

function decoderFor(cp: number): (bytes: Uint8Array) => string {
  let d = decoders.get(cp)
  if (d) return d
  const table = cp === 437 ? CP437 : cp === 850 ? CP850 : null
  if (table && table.length === 128) {
    d = (bytes) => {
      let s = ''
      for (const x of bytes) s += x < 128 ? String.fromCharCode(x) : table[x - 128]
      return s
    }
  } else {
    const label =
      cp >= 1250 && cp <= 1258
        ? `windows-${cp}`
        : cp === 874
          ? 'windows-874'
          : cp === 932
            ? 'shift_jis'
            : cp === 936
              ? 'gbk'
              : cp === 949
                ? 'euc-kr'
                : cp === 950
                  ? 'big5'
                  : cp === 10000
                    ? 'macintosh'
                    : cp === 866
                      ? 'ibm866'
                      : 'windows-1252'
    let dec: TextDecoder
    try {
      dec = new TextDecoder(label)
    } catch {
      dec = new TextDecoder('windows-1252')
    }
    d = (bytes) => dec.decode(bytes)
  }
  decoders.set(cp, d)
  return d
}

const CHARSET_CP: Record<number, number> = { 0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850 }

/** Symbol/Wingdings characters we can map to Unicode (mostly bullets); other symbol text is kept as-is. */
const SYMBOL_MAP: Record<number, string> = { 0xb7: '•', 0xa7: '▪', 0xd8: '➢', 0xfc: '✓', 0x76: '❖', 0x6e: '■', 0x6c: '●', 0x6f: '○', 0xa8: '◻', 0x71: '❑', 0xfb: '✗', 0x77: '◆' }

// ---------------------------------------------------------------------------------------------------
// Interpreter state
// ---------------------------------------------------------------------------------------------------

interface CharFmt {
  f: number
  fs: number
  b: boolean
  i: boolean
  ul: boolean
  strike: boolean
  cf: number
  hl: number
  sup: boolean
  sub: boolean
  caps: boolean
  scaps: boolean
  hidden: boolean
  spacing: number
}

interface BorderDraft {
  style: 'single' | 'double' | 'dashed' | 'dotted' | 'nil'
  w: number
  cf: number
}
type Sides = { t?: BorderDraft; b?: BorderDraft; l?: BorderDraft; r?: BorderDraft }

interface TabDraft {
  pos: number
  align: TabStop['align']
  leader?: TabStop['leader']
}

interface ParaFmt {
  qa: ParaProps['align']
  li?: number
  ri?: number
  fi?: number
  sb: number
  sa: number
  sl: number
  slmult: number
  keep: boolean
  keepn: boolean
  pagebb: boolean
  widow: boolean
  tabs: TabDraft[]
  nextTabAlign: TabStop['align']
  nextLeader?: TabStop['leader']
  bdr: Sides
  shade: number
  intbl: boolean
  ls: number
  ilvl: number
  rtl: boolean
}

type Dest =
  | 'body'
  | 'skip'
  | 'fonttbl'
  | 'colortbl'
  | 'stylesheet'
  | 'style'
  | 'listtable'
  | 'list'
  | 'listlevel'
  | 'leveltext'
  | 'listoverridetable'
  | 'listoverride'
  | 'fldinst'
  | 'fldrslt'
  | 'pict'
  | 'listtext'

interface GState {
  char: CharFmt
  para: ParaFmt
  dest: Dest
  uc: number
  skip: number
  ignore: boolean
  cp: number
  star: boolean
  first: boolean
  bdrTarget: BorderDraft | null
  sink: Sink
  onClose?: () => void
  /** Style number being defined inside the stylesheet. */
  styleId?: number
  styleKind?: 'p' | 'c'
}

interface CellDef {
  right: number
  hmerge: 0 | 1 | 2
  vmerge: 0 | 1 | 2
  shade: number
  vAlign: 'top' | 'center' | 'bottom'
  bdr: Sides
}

interface RowDef {
  left: number
  gaph: number
  cells: CellDef[]
  cur: CellDef
  header: boolean
  height: number
  keep: boolean
  align: 'left' | 'center' | 'right'
  padL?: number
  padR?: number
  bdr: Sides & { h?: BorderDraft; v?: BorderDraft }
}

interface RawCell {
  blocks: Block[]
}
interface RawRow {
  cells: RawCell[]
  def: RowDef
}

interface Sink {
  blocks: Block[]
  inlines: Inline[]
  cellBlocks: Block[]
  rowCells: RawCell[]
  rows: RawRow[]
  rowDef: RowDef
  pendingList?: string
}

interface FontEntry {
  name: string
  family: string
  cp: number | null
  symbolic: boolean
}

interface StyleDef {
  basedOn?: number
  tokens: { name: string; param: number | undefined }[]
}

interface LevelDef {
  nfc: number
  start: number
  codes: number[]
  li?: number
  fi?: number
}
interface ListDef {
  id: number
  levels: LevelDef[]
}

interface PictureDraft {
  format: 'png' | 'jpeg' | null
  hex: string
  bin: Uint8Array[]
  w: number
  h: number
  wg: number
  hg: number
  sx: number
  sy: number
  kind: string
}

interface SectionDraft {
  paperw: number
  paperh: number
  margl: number
  margr: number
  margt: number
  margb: number
  cols: number
  colsx: number
  titlepg: boolean
  headery: number
  footery: number
  pgnstart?: number
  header: HeaderFooterSet
  footer: HeaderFooterSet
}

const newCellDef = (): CellDef => ({ right: 0, hmerge: 0, vmerge: 0, shade: 0, vAlign: 'top', bdr: {} })
const newRowDef = (): RowDef => ({ left: 0, gaph: 108, cells: [], cur: newCellDef(), header: false, height: 0, keep: false, align: 'left', bdr: {} })
const newSink = (): Sink => ({ blocks: [], inlines: [], cellBlocks: [], rowCells: [], rows: [], rowDef: newRowDef() })

const defaultChar = (): CharFmt => ({ f: -1, fs: 24, b: false, i: false, ul: false, strike: false, cf: 0, hl: 0, sup: false, sub: false, caps: false, scaps: false, hidden: false, spacing: 0 })
const defaultPara = (): ParaFmt => ({ qa: 'left', sb: 0, sa: 0, sl: 0, slmult: 0, keep: false, keepn: false, pagebb: false, widow: true, tabs: [], nextTabAlign: 'left', bdr: {}, shade: 0, intbl: false, ls: 0, ilvl: 0, rtl: false })

const DEST_SKIP = new Set([
  'info', 'xmlnstbl', 'rsidtbl', 'generator', 'themedata', 'datastore', 'colorschememapping', 'latentstyles', 'private', 'filetbl', 'revtbl', 'pgptbl', 'bkmkstart', 'bkmkend', 'atnid', 'annotation', 'objdata', 'nonshppict', 'wgrffmtfilter', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'sp', 'shprslt', 'pnseclvl', 'pn', 'falt', 'panose', 'fname', 'fontemb', 'fontfile', 'header_placeholder', 'levelnumbers', 'listname', 'listtemplateid', 'listhybrid', 'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'factoidname', 'mmathPr', 'defchp', 'defpap', 'pgdsctbl', 'protusertbl', 'userprops', 'txfieldtext', 'ftnbj', 'title', 'subject', 'author', 'keywords', 'doccomm', 'operator', 'company', 'manager', 'category', 'hlinkbase', 'buptim', 'creatim', 'revtim', 'printim', 'comment', 'mhtmltag', 'listtag', 'tc', 'tcn', 'xe', 'txe', 'rxe', 'ud', 'upr', 'staticval', 'cxs', 'cxa'
])

const roman = (n: number): string => {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let s = ''
  for (const [v, r] of map) while (n >= v) {
    s += r
    n -= v
  }
  return s
}
const letters = (n: number, upper: boolean): string => {
  let s = ''
  let x = n
  while (x > 0) {
    x--
    s = String.fromCharCode((upper ? 65 : 97) + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return s || (upper ? 'A' : 'a')
}
const formatNumber = (n: number, nfc: number): string => {
  switch (nfc) {
    case 1:
      return roman(n)
    case 2:
      return roman(n).toLowerCase()
    case 3:
      return letters(n, true)
    case 4:
      return letters(n, false)
    case 22:
      return String(n).padStart(2, '0')
    case 255:
      return ''
    default:
      return String(n)
  }
}

const tw = (n: number): number => n / 20

// ---------------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------------

export function readRtf(bytes: Uint8Array, env: ConvertEnv): FlowDocument {
  const warn = (m: string): void => env.warnings.add(m)
  const head = String.fromCharCode(...bytes.subarray(0, 8))
  if (!/^\s*\{\\rtf/i.test(head)) {
    // Not RTF at all: show the text rather than fail (many ".rtf" files are plain text).
    warn('The file does not look like RTF; its content is shown as plain text.')
    const text = new TextDecoder('windows-1252').decode(bytes)
    const style = baseStyle('Arial', 12)
    const blocks: Block[] = text.replace(/\r\n?/g, '\n').split('\n').map((l) => ({ k: 'p' as const, props: { ...DEFAULT_PARA_PROPS }, inlines: l ? [{ k: 'text' as const, text: l, style }] : [], markStyle: style }))
    return { defaultTabStop: 36, sections: [{ page: pageOf(12240, 15840, 1440, 1440, 1440, 1440, 720, 720), type: 'nextPage', blocks }] }
  }

  const fonts = new Map<number, FontEntry>()
  const colors: string[] = ['#000000']
  const styles = new Map<number, StyleDef>()
  const charStyles = new Map<number, StyleDef>()
  const lists = new Map<number, ListDef>()
  const overrides = new Map<number, number>()
  const counters = new Map<number, (number | undefined)[]>()
  const footnotes: Block[][] = []
  const styleCache = new Map<string, TextStyle>()
  const sections: Section[] = []
  let defaultTab = 720
  let deff = 0
  let docCp = 1252
  let facing = false
  let sectdSeen = false
  let docPage: SectionDraft = newSection()
  let sec: SectionDraft = docPage
  let prevHeader: HeaderFooterSet | undefined
  let prevFooter: HeaderFooterSet | undefined
  let colorDraft = { r: -1, g: -1, b: -1 }
  let fontDraft = null as { id: number; name: string; family: string; cp: number | null; symbolic: boolean } | null
  let listDraft: ListDef | null = null
  let levelDraft: LevelDef | null = null
  let overrideDraft: { listid: number; ls: number } | null = null
  let curField: { inst: string } | null = null
  let picture = null as PictureDraft | null
  let footnoteNumber = 0
  let warnedNest = false
  let depthWarned = false
  let unsupportedPict = 0

  function newSection(): SectionDraft {
    return { paperw: 12240, paperh: 15840, margl: 1800, margr: 1800, margt: 1440, margb: 1440, cols: 1, colsx: 720, titlepg: false, headery: 720, footery: 720, header: {}, footer: {} }
  }

  const body = newSink()
  const root: GState = { char: defaultChar(), para: defaultPara(), dest: 'body', uc: 1, skip: 0, ignore: false, cp: 1252, star: false, first: false, bdrTarget: null, sink: body }
  const stack: GState[] = []
  let gs = root
  let rawBuf: number[] = []

  // ---- fonts, colours, text styles ----
  const fontOf = (idx: number): FontEntry => fonts.get(idx < 0 ? deff : idx) ?? fonts.get(deff) ?? { name: 'Arial', family: 'Arial', cp: null, symbolic: false }
  const colorOf = (idx: number): string => (idx <= 0 ? '#000000' : (colors[idx] ?? '#000000'))

  function textStyle(c: CharFmt): TextStyle {
    const font = fontOf(c.f)
    const key = `${font.family}|${c.fs}|${c.b}|${c.i}|${c.ul}|${c.strike}|${c.cf}|${c.hl}|${c.sup}|${c.sub}|${c.caps}|${c.scaps}|${c.spacing}`
    let s = styleCache.get(key)
    if (!s) {
      s = {
        family: font.family,
        size: Math.max(1, c.fs / 2),
        bold: c.b,
        italic: c.i,
        underline: c.ul,
        strike: c.strike,
        color: colorOf(c.cf),
        highlight: c.hl > 0 ? colorOf(c.hl) : undefined,
        vertAlign: c.sup ? 'super' : c.sub ? 'sub' : undefined,
        caps: c.caps || undefined,
        smallCaps: c.scaps || undefined,
        spacing: c.spacing || undefined
      }
      styleCache.set(key, s)
    }
    return s
  }

  // ---- text output ----
  function flushRaw(): void {
    if (rawBuf.length === 0) return
    const buf = Uint8Array.from(rawBuf)
    rawBuf = []
    const font = fontOf(gs.char.f)
    if (font.symbolic) {
      let s = ''
      for (const x of buf) s += SYMBOL_MAP[x] ?? (x < 128 ? String.fromCharCode(x) : decoderFor(1252)(Uint8Array.of(x)))
      emit(s)
      return
    }
    emit(decoderFor(font.cp ?? gs.cp)(buf))
  }

  function emit(text: string): void {
    if (!text || gs.ignore) return
    if (gs.dest === 'listtext') {
      gs.sink.pendingList = (gs.sink.pendingList ?? '') + text
      return
    }
    if (gs.dest === 'fldinst') {
      if (curField) curField.inst += text
      return
    }
    if (gs.dest === 'colortbl') {
      for (const ch of text) if (ch === ';') pushColor()
      return
    }
    if (gs.dest === 'fonttbl') {
      if (fontDraft) {
        for (const ch of text) {
          if (ch === ';') commitFont()
          else fontDraft.name += ch
        }
      }
      return
    }
    if (gs.dest === 'style') return
    if (gs.dest === 'leveltext') {
      if (levelDraft) for (const ch of text) levelDraft.codes.push(ch.charCodeAt(0))
      return
    }
    if (gs.dest !== 'body' && gs.dest !== 'fldrslt') return
    if (gs.char.hidden) return
    let t = text
    // Private-use symbol-font code points (U+F0xx) map to their symbol characters.
    if (/[-]/.test(t)) t = t.replace(/[-]/g, (c) => SYMBOL_MAP[c.charCodeAt(0) - 0xf000] ?? '•')
    pushText(gs.sink, t, textStyle(gs.char))
  }

  function pushText(sink: Sink, text: string, style: TextStyle, link?: string): void {
    const last = sink.inlines[sink.inlines.length - 1]
    if (last && last.k === 'text' && last.style === style && last.link === link) last.text += text
    else sink.inlines.push({ k: 'text', text, style, link })
  }

  function pushColor(): void {
    const c = colorDraft
    colors.push(c.r < 0 && c.g < 0 && c.b < 0 ? '#000000' : `#${[c.r, c.g, c.b].map((v) => Math.max(0, v).toString(16).padStart(2, '0')).join('')}`)
    colorDraft = { r: -1, g: -1, b: -1 }
  }

  function commitFont(): void {
    if (!fontDraft) return
    const name = fontDraft.name.trim()
    if (name || fonts.has(fontDraft.id) === false) {
      const nm = name || fontDraft.family
      fonts.set(fontDraft.id, { name: nm, family: nm, cp: fontDraft.cp, symbolic: fontDraft.symbolic || /^(symbol|wingdings|webdings|zapfdingbats)/i.test(nm) })
    }
    fontDraft = null
  }

  // ---- paragraphs and tables ----
  function borderSpec(d: BorderDraft | undefined): BorderSpec | null | undefined {
    if (!d) return undefined
    if (d.style === 'nil') return null
    return { color: colorOf(d.cf), width: Math.max(0.25, tw(d.w || 10)), style: d.style }
  }

  function markerFor(p: ParaFmt): { text: string; li?: number; fi?: number } | null {
    if (!p.ls) return null
    const listId = overrides.get(p.ls) ?? p.ls
    const list = lists.get(listId)
    if (!list) return null
    const lvl = Math.min(8, Math.max(0, p.ilvl))
    const def = list.levels[lvl] ?? list.levels[list.levels.length - 1]
    if (!def) return null
    let cs = counters.get(listId)
    if (!cs) counters.set(listId, (cs = []))
    const startOf = (i: number): number => list.levels[i]?.start ?? 1
    cs[lvl] = cs[lvl] === undefined ? startOf(lvl) : (cs[lvl] as number) + 1
    for (let j = lvl + 1; j < 9; j++) cs[j] = undefined
    let text = ''
    if (def.nfc === 23) {
      const code = def.codes.length > 1 ? def.codes[1] : 0xb7
      if (code >= 0xf000 && code <= 0xf0ff) text = SYMBOL_MAP[code - 0xf000] ?? '•'
      else if (code === 0xb7 || code < 32 || code === 0x3b) text = '•'
      else if (code > 0xff) text = String.fromCharCode(code)
      else text = SYMBOL_MAP[code] ?? (lvl % 3 === 1 ? '◦' : lvl % 3 === 2 ? '▪' : '•')
      if (code === 0x6f) text = '◦'
    } else {
      const codes = def.codes.slice(1).filter((c, i, a) => !(i === a.length - 1 && c === 0x3b))
      for (const c of codes) {
        if (c < 9) {
          const v = cs[c] ?? startOf(c)
          text += formatNumber(v, list.levels[c]?.nfc ?? 0)
        } else text += String.fromCharCode(c)
      }
      if (!codes.length) text = `${formatNumber(cs[lvl] as number, def.nfc)}.`
    }
    return { text, li: def.li, fi: def.fi }
  }

  function makePara(sink: Sink, g: GState): Paragraph {
    const p = g.para
    const mark = textStyle(g.char)
    const lm = markerFor(p)
    let marker: ParaProps['marker']
    if (lm) marker = { text: lm.text, style: { ...mark, underline: false, strike: false, highlight: undefined } }
    else if (sink.pendingList) {
      const t = sink.pendingList.replace(/[\t ]+$/g, '').replace(/^[\t ]+/g, '')
      if (t) marker = { text: t, style: { ...mark, underline: false, strike: false } }
    }
    sink.pendingList = undefined
    const li = p.li ?? lm?.li ?? 0
    const fi = p.fi ?? (lm ? (lm.fi ?? 0) : 0)
    const props: ParaProps = {
      ...DEFAULT_PARA_PROPS,
      align: p.qa,
      spaceBefore: tw(p.sb),
      spaceAfter: tw(p.sa),
      line: p.sl === 0 ? { rule: 'auto', value: 1 } : p.slmult === 1 ? { rule: 'auto', value: Math.max(0.1, p.sl / 240) } : p.sl > 0 ? { rule: 'atLeast', value: tw(p.sl) } : { rule: 'exact', value: tw(-p.sl) },
      indentLeft: tw(li),
      indentRight: tw(p.ri ?? 0),
      firstLine: tw(fi),
      tabs: p.tabs.map((t) => ({ pos: tw(t.pos), align: t.align, leader: t.leader })),
      keepNext: p.keepn,
      keepLines: p.keep,
      pageBreakBefore: p.pagebb,
      widowControl: p.widow,
      shading: p.shade > 0 ? colorOf(p.shade) : undefined,
      rtl: p.rtl || undefined,
      marker
    }
    const bd = p.bdr
    if (bd.t || bd.b || bd.l || bd.r) {
      const pick = (d?: BorderDraft): BorderSpec | undefined => borderSpec(d) ?? undefined
      props.borders = { top: pick(bd.t), bottom: pick(bd.b), left: pick(bd.l), right: pick(bd.r) }
    }
    const inlines = sink.inlines
    sink.inlines = []
    return { k: 'p', props, inlines, markStyle: mark }
  }

  function endParagraph(): void {
    flushRaw()
    const sink = gs.sink
    const p = makePara(sink, gs)
    if (gs.para.intbl) sink.cellBlocks.push(p)
    else {
      flushTable(sink)
      sink.blocks.push(p)
    }
  }

  function endCell(): void {
    flushRaw()
    const sink = gs.sink
    if (sink.inlines.length > 0 || sink.cellBlocks.length === 0) sink.cellBlocks.push(makePara(sink, { ...gs, para: { ...gs.para, intbl: true } }))
    sink.rowCells.push({ blocks: sink.cellBlocks })
    sink.cellBlocks = []
  }

  function endRow(): void {
    flushRaw()
    const sink = gs.sink
    if (sink.inlines.length > 0) endCell()
    if (sink.rowCells.length) sink.rows.push({ cells: sink.rowCells, def: sink.rowDef })
    sink.rowCells = []
    sink.cellBlocks = []
    // the next row starts from a copy of this definition (a following \trowd replaces it)
    sink.rowDef = { ...sink.rowDef, cells: sink.rowDef.cells.map((c) => ({ ...c })), cur: newCellDef() }
  }

  function flushTable(sink: Sink): void {
    if (sink.rows.length === 0) return
    sink.blocks.push(buildTable(sink.rows))
    sink.rows = []
  }

  function buildTable(rows: RawRow[]): Table {
    // 1. grid boundaries (twips) across all rows
    const positions: number[] = []
    const rowCellsPos: { cell: RawCell; def: CellDef; l: number; r: number; hidden: boolean }[][] = []
    for (const row of rows) {
      const d = row.def
      let cellDefs = d.cells
      if (cellDefs.length === 0 || cellDefs.length < row.cells.length) {
        // no (or short) definition: split the text width evenly
        const total = 12240 - 1800 * 2
        const n = row.cells.length
        cellDefs = Array.from({ length: n }, (_, i) => ({ ...newCellDef(), right: Math.round(((i + 1) * total) / n) }))
      }
      const out: { cell: RawCell; def: CellDef; l: number; r: number; hidden: boolean }[] = []
      let left = d.cells.length ? d.left : 0
      row.cells.forEach((cell, i) => {
        const def = cellDefs[i] ?? cellDefs[cellDefs.length - 1]
        const right = def.right || left + 1440
        out.push({ cell, def, l: left, r: right, hidden: false })
        left = right
      })
      // horizontal merges: \clmgf starts, \clmrg continues
      const merged: typeof out = []
      for (const c of out) {
        const prev = merged[merged.length - 1]
        if (c.def.hmerge === 2 && prev) {
          prev.r = c.r
          // keep the text of merged-away cells (normally empty)
          if (c.cell.blocks.some((b) => b.k === 'p' && b.inlines.length)) prev.cell.blocks.push(...c.cell.blocks)
        } else merged.push(c)
      }
      rowCellsPos.push(merged)
      for (const c of merged) positions.push(c.l, c.r)
    }
    positions.sort((a, b) => a - b)
    const grid: number[] = []
    for (const p of positions) if (grid.length === 0 || p - grid[grid.length - 1] > 12) grid.push(p)
    const idxOf = (p: number): number => {
      let best = 0
      let bd = Infinity
      grid.forEach((g, i) => {
        const dd = Math.abs(g - p)
        if (dd < bd) {
          bd = dd
          best = i
        }
      })
      return best
    }
    const colWidths = grid.slice(1).map((g, i) => tw(g - grid[i]))
    const first = rows[0].def
    const padL = tw(first.padL ?? first.gaph)
    const padR = tw(first.padR ?? first.gaph)
    const built: Row[] = []
    const open = new Map<number, Cell>()
    rows.forEach((row, ri) => {
      const cells: Cell[] = []
      for (const c of rowCellsPos[ri]) {
        const gi = idxOf(c.l)
        const gj = Math.max(gi + 1, idxOf(c.r))
        if (c.def.vmerge === 2) {
          const owner = open.get(gi)
          if (owner) {
            owner.rowSpan++
            continue
          }
        }
        const b = c.def.bdr
        const cell: Cell = {
          blocks: c.cell.blocks.length ? c.cell.blocks : [emptyPara()],
          colSpan: gj - gi,
          rowSpan: 1,
          shading: c.def.shade > 0 ? colorOf(c.def.shade) : undefined,
          vAlign: c.def.vAlign
        }
        if (b.t || b.b || b.l || b.r) cell.borders = { top: borderSpec(b.t), bottom: borderSpec(b.b), left: borderSpec(b.l), right: borderSpec(b.r) }
        cells.push(cell)
        if (c.def.vmerge === 1) open.set(gi, cell)
        else open.delete(gi)
      }
      built.push({
        cells,
        height: row.def.height ? { value: tw(Math.abs(row.def.height)), rule: row.def.height < 0 ? 'exact' : 'atLeast' } : undefined,
        header: row.def.header,
        cantSplit: row.def.keep
      })
    })
    const tb = first.bdr
    const one = (d?: BorderDraft): BorderSpec | undefined => borderSpec(d) ?? undefined
    return {
      k: 'table',
      colWidths,
      rows: built,
      borders: { top: one(tb.t), bottom: one(tb.b), left: one(tb.l), right: one(tb.r), insideH: one(tb.h), insideV: one(tb.v) },
      padding: { top: 0, bottom: 0, left: padL, right: padR },
      align: first.align,
      indent: tw(first.left)
    }
  }

  const emptyPara = (): Paragraph => ({ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: textStyle(defaultChar()) })

  // ---- sections ----
  function finishSectionBlocks(): void {
    flushRaw()
    if (gs.sink.inlines.length) endParagraph()
    flushTable(body)
  }

  function pageFor(s: SectionDraft): Section['page'] {
    return pageOf(s.paperw, s.paperh, s.margl, s.margr, s.margt, s.margb, s.headery, s.footery)
  }

  function closeSection(final: boolean): void {
    const blocks = body.blocks
    body.blocks = []
    if (final && blocks.length === 0 && sections.length > 0) return
    const header = Object.keys(sec.header).length ? sec.header : prevHeader
    const footer = Object.keys(sec.footer).length ? sec.footer : prevFooter
    prevHeader = header
    prevFooter = footer
    const s: Section = {
      page: pageFor(sec),
      type: 'nextPage',
      blocks: blocks.length ? blocks : [emptyPara()],
      header,
      footer,
      titlePg: sec.titlepg || undefined,
      evenAndOdd: facing || undefined,
      pageNumberStart: sec.pgnstart
    }
    if (sec.cols > 1) s.columns = { count: sec.cols, gap: tw(sec.colsx) }
    sections.push(s)
  }

  // ---- control words ----
  function applyChar(c: CharFmt, name: string, p: number | undefined): boolean {
    switch (name) {
      case 'plain':
        Object.assign(c, defaultChar(), { f: -1 })
        return true
      case 'b':
        c.b = p !== 0
        return true
      case 'i':
        c.i = p !== 0
        return true
      case 'ul':
      case 'uldb':
      case 'ulw':
      case 'uld':
      case 'uldash':
      case 'ulth':
      case 'ulwave':
        c.ul = p !== 0
        return true
      case 'ulnone':
      case 'ulnone_':
        c.ul = false
        return true
      case 'strike':
      case 'striked':
        c.strike = p !== 0
        return true
      case 'fs':
        if (p !== undefined && p > 0) c.fs = p
        return true
      case 'f':
        if (p !== undefined) c.f = p
        return true
      case 'cf':
        c.cf = p ?? 0
        return true
      case 'cb':
      case 'highlight':
        c.hl = p ?? 0
        return true
      case 'super':
        c.sup = p !== 0
        if (c.sup) c.sub = false
        return true
      case 'sub':
        c.sub = p !== 0
        if (c.sub) c.sup = false
        return true
      case 'nosupersub':
        c.sup = c.sub = false
        return true
      case 'caps':
        c.caps = p !== 0
        return true
      case 'scaps':
        c.scaps = p !== 0
        return true
      case 'v':
        c.hidden = p !== 0
        return true
      case 'expndtw':
        c.spacing = tw(p ?? 0)
        return true
      case 'expnd':
        c.spacing = (p ?? 0) / 4
        return true
    }
    return false
  }

  function newBorder(g: GState, side: keyof Sides | 'box', scope: 'para' | 'cell' | 'row', rowSide?: 'h' | 'v'): void {
    const d: BorderDraft = { style: 'single', w: 15, cf: 0 }
    g.bdrTarget = d
    if (scope === 'para') {
      const b: Sides = { ...g.para.bdr }
      if (side === 'box') b.t = b.b = b.l = b.r = d
      else b[side] = d
      g.para = { ...g.para, bdr: b }
    } else if (scope === 'cell') {
      g.sink.rowDef.cur.bdr[side as keyof Sides] = d
    } else {
      const rd = g.sink.rowDef
      if (rowSide) (rd.bdr as Record<string, BorderDraft>)[rowSide] = d
      else rd.bdr[side as keyof Sides] = d
    }
  }

  function applyPara(g: GState, name: string, p: number | undefined): boolean {
    const pf = g.para
    switch (name) {
      case 'pard':
        g.para = { ...defaultPara(), intbl: false }
        g.bdrTarget = null
        return true
      case 'ql':
        pf.qa = 'left'
        return true
      case 'qr':
        pf.qa = 'right'
        return true
      case 'qc':
        pf.qa = 'center'
        return true
      case 'qj':
      case 'qd':
        pf.qa = 'justify'
        return true
      case 'li':
      case 'lin':
        pf.li = p ?? 0
        return true
      case 'ri':
      case 'rin':
        pf.ri = p ?? 0
        return true
      case 'fi':
        pf.fi = p ?? 0
        return true
      case 'sb':
        pf.sb = Math.max(0, p ?? 0)
        return true
      case 'sa':
        pf.sa = Math.max(0, p ?? 0)
        return true
      case 'sl':
        pf.sl = p ?? 0
        return true
      case 'slmult':
        pf.slmult = p ?? 0
        return true
      case 'keep':
        pf.keep = true
        return true
      case 'keepn':
        pf.keepn = true
        return true
      case 'pagebb':
        pf.pagebb = true
        return true
      case 'widctlpar':
        pf.widow = true
        return true
      case 'nowidctlpar':
        pf.widow = false
        return true
      case 'rtlpar':
        pf.rtl = true
        return true
      case 'ltrpar':
        pf.rtl = false
        return true
      case 'intbl':
        pf.intbl = true
        return true
      case 'ls':
        pf.ls = p ?? 0
        return true
      case 'ilvl':
        pf.ilvl = p ?? 0
        return true
      case 'cbpat':
        pf.shade = p ?? 0
        return true
      case 'tqr':
        pf.nextTabAlign = 'right'
        return true
      case 'tqc':
        pf.nextTabAlign = 'center'
        return true
      case 'tqdec':
        pf.nextTabAlign = 'decimal'
        return true
      case 'tldot':
        pf.nextLeader = 'dot'
        return true
      case 'tlhyph':
      case 'tlth':
        pf.nextLeader = 'hyphen'
        return true
      case 'tlul':
        pf.nextLeader = 'underscore'
        return true
      case 'tlmdot':
        pf.nextLeader = 'middleDot'
        return true
      case 'tx':
        g.para = { ...pf, tabs: [...pf.tabs, { pos: p ?? 0, align: pf.nextTabAlign, leader: pf.nextLeader }], nextTabAlign: 'left', nextLeader: undefined }
        return true
      case 'brdrt':
        newBorder(g, 't', 'para')
        return true
      case 'brdrb':
        newBorder(g, 'b', 'para')
        return true
      case 'brdrl':
        newBorder(g, 'l', 'para')
        return true
      case 'brdrr':
        newBorder(g, 'r', 'para')
        return true
      case 'box':
        newBorder(g, 'box', 'para')
        return true
    }
    return false
  }

  function applyBorderProp(g: GState, name: string, p: number | undefined): boolean {
    const d = g.bdrTarget
    if (!d) return false
    switch (name) {
      case 'brdrs':
      case 'brdrth':
      case 'brdrsh':
      case 'brdrhair':
        d.style = 'single'
        return true
      case 'brdrdb':
        d.style = 'double'
        return true
      case 'brdrdot':
        d.style = 'dotted'
        return true
      case 'brdrdash':
      case 'brdrdashsm':
      case 'brdrdashd':
      case 'brdrdashdd':
        d.style = 'dashed'
        return true
      case 'brdrnil':
      case 'brdrnone':
        d.style = 'nil'
        return true
      case 'brdrw':
        d.w = p ?? 15
        return true
      case 'brdrcf':
        d.cf = p ?? 0
        return true
    }
    return false
  }

  function applyRow(g: GState, name: string, p: number | undefined): boolean {
    const rd = g.sink.rowDef
    switch (name) {
      case 'trowd':
        g.sink.rowDef = newRowDef()
        return true
      case 'trgaph':
        rd.gaph = p ?? 108
        return true
      case 'trleft':
        rd.left = p ?? 0
        return true
      case 'trpaddl':
        rd.padL = p ?? 0
        return true
      case 'trpaddr':
        rd.padR = p ?? 0
        return true
      case 'trhdr':
        rd.header = true
        return true
      case 'trkeep':
        rd.keep = true
        return true
      case 'trrh':
        rd.height = p ?? 0
        return true
      case 'trqc':
        rd.align = 'center'
        return true
      case 'trqr':
        rd.align = 'right'
        return true
      case 'trbrdrt':
        newBorder(g, 't', 'row')
        return true
      case 'trbrdrb':
        newBorder(g, 'b', 'row')
        return true
      case 'trbrdrl':
        newBorder(g, 'l', 'row')
        return true
      case 'trbrdrr':
        newBorder(g, 'r', 'row')
        return true
      case 'trbrdrh':
        newBorder(g, 't', 'row', 'h')
        return true
      case 'trbrdrv':
        newBorder(g, 't', 'row', 'v')
        return true
      case 'clbrdrt':
        newBorder(g, 't', 'cell')
        return true
      case 'clbrdrb':
        newBorder(g, 'b', 'cell')
        return true
      case 'clbrdrl':
        newBorder(g, 'l', 'cell')
        return true
      case 'clbrdrr':
        newBorder(g, 'r', 'cell')
        return true
      case 'clmgf':
        rd.cur.hmerge = 1
        return true
      case 'clmrg':
        rd.cur.hmerge = 2
        return true
      case 'clvmgf':
        rd.cur.vmerge = 1
        return true
      case 'clvmrg':
        rd.cur.vmerge = 2
        return true
      case 'clcbpat':
        rd.cur.shade = p ?? 0
        return true
      case 'clvertalc':
        rd.cur.vAlign = 'center'
        return true
      case 'clvertalb':
        rd.cur.vAlign = 'bottom'
        return true
      case 'clvertalt':
        rd.cur.vAlign = 'top'
        return true
      case 'cellx':
        rd.cur.right = p ?? 0
        rd.cells.push(rd.cur)
        rd.cur = newCellDef()
        return true
    }
    return false
  }

  function applySection(name: string, p: number | undefined): boolean {
    const set = (k: keyof SectionDraft, v: number): void => {
      ;(sec as unknown as Record<string, number>)[k] = v
      if (!sectdSeen) (docPage as unknown as Record<string, number>)[k] = v
    }
    switch (name) {
      case 'paperw':
      case 'pgwsxn':
        if (p) set('paperw', p)
        return true
      case 'paperh':
      case 'pghsxn':
        if (p) set('paperh', p)
        return true
      case 'margl':
      case 'marglsxn':
        set('margl', p ?? 0)
        return true
      case 'margr':
      case 'margrsxn':
        set('margr', p ?? 0)
        return true
      case 'margt':
      case 'margtsxn':
        set('margt', p ?? 0)
        return true
      case 'margb':
      case 'margbsxn':
        set('margb', p ?? 0)
        return true
      case 'headery':
        set('headery', p ?? 720)
        return true
      case 'footery':
        set('footery', p ?? 720)
        return true
      case 'cols':
        sec.cols = p ?? 1
        return true
      case 'colsx':
        sec.colsx = p ?? 720
        return true
      case 'titlepg':
        sec.titlepg = true
        return true
      case 'pgnstarts':
        sec.pgnstart = p ?? 1
        return true
    }
    return false
  }

  function replayStyle(id: number, map: Map<number, StyleDef>, depth = 0): void {
    const st = map.get(id)
    if (!st || depth > 20) return
    if (st.basedOn !== undefined && st.basedOn !== id) replayStyle(st.basedOn, map, depth + 1)
    for (const t of st.tokens) {
      if (applyChar(gs.char, t.name, t.param)) continue
      if (applyPara(gs, t.name, t.param)) continue
      applyBorderProp(gs, t.name, t.param)
    }
  }

  function startGroupDest(name: string, g: GState): boolean {
    // returns true when the word started a destination
    const star = g.star
    switch (name) {
      case 'fonttbl':
        g.dest = 'fonttbl'
        return true
      case 'colortbl':
        g.dest = 'colortbl'
        colorDraft = { r: -1, g: -1, b: -1 }
        return true
      case 'stylesheet':
        g.dest = 'stylesheet'
        return true
      case 'listtable':
        g.dest = 'listtable'
        return true
      case 'listoverridetable':
        g.dest = 'listoverridetable'
        return true
      case 'list':
        if (g.dest === 'listtable') {
          g.dest = 'list'
          listDraft = { id: 0, levels: [] }
          const ld = listDraft
          g.onClose = () => {
            if (ld.id) lists.set(ld.id, ld)
            listDraft = null
          }
          return true
        }
        return false
      case 'listlevel':
        if (g.dest === 'list') {
          g.dest = 'listlevel'
          levelDraft = { nfc: 0, start: 1, codes: [] }
          listDraft?.levels.push(levelDraft)
          return true
        }
        return false
      case 'leveltext':
        if (g.dest === 'listlevel') {
          g.dest = 'leveltext'
          return true
        }
        return false
      case 'listoverride':
        if (g.dest === 'listoverridetable') {
          g.dest = 'listoverride'
          overrideDraft = { listid: 0, ls: 0 }
          const od = overrideDraft
          g.onClose = () => {
            if (od.ls && od.listid) overrides.set(od.ls, od.listid)
            overrideDraft = null
          }
          return true
        }
        return false
      case 'fldinst':
        g.dest = 'fldinst'
        return true
      case 'field':
        {
          const prev = curField
          curField = { inst: '' }
          g.onClose = () => {
            curField = prev
          }
        }
        return true
      case 'fldrslt': {
        const sink = g.sink
        const fld = curField
        const kind = (fld?.inst ?? '').trim().toUpperCase()
        const startIdx = sink.inlines.length
        if (/^(PAGE|SECTIONPAGES)\b/.test(kind) || /^NUMPAGES\b/.test(kind)) {
          const isPages = /^NUMPAGES\b/.test(kind)
          sink.inlines.push({ k: 'field', field: isPages ? 'pages' : 'page', style: textStyle(g.char) })
          g.ignore = true
        } else {
          g.dest = 'fldrslt'
          const m = /^HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]+)"/i.exec((fld?.inst ?? '').trim())
          const url = m && /^(https?:|mailto:)/i.test(m[1]) ? m[1] : undefined
          if (url) {
            g.onClose = () => {
              for (let i = startIdx; i < sink.inlines.length; i++) {
                const il = sink.inlines[i]
                if (il.k === 'text') il.link = url
              }
              // re-merge would be needless: link differs only on these runs
            }
          }
        }
        return true
      }
      case 'pict':
        g.dest = 'pict'
        picture = { format: null, hex: '', bin: [], w: 0, h: 0, wg: 0, hg: 0, sx: 100, sy: 100, kind: '' }
        {
          const sink = g.sink
          const st = textStyle(g.char)
          g.onClose = () => {
            const pic = picture
            picture = null
            if (!pic) return
            finishPicture(sink, pic, st)
          }
        }
        return true
      case 'listtext':
      case 'pntext':
        g.dest = 'listtext'
        return true
      case 'header':
      case 'headerr':
      case 'headerl':
      case 'headerf':
      case 'footer':
      case 'footerr':
      case 'footerl':
      case 'footerf': {
        const sink = newSink()
        const isHeader = name.startsWith('header')
        const slot: 'default' | 'first' | 'even' = name.endsWith('f') ? 'first' : name.endsWith('l') ? 'even' : 'default'
        g.sink = sink
        const secRef = sec
        g.onClose = () => {
          flushTable(sink)
          if (sink.inlines.length) {
            const p = makePara(sink, { ...gs, sink })
            sink.blocks.push(p)
          }
          const set = isHeader ? secRef.header : secRef.footer
          if (sink.blocks.length) set[slot] = sink.blocks
        }
        // paragraph state inside starts fresh
        g.para = defaultPara()
        return true
      }
      case 'footnote': {
        const sink = newSink()
        const n = ++footnoteNumber
        g.sink = sink
        g.para = defaultPara()
        g.onClose = () => {
          flushTable(sink)
          if (sink.inlines.length) sink.blocks.push(makePara(sink, { ...gs, sink }))
          footnotes[n - 1] = sink.blocks
        }
        return true
      }
      case 'shp':
      case 'shpinst':
      case 'shptxt':
      case 'shpgrp':
      case 'object':
      case 'result':
      case 'shppict':
      case 'do':
        if (name === 'shpinst' || name === 'do') warn('Drawing shapes are not supported; text inside text boxes is kept in the flow.')
        return true // transparent groups
      default:
        break
    }
    if (star && g.dest === 'stylesheet') return false // \*\csN character styles
    if (DEST_SKIP.has(name) || (star && !['fldinst'].includes(name))) {
      g.ignore = true
      return true
    }
    return false
  }

  function finishPicture(sink: Sink, pic: PictureDraft, style: TextStyle): void {
    let data: Uint8Array | null = null
    if (pic.bin.length) {
      const total = pic.bin.reduce((s, b) => s + b.length, 0)
      data = new Uint8Array(total)
      let o = 0
      for (const b of pic.bin) {
        data.set(b, o)
        o += b.length
      }
    } else if (pic.hex) {
      const hex = pic.hex.replace(/[^0-9a-fA-F]/g, '')
      data = new Uint8Array(hex.length >> 1)
      for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16)
    }
    if (!data || data.length === 0) return
    const fmt = pic.format ?? (data[0] === 0x89 && data[1] === 0x50 ? 'png' : data[0] === 0xff && data[1] === 0xd8 ? 'jpeg' : null)
    if (!fmt) {
      unsupportedPict++
      warn(`A picture in this format (${pic.kind || 'metafile/bitmap'}) is not supported and was replaced by a placeholder.`)
      pushText(sink, `[Image: ${pic.kind || 'unsupported picture'} not supported]`, { ...style, italic: true })
      return
    }
    const wPt = pic.wg > 0 ? tw(pic.wg) * (pic.sx / 100) : pic.w > 0 ? ((pic.w * 72) / 2540) * (pic.sx / 100) : 100
    const hPt = pic.hg > 0 ? tw(pic.hg) * (pic.sy / 100) : pic.h > 0 ? ((pic.h * 72) / 2540) * (pic.sy / 100) : 100
    const image: ImageData = { bytes: data, format: fmt }
    sink.inlines.push({ k: 'image', image, w: Math.max(1, wPt), h: Math.max(1, hPt), style })
  }

  // ---- main loop ----
  const lexer = new Lexer(bytes)
  let tokenCount = 0
  for (let tok = lexer.next(); tok; tok = lexer.next()) {
    if ((++tokenCount & 0x3fff) === 0) throwIfCancelled(env)
    // \ucN skipping
    if (gs.skip > 0) {
      if (tok.t === 'text') {
        const k = Math.min(gs.skip, tok.bytes.length)
        gs.skip -= k
        if (k >= tok.bytes.length) continue
        tok = { t: 'text', bytes: tok.bytes.subarray(k) }
      } else if (tok.t === 'hex') {
        gs.skip--
        continue
      } else if (tok.t === 'word' && tok.name === 'u') {
        // consecutive \u escapes: fall through to handle it (skip counter reset below)
      } else gs.skip = 0
    }
    switch (tok.t) {
      case 'open': {
        flushRaw()
        if (stack.length >= 1000) {
          if (!depthWarned) {
            warn('This file nests groups unusually deeply; the deepest content was skipped.')
            depthWarned = true
          }
          stack.push(gs)
          gs = { ...gs, ignore: true, first: false, onClose: undefined }
          break
        }
        stack.push(gs)
        gs = { ...gs, char: { ...gs.char }, para: { ...gs.para }, first: true, star: false, onClose: undefined, skip: 0, styleId: undefined, styleKind: undefined }
        break
      }
      case 'close': {
        flushRaw()
        const cl = gs.onClose
        if (cl) cl()
        if (gs.dest === 'fonttbl' && fontDraft) commitFont()
        const prev = stack.pop()
        if (prev) {
          // stylesheet entries end with their group
          gs = prev
        } else {
          // unbalanced close: ignore
        }
        break
      }
      case 'sym': {
        const wasFirst = gs.first
        gs.first = false
        if (tok.ch === '*') {
          if (wasFirst) {
            gs.star = true
            gs.first = true // the next word decides the destination
          }
          break
        }
        if (gs.ignore) break
        flushRaw()
        if (tok.ch === '~') emit(' ')
        else if (tok.ch === '_') emit('‑')
        else if (tok.ch === '\\' || tok.ch === '{' || tok.ch === '}') emit(tok.ch)
        break
      }
      case 'hex': {
        gs.first = false
        if (gs.ignore) break
        rawBuf.push(tok.code)
        break
      }
      case 'text': {
        gs.first = false
        if (gs.ignore) break
        if (gs.dest === 'pict') {
          if (picture) picture.hex += latin1(tok.bytes)
          break
        }
        if (gs.dest === 'stylesheet' || gs.dest === 'style') {
          // style names: ignore
          break
        }
        if (gs.dest === 'fonttbl' || gs.dest === 'colortbl' || gs.dest === 'leveltext' || gs.dest === 'fldinst') {
          // ascii-only content; decode directly (after any pending \'hh bytes so the order is kept)
          flushRaw()
          emit(latin1(tok.bytes))
          break
        }
        for (const x of tok.bytes) rawBuf.push(x)
        break
      }
      case 'bin': {
        gs.first = false
        if (gs.dest === 'pict' && picture && !gs.ignore) picture.bin.push(tok.bytes)
        break
      }
      case 'word': {
        flushRawIfNeeded(tok.name)
        handleWord(tok.name, tok.param)
        break
      }
    }
  }
  flushRaw()
  // unclosed groups: run their close hooks so headers etc. are not lost
  while (stack.length > 0) {
    if (gs.onClose) gs.onClose()
    gs = stack.pop() as GState
  }
  gs = root
  finishSectionBlocks()
  closeSection(true)

  function flushRawIfNeeded(name: string): void {
    void name
    flushRaw()
  }

  function handleWord(name: string, p: number | undefined): void {
    const g = gs
    const wasFirst = g.first
    g.first = false
    if (wasFirst && !g.ignore) {
      if (startGroupDest(name, g)) return
      if (g.star && g.dest !== 'stylesheet') {
        g.ignore = true
        return
      }
    }
    if (g.ignore) return

    // ---- destination-specific words ----
    switch (g.dest) {
      case 'fonttbl':
        if (name === 'f') {
          commitFont()
          fontDraft = { id: p ?? 0, name: '', family: 'Arial', cp: null, symbolic: false }
          return
        }
        if (fontDraft) {
          if (name === 'fcharset') {
            fontDraft.cp = p === 2 ? null : (CHARSET_CP[p ?? 0] ?? null)
            if (p === 2) fontDraft.symbolic = true
          }
          else if (name === 'froman') fontDraft.family = 'Times New Roman'
          else if (name === 'fmodern') fontDraft.family = 'Courier New'
          else if (name === 'fswiss' || name === 'fnil' || name === 'fscript' || name === 'fdecor') fontDraft.family = 'Arial'
          else if (name === 'ftech') fontDraft.family = 'Symbol'
        }
        return
      case 'colortbl':
        if (name === 'red') colorDraft.r = p ?? 0
        else if (name === 'green') colorDraft.g = p ?? 0
        else if (name === 'blue') colorDraft.b = p ?? 0
        return
      case 'stylesheet': {
        // a style begins with its number, either directly or in a nested group
        if (name === 's' || name === 'cs' || name === 'ts') {
          g.styleId = p ?? 0
          g.styleKind = name === 'cs' ? 'c' : name === 's' ? 'p' : undefined
          if (g.styleKind) {
            const def: StyleDef = { tokens: [] }
            ;(g.styleKind === 'c' ? charStyles : styles).set(g.styleId, def)
          }
          g.dest = 'style'
        }
        return
      }
      case 'style': {
        const def = (g.styleKind === 'c' ? charStyles : styles).get(g.styleId ?? -1)
        if (!def) return
        if (name === 'sbasedon') def.basedOn = p
        else if (!['snext', 'slink', 'sqformat', 'spriority', 'ssemihidden', 'sunhideused', 'styrsid', 'additive', 'sautoupd', 'slocked'].includes(name)) def.tokens.push({ name, param: p })
        return
      }
      case 'list':
        if (name === 'listid') listDraft && (listDraft.id = p ?? 0)
        return
      case 'listlevel':
        if (!levelDraft) return
        if (name === 'levelnfc' || name === 'levelnfcn') levelDraft.nfc = p ?? 0
        else if (name === 'levelstartat') levelDraft.start = p ?? 1
        else if (name === 'li') levelDraft.li = p
        else if (name === 'fi') levelDraft.fi = p
        return
      case 'leveltext':
        if (name === 'u' && levelDraft) {
          levelDraft.codes.push(((p ?? 0) + 65536) % 65536)
          g.skip = g.uc
        }
        return
      case 'listoverride':
        if (!overrideDraft) return
        if (name === 'listid') overrideDraft.listid = p ?? 0
        else if (name === 'ls') overrideDraft.ls = p ?? 0
        return
      case 'listtable':
      case 'listoverridetable':
        return
      default:
        break
    }

    // ---- body words ----
    if (applyBorderProp(g, name, p)) return
    if (applyChar(g.char, name, p)) return
    if (applyPara(g, name, p)) return
    if (applyRow(g, name, p)) return
    if (applySection(name, p)) return

    switch (name) {
      case 'rtf':
      case 'ansi':
        return
      case 'mac':
        docCp = 10000
        g.cp = 10000
        return
      case 'pc':
        docCp = 437
        g.cp = 437
        return
      case 'pca':
        docCp = 850
        g.cp = 850
        return
      case 'ansicpg':
        docCp = p ?? 1252
        g.cp = docCp
        root.cp = docCp
        return
      case 'deff':
        deff = p ?? 0
        return
      case 'uc':
        g.uc = p ?? 1
        return
      case 'deftab':
        defaultTab = p ?? 720
        return
      case 'facingp':
        facing = true
        return
      case 'landscape':
        return
      case 's':
        replayStyle(p ?? 0, styles)
        return
      case 'cs':
        replayStyle(p ?? 0, charStyles)
        return
      case 'sectd': {
        const firstSectd = !sectdSeen
        sectdSeen = true
        // headers defined before the first \sectd belong to the first section
        sec = { ...docPage, header: firstSectd ? { ...docPage.header } : {}, footer: firstSectd ? { ...docPage.footer } : {}, titlepg: false, pgnstart: undefined, cols: 1, colsx: 720 }
        return
      }
      case 'sect':
        finishSectionBlocks()
        closeSection(false)
        sec = { ...sec, header: {}, footer: {}, titlepg: false, pgnstart: undefined }
        return
      case 'par':
      case 'sbys':
        if (g.dest === 'pict' || g.dest === 'listtext') return
        endParagraph()
        return
      case 'line':
        g.sink.inlines.push({ k: 'br', type: 'line', style: textStyle(g.char) })
        return
      case 'page':
        g.sink.inlines.push({ k: 'br', type: 'page', style: textStyle(g.char) })
        return
      case 'column':
        g.sink.inlines.push({ k: 'br', type: 'column', style: textStyle(g.char) })
        return
      case 'tab':
        if (g.dest === 'body' || g.dest === 'fldrslt') g.sink.inlines.push({ k: 'tab', style: textStyle(g.char) })
        return
      case 'cell':
        endCell()
        return
      case 'row':
        endRow()
        return
      case 'nestcell':
        if (!warnedNest) {
          warn('Nested tables are flattened into their parent cell.')
          warnedNest = true
        }
        endParagraph()
        return
      case 'nestrow':
        return
      case 'chpgn':
        g.sink.inlines.push({ k: 'field', field: 'page', style: textStyle(g.char) })
        return
      case 'chftn':
        emit(String(inFootnote(g) ? footnoteNumber : footnoteNumber + 1))
        return
      case 'emdash':
        emit('—')
        return
      case 'endash':
        emit('–')
        return
      case 'emspace':
      case 'enspace':
      case 'qmspace':
        emit(' ')
        return
      case 'bullet':
        emit('•')
        return
      case 'lquote':
        emit('‘')
        return
      case 'rquote':
        emit('’')
        return
      case 'ldblquote':
        emit('“')
        return
      case 'rdblquote':
        emit('”')
        return
      case 'u': {
        flushRaw()
        const code = ((p ?? 0) + 65536) % 65536
        if (g.dest === 'listtext' || g.dest === 'body' || g.dest === 'fldrslt' || g.dest === 'fldinst') emit(String.fromCharCode(code))
        g.skip = g.uc
        return
      }
      case 'pngblip':
        if (picture) {
          picture.format = 'png'
          picture.kind = 'png'
        }
        return
      case 'jpegblip':
        if (picture) {
          picture.format = 'jpeg'
          picture.kind = 'jpeg'
        }
        return
      case 'emfblip':
      case 'wmetafile':
      case 'dibitmap':
      case 'wbitmap':
      case 'macpict':
      case 'pmmetafile':
        if (picture) picture.kind = name === 'emfblip' ? 'EMF' : name === 'wmetafile' ? 'WMF' : name
        return
      case 'picw':
        if (picture) picture.w = p ?? 0
        return
      case 'pich':
        if (picture) picture.h = p ?? 0
        return
      case 'picwgoal':
        if (picture) picture.wg = p ?? 0
        return
      case 'pichgoal':
        if (picture) picture.hg = p ?? 0
        return
      case 'picscalex':
        if (picture) picture.sx = p ?? 100
        return
      case 'picscaley':
        if (picture) picture.sy = p ?? 100
        return
      default:
        return
    }
  }

  function inFootnote(g: GState): boolean {
    return g.sink !== body
  }

  // ---- footnotes at the end ----
  if (footnotes.length > 0) {
    warn('Footnotes and endnotes are moved to the end of the document.')
    const last = sections[sections.length - 1]
    const base = baseStyle('Arial', 9)
    const rule: Paragraph = { k: 'p', props: { ...DEFAULT_PARA_PROPS, spaceBefore: 12, borders: { top: { color: '#000000', width: 0.5, style: 'single' } } }, inlines: [], markStyle: base }
    last.blocks.push(rule)
    footnotes.forEach((blocks, i) => {
      const num: Inline = { k: 'text', text: `${i + 1} `, style: { ...base, vertAlign: 'super' } }
      const bl = blocks ?? []
      if (bl.length === 0) bl.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: base })
      const firstP = bl.find((b): b is Paragraph => b.k === 'p')
      const lead = firstP?.inlines[0]
      // footnotes normally carry their own (\chftn) number; add one only when they do not
      if (firstP && !(lead && lead.k === 'text' && lead.text.trim().startsWith(String(i + 1)))) firstP.inlines.unshift(num)
      last.blocks.push(...bl)
    })
  }
  void unsupportedPict

  return { sections, defaultTabStop: tw(defaultTab) || 36 }
}

function latin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}

function baseStyle(family: string, size: number): TextStyle {
  return { family, size, bold: false, italic: false, underline: false, strike: false, color: '#000000' }
}

function pageOf(w: number, h: number, l: number, r: number, t: number, b: number, hy: number, fy: number): Section['page'] {
  return { width: tw(w), height: tw(h), margins: { top: tw(t), right: tw(r), bottom: tw(b), left: tw(l), header: tw(hy), footer: tw(fy) } }
}
