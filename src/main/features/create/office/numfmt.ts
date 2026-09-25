/**
 * Spreadsheet number/date format engine (Excel format codes, also used for ODF formats that were mapped
 * to codes). Output is locale-free en-US: `.` decimal separator, `,` thousands, m/d/yyyy dates, English names.
 */

export interface FormatResult {
  text: string
  /** Colour requested by the format (`[Red]`), if any. */
  color?: string
  /** `*x` fill: repeat `ch` at character index `index` to fill the cell width. */
  fill?: { index: number; ch: string }
  /** The value was date/time formatted. */
  isDate?: boolean
}

export interface FormatOptions {
  date1904?: boolean
}

type Tok =
  | { t: 'lit'; s: string }
  | { t: 'dig'; c: '0' | '#' | '?' }
  | { t: 'dot' }
  | { t: 'comma' }
  | { t: 'pct' }
  | { t: 'exp'; sign: '+' | '-' }
  | { t: 'slash' }
  | { t: 'at' }
  | { t: 'fill'; c: string }
  | { t: 'date'; k: 'y' | 'm' | 'd' | 'h' | 's'; n: number }
  | { t: 'ampm'; short: boolean; lower: boolean }
  | { t: 'elapsed'; k: 'h' | 'm' | 's'; n: number }
  | { t: 'general' }

interface Section {
  tokens: Tok[]
  cond?: { op: string; val: number }
  color?: string
}

const COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00'
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Excel's built-in number formats by id (en-US). */
const BUILTIN: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_($* #,##0_);_($* \\(#,##0\\);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_($* #,##0.00_);_($* \\(#,##0.00\\);_($* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@'
}

export function builtinFormatCode(id: number): string | undefined {
  return BUILTIN[id]
}

// ---------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------

const cache = new Map<string, Section[]>()

function splitSections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let inBracket = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (inQuote) {
      cur += ch
      if (ch === '"') inQuote = false
    } else if (ch === '"') {
      inQuote = true
      cur += ch
    } else if (ch === '\\' && i + 1 < code.length) {
      cur += ch + code[++i]
    } else if (ch === '[') {
      inBracket = true
      cur += ch
    } else if (ch === ']') {
      inBracket = false
      cur += ch
    } else if (ch === ';' && !inBracket) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function tokenize(src: string, section: Section): void {
  const toks = section.tokens
  const lit = (s: string): void => {
    const last = toks[toks.length - 1]
    if (last && last.t === 'lit') last.s += s
    else toks.push({ t: 'lit', s })
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const rest = src.slice(i)
    if (ch === '"') {
      const e = src.indexOf('"', i + 1)
      lit(src.slice(i + 1, e < 0 ? src.length : e))
      i = e < 0 ? src.length : e + 1
      continue
    }
    if (ch === '\\') {
      if (i + 1 < src.length) lit(src[i + 1])
      i += 2
      continue
    }
    if (ch === '_') {
      lit(' ')
      i += 2
      continue
    }
    if (ch === '*') {
      if (i + 1 < src.length) toks.push({ t: 'fill', c: src[i + 1] })
      i += 2
      continue
    }
    if (ch === '[') {
      const e = src.indexOf(']', i)
      const inner = src.slice(i + 1, e < 0 ? src.length : e)
      i = e < 0 ? src.length : e + 1
      const low = inner.toLowerCase()
      const cm = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:e[+-]?\d+)?)$/i.exec(inner)
      if (cm) section.cond = { op: cm[1], val: parseFloat(cm[2]) }
      else if (COLORS[low]) section.color = COLORS[low]
      else if (/^color\s*\d+$/i.test(inner)) section.color = INDEXED[parseInt(inner.replace(/\D/g, ''), 10) + 7] ?? undefined
      else if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ t: 'elapsed', k: inner[0].toLowerCase() as 'h' | 'm' | 's', n: inner.length })
      else if (inner.startsWith('$')) {
        const cur = inner.slice(1).split('-')[0]
        const loc = /-([0-9a-f]+)$/i.exec(inner)?.[1]?.toUpperCase()
        if (cur) lit(cur)
        else if (i >= src.length && toks.length === 0 && loc === 'F800') tokenize('dddd, mmmm d, yyyy', section)
        else if (i >= src.length && toks.length === 0 && loc === 'F400') tokenize('h:mm:ss AM/PM', section)
      }
      continue
    }
    if (/^general/i.test(rest)) {
      toks.push({ t: 'general' })
      i += 7
      continue
    }
    if (/^(am\/pm|a\/p)/i.test(rest)) {
      const short = /^a\/p/i.test(rest)
      toks.push({ t: 'ampm', short, lower: rest[0] === 'a' })
      i += short ? 3 : 5
      continue
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      toks.push({ t: 'dig', c: ch })
      i++
      continue
    }
    if (ch === '.') {
      toks.push({ t: 'dot' })
      i++
      continue
    }
    if (ch === ',') {
      toks.push({ t: 'comma' })
      i++
      continue
    }
    if (ch === '%') {
      toks.push({ t: 'pct' })
      i++
      continue
    }
    if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      toks.push({ t: 'exp', sign: src[i + 1] as '+' | '-' })
      i += 2
      continue
    }
    if (ch === '/') {
      toks.push({ t: 'slash' })
      i++
      continue
    }
    if (ch === '@') {
      toks.push({ t: 'at' })
      i++
      continue
    }
    const lc = ch.toLowerCase()
    if ('ymdhs'.includes(lc) && /[a-z]/i.test(ch)) {
      let n = 1
      while (i + n < src.length && src[i + n].toLowerCase() === lc) n++
      toks.push({ t: 'date', k: lc as 'y' | 'm' | 'd' | 'h' | 's', n })
      i += n
      continue
    }
    lit(ch)
    i++
  }
}

const INDEXED: Record<number, string> = { 8: '#000000', 9: '#ffffff', 10: '#ff0000', 11: '#00ff00', 12: '#0000ff', 13: '#ffff00', 14: '#ff00ff', 15: '#00ffff' }

function parse(code: string): Section[] {
  let s = cache.get(code)
  if (s) return s
  s = splitSections(code).map((src) => {
    const sec: Section = { tokens: [] }
    tokenize(src, sec)
    return sec
  })
  if (cache.size > 2000) cache.clear()
  cache.set(code, s)
  return s
}

const isDateSection = (s: Section): boolean => s.tokens.some((t) => t.t === 'date' || t.t === 'ampm' || t.t === 'elapsed')

/** True if the format code formats dates/times. */
export function isDateFormat(code: string): boolean {
  const secs = parse(code)
  return secs.length > 0 && isDateSection(secs[0])
}

// ---------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------

/** Plain decimal string of |v| with 15 significant digits (never exponent notation). */
function plainDecimal(v: number): string {
  let s = Math.abs(v).toPrecision(15)
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s)
  if (m) {
    const digits = m[1] + (m[2] ?? '')
    const exp = parseInt(m[3], 10)
    if (exp >= 0) s = digits.length - 1 <= exp ? digits + '0'.repeat(exp - (digits.length - 1)) : digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1)
    else s = '0.' + '0'.repeat(-exp - 1) + digits
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** Rounds |v| half-up on its decimal representation. Returns [integerDigits, fractionDigits(length places)]. */
function roundTo(v: number, places: number): [string, string] {
  const s = plainDecimal(v)
  let [ip, fp = ''] = s.split('.')
  if (fp.length <= places) return [ip, fp.padEnd(places, '0')]
  const roundUp = fp.charCodeAt(places) >= 53
  fp = fp.slice(0, places)
  if (roundUp) {
    const digits = (ip + fp).split('')
    let i = digits.length - 1
    while (i >= 0) {
      if (digits[i] === '9') {
        digits[i] = '0'
        i--
      } else {
        digits[i] = String(parseInt(digits[i], 10) + 1)
        break
      }
    }
    let all = digits.join('')
    if (i < 0) all = '1' + all
    ip = all.slice(0, all.length - places)
    fp = all.slice(all.length - places)
  }
  return [ip.replace(/^0+(?=\d)/, ''), fp]
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function renderDigits(tokens: Tok[], v: number, showSign: boolean): FormatResult {
  let value = Math.abs(v)
  const pcts = tokens.filter((t) => t.t === 'pct').length
  for (let i = 0; i < pcts; i++) value *= 100

  const expIdx = tokens.findIndex((t) => t.t === 'exp')
  const dotIdx = tokens.findIndex((t) => t.t === 'dot')
  const digitIdx = tokens.map((t, i) => (t.t === 'dig' ? i : -1)).filter((i) => i >= 0)
  const endInt = dotIdx >= 0 ? dotIdx : expIdx >= 0 ? expIdx : tokens.length
  const intIdx = digitIdx.filter((i) => i < endInt)
  const fracIdx = digitIdx.filter((i) => dotIdx >= 0 && i > dotIdx && (expIdx < 0 || i < expIdx))
  const expDigits = digitIdx.filter((i) => expIdx >= 0 && i > expIdx).length

  // thousands separators: a comma between two integer placeholders groups; commas after the last one scale
  const lastInt = intIdx.length ? intIdx[intIdx.length - 1] : -1
  const lastDigit = digitIdx.length ? digitIdx[digitIdx.length - 1] : -1
  let grouping = false
  let scale = 0
  tokens.forEach((t, i) => {
    if (t.t !== 'comma') return
    if (intIdx.length && i > intIdx[0] && i < lastInt) grouping = true
    else if (lastDigit >= 0 && i > lastDigit && (expIdx < 0 || i < expIdx)) scale++
  })
  for (let i = 0; i < scale; i++) value /= 1000

  let exponent = 0
  let intStr: string
  let fracStr: string
  const F = fracIdx.length
  if (expIdx >= 0) {
    const I = Math.max(1, intIdx.length)
    if (value === 0) exponent = 0
    else {
      exponent = Math.floor(Math.log10(value))
      if (I > 1) exponent = Math.floor(exponent / I) * I
      else exponent = exponent - 0
    }
    let mant = value === 0 ? 0 : value / Math.pow(10, exponent)
    let [ip, fp] = roundTo(mant, F)
    if (ip.length > I && value !== 0) {
      exponent += I
      mant = value / Math.pow(10, exponent)
      ;[ip, fp] = roundTo(mant, F)
    }
    intStr = ip
    fracStr = fp
  } else {
    ;[intStr, fracStr] = roundTo(value, F)
  }
  if (intStr === '0') intStr = ''
  // Integer placeholders, filled right to left; overflow digits go to the leftmost placeholder.
  const intOut: string[] = []
  let ds = intStr
  if (grouping) {
    const zeros = intIdx.filter((i) => (tokens[i] as { c: string }).c === '0').length
    const padded = ds.padStart(zeros, '0')
    const g = group(padded)
    intIdx.forEach((_, k) => intOut.push(k === 0 ? g : ''))
  } else {
    for (let k = intIdx.length - 1; k >= 0; k--) {
      const c = (tokens[intIdx[k]] as { c: string }).c
      if (k === 0) {
        intOut[k] = ds.length ? ds : c === '0' ? '0' : c === '?' ? ' ' : ''
        ds = ''
      } else if (ds.length) {
        intOut[k] = ds[ds.length - 1]
        ds = ds.slice(0, -1)
      } else intOut[k] = c === '0' ? '0' : c === '?' ? ' ' : ''
    }
  }
  // Fraction placeholders
  let lastNonZero = -1
  for (let i = 0; i < fracStr.length; i++) if (fracStr[i] !== '0') lastNonZero = i
  const fracOut = fracIdx.map((_, k) => {
    const c = (tokens[fracIdx[k]] as { c: string }).c
    const d = fracStr[k] ?? '0'
    if (k <= lastNonZero || c === '0') return d
    return c === '?' ? ' ' : ''
  })

  let out = ''
  let fill: FormatResult['fill']
  let seenInt = 0
  let seenFrac = 0
  let wroteAny = false
  const noIntPlaceholders = intIdx.length === 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t.t) {
      case 'lit':
        out += t.s
        break
      case 'dig':
        if (intIdx.includes(i)) {
          out += intOut[seenInt++]
          wroteAny = true
        } else if (fracIdx.includes(i)) out += fracOut[seenFrac++]
        else if (expIdx >= 0 && i > expIdx) {
          /* handled at the exp token */
        }
        break
      case 'dot':
        if (noIntPlaceholders && intStr) out += intStr
        out += '.'
        break
      case 'pct':
        out += '%'
        break
      case 'exp': {
        const e = Math.abs(exponent).toString().padStart(Math.max(1, expDigits), '0')
        out += 'E' + (exponent < 0 ? '-' : t.sign === '+' ? '+' : '') + e
        i = tokens.length // exponent digits are consumed
        // any literals after exponent digits are ignored (rare)
        break
      }
      case 'fill':
        fill = { index: out.length, ch: t.c }
        break
      case 'general':
        out += generalText(v)
        break
      case 'at':
        out += formatToString(v)
        break
      default:
        break
    }
  }
  void wroteAny
  if (noIntPlaceholders && dotIdx < 0 && intStr) out = intStr + out
  if (showSign && v < 0 && Math.abs(v) > 0) out = '-' + out
  return { text: out, fill }
}

const formatToString = (v: number): string => generalText(v)

/** Excel's "General" number display (about 11 significant characters). */
export function generalText(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e11 || a < 1e-9) {
    const s = v.toExponential(5).replace(/\.?0+e/, 'E').replace('e', 'E')
    return s.replace(/E([+-])(\d)$/, 'E$10$2')
  }
  const s = plainDecimal(v)
  // limit to 11 significant characters like Excel
  const neg = v < 0 ? '-' : ''
  if (s.replace('.', '').replace(/^0+/, '').length <= 10) return neg + s
  const digitsBefore = s.split('.')[0].length
  const places = Math.max(0, 10 - (a >= 1 ? digitsBefore : 0))
  const [ip, fp] = roundTo(a, places)
  return neg + ip + (fp.replace(/0+$/, '') ? '.' + fp.replace(/0+$/, '') : '')
}

/**
 * "General" shows as many significant digits as fit in the column (up to 15), like Excel and LibreOffice. `fits`
 * reports whether a candidate string fits the cell. Returns null when not even an exponent form fits (=> `####`).
 */
export function generalFit(v: number, fits: (text: string) => boolean): string | null {
  if (!Number.isFinite(v)) return null
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a < 1e15 && a >= 1e-4) {
    for (let d = 15; d >= 1; d--) {
      const rounded = Number(a.toPrecision(d))
      if (!Number.isFinite(rounded) || rounded === 0) continue
      const s = String(rounded)
      if (/e/i.test(s)) continue
      const t = (v < 0 ? '-' : '') + s
      if (fits(t)) return t
    }
  }
  for (let k = a >= 1e15 || a < 1e-4 ? 5 : 4; k >= 0; k--) {
    const t = v.toExponential(k).replace(/\.?0+e/, 'e').replace('e', 'E').replace(/E([+-])(\d)$/, 'E$10$2')
    if (fits(t)) return t
  }
  return null
}

function bestFraction(x: number, maxDen: number): [number, number] {
  let best: [number, number] = [Math.round(x), 1]
  let bestErr = Math.abs(x - best[0])
  for (let d = 2; d <= maxDen && bestErr > 1e-12; d++) {
    const n = Math.round(x * d)
    const err = Math.abs(x - n / d)
    if (err < bestErr - 1e-12) {
      best = [n, d]
      bestErr = err
    }
  }
  return best
}

function renderFraction(tokens: Tok[], v: number, showSign: boolean): FormatResult {
  const slash = tokens.findIndex((t) => t.t === 'slash')
  const before = tokens.slice(0, slash)
  const after = tokens.slice(slash + 1)
  const spaceIdx = before.map((t, i) => (t.t === 'lit' && t.s.includes(' ') ? i : -1)).filter((i) => i >= 0)
  const spaceAt = spaceIdx.length ? spaceIdx[spaceIdx.length - 1] : -1
  const wholeToks = spaceAt >= 0 ? before.slice(0, spaceAt) : []
  const numToks = spaceAt >= 0 ? before.slice(spaceAt + 1) : before
  const hasWhole = wholeToks.some((t) => t.t === 'dig')
  const numW = numToks.filter((t) => t.t === 'dig').length
  const denDigits = after.filter((t) => t.t === 'dig')
  const fixedDen = after.find((t) => t.t === 'lit' && /^\d+$/.test(t.s)) as { s: string } | undefined
  const denW = denDigits.length
  const a = Math.abs(v)
  let whole = hasWhole ? Math.floor(a) : 0
  const frac = a - whole
  let [n, d] = fixedDen ? [Math.round(frac * parseInt(fixedDen.s, 10)), parseInt(fixedDen.s, 10)] : bestFraction(frac, Math.pow(10, Math.max(1, denW)) - 1)
  if (n === d && d > 0) {
    if (hasWhole) whole += 1
    n = 0
  }
  let out = ''
  if (hasWhole) {
    const wholeStr = whole === 0 && wholeToks.some((t) => t.t === 'dig' && t.c !== '0') ? '' : String(whole)
    out += wholeStr
    out += ' '
  }
  if (n === 0 && hasWhole) out += ' '.repeat(numW + 1 + (fixedDen ? fixedDen.s.length : denW))
  else {
    const ns = String(hasWhole ? n : Math.round(a * d)).padStart(numW, ' ')
    const ds = String(d).padEnd(fixedDen ? fixedDen.s.length : denW, ' ')
    out += ns + '/' + ds
  }
  for (const t of [...wholeToks.filter((t) => t.t === 'lit'), ...after.filter((t) => t.t === 'lit' && !/^\d+$/.test((t as { s: string }).s))]) out += (t as { s: string }).s
  return { text: (showSign && v < 0 ? '-' : '') + out }
}

// ---------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------

export function serialToParts(serial: number, date1904: boolean): { y: number; mo: number; d: number; wd: number; ms: number; days: number } {
  let days = Math.floor(serial)
  let ms = Math.round((serial - days) * 86400000)
  if (ms >= 86400000) {
    days += 1
    ms -= 86400000
  }
  let y: number, mo: number, d: number, wd: number
  if (!date1904 && days === 60) {
    y = 1900
    mo = 2
    d = 29
    wd = 3
  } else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
    const dt = new Date(base + days * 86400000)
    y = dt.getUTCFullYear()
    mo = dt.getUTCMonth() + 1
    d = dt.getUTCDate()
    wd = dt.getUTCDay()
  }
  return { y, mo, d, wd, ms, days }
}

const two = (n: number): string => String(n).padStart(2, '0')

function renderDate(tokens: Tok[], serial: number, opts: FormatOptions): FormatResult {
  if (serial < 0) return { text: '#'.repeat(10), isDate: true }
  const hasFrac = tokens.some((t, i) => t.t === 'dot' && tokens[i - 1]?.t === 'date' && (tokens[i - 1] as { k: string }).k === 's' && tokens[i + 1]?.t === 'dig')
  let ms = Math.round((serial - Math.floor(serial)) * 86400000)
  let s2 = serial
  if (!hasFrac) {
    // round to whole seconds like Excel
    const rounded = Math.round((serial * 86400000) / 1000) * 1000
    s2 = rounded / 86400000
    ms = Math.round((s2 - Math.floor(s2)) * 86400000)
  }
  const p = serialToParts(s2, !!opts.date1904)
  ms = p.ms
  const ampm = tokens.some((t) => t.t === 'ampm')
  const hh = Math.floor(ms / 3600000)
  const mm = Math.floor((ms % 3600000) / 60000)
  const ss = Math.floor((ms % 60000) / 1000)
  const frac = ms % 1000
  const dateToks = tokens.map((t, i) => ({ t, i })).filter((x) => x.t.t === 'date' || x.t.t === 'elapsed')
  let out = ''
  let fill: FormatResult['fill']
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t.t) {
      case 'lit':
        out += t.s
        break
      case 'fill':
        fill = { index: out.length, ch: t.c }
        break
      case 'general':
        out += generalText(serial)
        break
      case 'slash':
        out += '/'
        break
      case 'comma':
        out += ','
        break
      case 'pct':
        out += '%'
        break
      case 'ampm':
        out += t.short ? (hh < 12 ? 'A' : 'P') : hh < 12 ? 'AM' : 'PM'
        if (t.lower) out = out.slice(0, out.length - (t.short ? 1 : 2)) + (t.short ? (hh < 12 ? 'a' : 'p') : hh < 12 ? 'am' : 'pm')
        break
      case 'elapsed': {
        const total = Math.round(s2 * 86400000)
        const v = t.k === 'h' ? Math.floor(total / 3600000) : t.k === 'm' ? Math.floor(total / 60000) : Math.floor(total / 1000)
        out += String(v).padStart(t.n, '0')
        break
      }
      case 'dot':
        if (hasFrac && tokens[i - 1]?.t === 'date' && (tokens[i - 1] as { k: string }).k === 's') {
          let n = 0
          while (tokens[i + 1 + n]?.t === 'dig') n++
          out += '.' + String(frac).padStart(3, '0').slice(0, n).padEnd(n, '0')
          i += n
        } else out += '.'
        break
      case 'date': {
        switch (t.k) {
          case 'y':
            out += t.n <= 2 ? two(p.y % 100) : String(p.y).padStart(4, '0')
            break
          case 'd':
            out += t.n === 1 ? String(p.d) : t.n === 2 ? two(p.d) : t.n === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd]
            break
          case 'h': {
            const h = ampm ? hh % 12 || 12 : hh
            out += t.n === 1 ? String(h) : two(h)
            break
          }
          case 's':
            out += t.n === 1 ? String(ss) : two(ss)
            break
          case 'm': {
            // minutes when adjacent to hours (before) or seconds (after), otherwise month
            const idx = dateToks.findIndex((x) => x.i === i)
            const prev = dateToks[idx - 1]?.t
            const next = dateToks[idx + 1]?.t
            const isMin = (prev && ((prev.t === 'date' && prev.k === 'h') || (prev.t === 'elapsed' && prev.k === 'h'))) || (next && next.t === 'date' && next.k === 's')
            if (isMin && t.n <= 2) out += t.n === 1 ? String(mm) : two(mm)
            else out += t.n === 1 ? String(p.mo) : t.n === 2 ? two(p.mo) : t.n === 3 ? MONTHS[p.mo - 1].slice(0, 3) : t.n === 4 ? MONTHS[p.mo - 1] : MONTHS[p.mo - 1][0]
            break
          }
        }
        break
      }
      default:
        break
    }
  }
  return { text: out, fill, isDate: true }
}

// ---------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------

function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    case '=':
      return a === b
    case '<>':
      return a !== b
    default:
      return false
  }
}

/** Formats a number with an Excel format code. */
export function formatNumber(value: number, code: string | undefined, opts: FormatOptions = {}): FormatResult {
  if (!Number.isFinite(value)) return { text: Number.isNaN(value) ? '#NUM!' : '#DIV/0!' }
  if (!code || /^general$/i.test(code.trim())) return { text: generalText(value) }
  const secs = parse(code).filter((s, i, arr) => !(i === arr.length - 1 && arr.length > 1 && s.tokens.length === 0 && false))
  let idx = 0
  let showSign = value < 0
  const n = secs.length
  const hasCond = secs.some((s) => s.cond)
  if (hasCond) {
    idx = -1
    for (let i = 0; i < Math.min(2, n); i++) {
      const c = secs[i].cond
      if (c ? cmp(c.op, value, c.val) : i === 0 ? value >= 0 && n > 1 : false) {
        idx = i
        break
      }
    }
    if (idx < 0) idx = n >= 3 ? 2 : n - 1
    showSign = value < 0 && idx !== 1
  } else if (n === 1) idx = 0
  else if (n === 2) {
    idx = value < 0 ? 1 : 0
    showSign = false
  } else {
    idx = value > 0 ? 0 : value < 0 ? 1 : 2
    showSign = false
  }
  const sec = secs[Math.min(idx, n - 1)]
  const tokens = sec.tokens
  let res: FormatResult
  if (tokens.length === 0) res = { text: '' }
  else if (isDateSection(sec)) res = renderDate(tokens, value, opts)
  else if (tokens.length === 1 && tokens[0].t === 'general') res = { text: (showSign ? '' : value < 0 ? '-' : '') + generalText(Math.abs(value) * (value < 0 && !showSign ? 1 : 1)) }
  else if (tokens.some((t) => t.t === 'slash') && tokens.some((t) => t.t === 'dig')) res = renderFraction(tokens, value, showSign)
  else if (!tokens.some((t) => t.t === 'dig' || t.t === 'general' || t.t === 'at')) {
    // only literals ("Zero" or "-"): print the literal text
    res = { text: tokens.map((t) => (t.t === 'lit' ? t.s : t.t === 'pct' ? '%' : '')).join(''), fill: undefined }
    const f = tokens.findIndex((t) => t.t === 'fill')
    if (f >= 0) res.fill = { index: tokens.slice(0, f).map((t) => (t.t === 'lit' ? t.s : '')).join('').length, ch: (tokens[f] as { c: string }).c }
  } else res = renderDigits(tokens, value, showSign)
  if (sec.color) res.color = sec.color
  return res
}

/** Applies a format code's text section (`@`) to a string value. */
export function formatText(text: string, code: string | undefined): FormatResult {
  if (!code) return { text }
  const secs = parse(code)
  const sec = secs.length >= 4 ? secs[3] : secs.find((s) => s.tokens.some((t) => t.t === 'at'))
  if (!sec || !sec.tokens.some((t) => t.t === 'at')) return { text }
  let out = ''
  let fill: FormatResult['fill']
  for (const t of sec.tokens) {
    if (t.t === 'lit') out += t.s
    else if (t.t === 'at') out += text
    else if (t.t === 'fill') fill = { index: out.length, ch: t.c }
  }
  return { text: out, color: sec.color, fill }
}
