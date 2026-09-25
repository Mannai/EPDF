import type { FormatSpec, SpecialFormat } from './spec'

/**
 * Validation and formatting rules for form fields, stored the way other PDF readers expect them: as `/AA`
 * JavaScript actions (`/F` format, `/K` keystroke, `/V` validate) calling Acrobat's own helper functions
 * (`AFNumber_Format`, `AFDate_FormatEx`, `AFSpecial_Format`, ...) or a small regular-expression script.
 *
 * Epdf NEVER executes PDF JavaScript. It only WRITES these scripts for other readers, and for its own fill
 * experience it recognises the same rules by matching the exact script shapes below (`parseScripts`) and
 * checking the value itself (`checkValue`). Pure TypeScript.
 */

export interface ActionScripts {
  /** `/AA /F`: how the value is shown. */
  format?: string
  /** `/AA /K`: which keystrokes are accepted. */
  keystroke?: string
  /** `/AA /V`: whether the finished value is acceptable. */
  validate?: string
}

const str = (s: string): string => JSON.stringify(s)
const SEPARATORS: Record<number, [string, string]> = { 0: [',', '.'], 1: ['', '.'], 2: ['.', ','], 3: ['', ','] }

const SPECIAL_INDEX: Record<SpecialFormat, number> = { zip: 0, zip4: 1, phone: 2, ssn: 3 }
const SPECIAL_BY_INDEX: SpecialFormat[] = ['zip', 'zip4', 'phone', 'ssn']

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const EMAIL_MESSAGE = 'Please enter a valid email address.'

/** Patterns with nested quantifiers can take exponential time; refuse them (and very long ones). */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 200) return false
  if (/(\([^)]*[+*][^)]*\))\s*[+*{]/.test(pattern)) return false
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** The Acrobat-compatible scripts that implement a rule. */
export function scriptsFor(f: FormatSpec): ActionScripts {
  switch (f.type) {
    case 'none':
      return {}
    case 'number': {
      const args = `${f.decimals}, ${f.sep}, ${f.neg}, 0, ${str(f.currency)}, ${f.prepend}`
      const range = f.min !== undefined || f.max !== undefined
      return {
        format: `AFNumber_Format(${args});`,
        keystroke: `AFNumber_Keystroke(${args});`,
        validate: range ? `AFRange_Validate(${f.min !== undefined}, ${f.min ?? 0}, ${f.max !== undefined}, ${f.max ?? 0});` : undefined
      }
    }
    case 'percent':
      return { format: `AFPercent_Format(${f.decimals}, ${f.sep});`, keystroke: `AFPercent_Keystroke(${f.decimals}, ${f.sep});` }
    case 'date':
      return { format: `AFDate_FormatEx(${str(f.format)});`, keystroke: `AFDate_KeystrokeEx(${str(f.format)});` }
    case 'time':
      return { format: `AFTime_Format(${f.format});`, keystroke: `AFTime_Keystroke(${f.format});` }
    case 'special':
      return { format: `AFSpecial_Format(${SPECIAL_INDEX[f.special]});`, keystroke: `AFSpecial_Keystroke(${SPECIAL_INDEX[f.special]});` }
    case 'email':
      return {
        validate: `/* epdf:email */ if (event.value != "" && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(event.value)) { app.alert(${str(EMAIL_MESSAGE)}); event.rc = false; }`
      }
    case 'regex':
      return {
        validate: `/* epdf:regex */ var re = new RegExp(${str(f.pattern)}); if (event.value != "" && !re.test(event.value)) { app.alert(${str(f.message)}); event.rc = false; }`
      }
  }
}

const unstr = (lit: string): string => {
  try {
    return JSON.parse(`"${lit}"`) as string
  } catch {
    return lit
  }
}

const S = '"((?:[^"\\\\]|\\\\.)*)"'

/** Recognises the rule behind a field's scripts (ours and Acrobat's standard helper calls). */
export function parseScripts(s: ActionScripts): FormatSpec {
  const fmt = s.format ?? ''
  const val = s.validate ?? ''
  let m = new RegExp(`AFNumber_Format\\(\\s*(\\d+)\\s*,\\s*(\\d)\\s*,\\s*(\\d)\\s*,\\s*\\d+\\s*,\\s*${S}\\s*,\\s*(true|false)\\s*\\)`).exec(fmt)
  if (m) {
    const r = /AFRange_Validate\(\s*(true|false)\s*,\s*(-?[\d.]+)\s*,\s*(true|false)\s*,\s*(-?[\d.]+)\s*\)/.exec(val)
    return {
      type: 'number',
      decimals: Number(m[1]),
      sep: Math.min(3, Number(m[2])) as 0 | 1 | 2 | 3,
      neg: Math.min(3, Number(m[3])) as 0 | 1 | 2 | 3,
      currency: unstr(m[4]),
      prepend: m[5] === 'true',
      min: r && r[1] === 'true' ? Number(r[2]) : undefined,
      max: r && r[3] === 'true' ? Number(r[4]) : undefined
    }
  }
  m = /AFPercent_Format\(\s*(\d+)\s*,\s*(\d)\s*\)/.exec(fmt)
  if (m) return { type: 'percent', decimals: Number(m[1]), sep: Math.min(3, Number(m[2])) as 0 | 1 | 2 | 3 }
  m = new RegExp(`AFDate_FormatEx\\(\\s*${S}\\s*\\)`).exec(fmt)
  if (m) return { type: 'date', format: unstr(m[1]) }
  m = /AFTime_Format\(\s*(\d)\s*\)/.exec(fmt)
  if (m) return { type: 'time', format: Math.min(3, Number(m[1])) as 0 | 1 | 2 | 3 }
  m = /AFSpecial_Format\(\s*(\d)\s*\)/.exec(fmt)
  if (m && SPECIAL_BY_INDEX[Number(m[1])]) return { type: 'special', special: SPECIAL_BY_INDEX[Number(m[1])] }
  if (/epdf:email/.test(val)) return { type: 'email' }
  m = new RegExp(`/\\* epdf:regex \\*/\\s*var re = new RegExp\\(${S}\\);.*?app\\.alert\\(${S}\\)`).exec(val)
  if (m) return { type: 'regex', pattern: unstr(m[1]), message: unstr(m[2]) }
  return { type: 'none' }
}

// ---------------------------------------------------------------------------------------------------------
// checking a value (Epdf's own fill experience)

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function datePattern(format: string): { re: RegExp; order: ('d' | 'm' | 'y' | 'mon' | 'monfull')[] } {
  const order: ('d' | 'm' | 'y' | 'mon' | 'monfull')[] = []
  let src = '^'
  const f = format
  for (let i = 0; i < f.length; ) {
    const rest = f.slice(i).toLowerCase()
    if (rest.startsWith('yyyy')) (src += '(\\d{4})'), order.push('y'), (i += 4)
    else if (rest.startsWith('yy')) (src += '(\\d{2})'), order.push('y'), (i += 2)
    else if (rest.startsWith('mmmm')) (src += `(${MONTHS.join('|')})`), order.push('monfull'), (i += 4)
    else if (rest.startsWith('mmm')) (src += `(${MONTHS.map((x) => x.slice(0, 3)).join('|')})`), order.push('mon'), (i += 3)
    else if (rest.startsWith('mm') || rest.startsWith('m')) (src += '(\\d{1,2})'), order.push('m'), (i += rest.startsWith('mm') ? 2 : 1)
    else if (rest.startsWith('dd') || rest.startsWith('d')) (src += '(\\d{1,2})'), order.push('d'), (i += rest.startsWith('dd') ? 2 : 1)
    else {
      src += f[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i++
    }
  }
  return { re: new RegExp(`${src}$`, 'i'), order }
}

/** True when `value` is a real calendar date written in `format` (`dd/mm/yyyy`, `d mmmm yyyy`, ...). */
export function isDateInFormat(value: string, format: string): boolean {
  const { re, order } = datePattern(format)
  const m = re.exec(value.trim())
  if (!m) return false
  let d = 1
  let mo = 1
  let y = 2000
  order.forEach((k, i) => {
    const v = m[i + 1]
    if (k === 'd') d = Number(v)
    else if (k === 'm') mo = Number(v)
    else if (k === 'y') y = v.length === 2 ? 2000 + Number(v) : Number(v)
    else if (k === 'monfull') mo = MONTHS.indexOf(v.toLowerCase()) + 1
    else mo = MONTHS.findIndex((x) => x.startsWith(v.toLowerCase())) + 1
  })
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(y, mo, 0).getDate()
}

function parseNumber(value: string, sep: number, currency: string): number | null {
  const [thousands, decimal] = SEPARATORS[sep] ?? SEPARATORS[0]
  let v = value.trim()
  if (currency) v = v.split(currency).join('')
  v = v.replace(/\s+/g, '')
  let negative = false
  const paren = /^\((.*)\)$/.exec(v)
  if (paren) {
    negative = true
    v = paren[1]
  }
  if (v.startsWith('-')) {
    negative = !negative
    v = v.slice(1)
  }
  const t = thousands ? thousands.replace(/[.]/g, '\\.') : ''
  const d = decimal.replace(/[.]/g, '\\.')
  // Digits, optionally grouped in threes with the style's thousands separator, and one decimal separator.
  const shape = new RegExp(`^(?:\\d{1,3}(?:${t}\\d{3})+|\\d+)(?:${d}\\d*)?$|^${d}\\d+$`)
  if (!shape.test(v)) return null
  if (thousands) v = v.split(thousands).join('')
  if (decimal !== '.') v = v.replace(decimal, '.')
  const n = Number(v)
  return Number.isFinite(n) ? (negative ? -n : n) : null
}

const SPECIAL_RE: Record<SpecialFormat, RegExp> = {
  zip: /^\d{5}$/,
  zip4: /^\d{5}[- ]?\d{4}$/,
  phone: /^(\(\d{3}\)\s?|\d{3}[-. ]?)?\d{3}[-. ]?\d{4}$/,
  ssn: /^\d{3}[- ]?\d{2}[- ]?\d{4}$/
}
const SPECIAL_HINT: Record<SpecialFormat, string> = {
  zip: 'a 5-digit ZIP code',
  zip4: 'a ZIP+4 code (12345-6789)',
  phone: 'a phone number such as (555) 123-4567',
  ssn: 'a social security number (123-45-6789)'
}

/**
 * Checks a finished value against a rule; returns a sentence for the user, or null when it is fine.
 * Empty values are always accepted (use the field's Required flag for "must be filled").
 */
export function checkValue(f: FormatSpec, value: string, label: string): string | null {
  if (value.trim() === '' || f.type === 'none') return null
  switch (f.type) {
    case 'number': {
      const n = parseNumber(value, f.sep, f.currency)
      if (n === null) return `“${label}” must be a number.`
      if (f.min !== undefined && n < f.min) return `“${label}” must be at least ${f.min}.`
      if (f.max !== undefined && n > f.max) return `“${label}” must be at most ${f.max}.`
      return null
    }
    case 'percent':
      return parseNumber(value.replace(/%\s*$/, ''), f.sep, '') === null ? `“${label}” must be a percentage.` : null
    case 'date':
      return isDateInFormat(value, f.format) ? null : `“${label}” must be a valid date written as ${f.format}.`
    case 'time':
      return /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?$/i.test(value.trim()) ? null : `“${label}” must be a time such as 14:30.`
    case 'special':
      return SPECIAL_RE[f.special].test(value.trim()) ? null : `“${label}” must be ${SPECIAL_HINT[f.special]}.`
    case 'email':
      return EMAIL_RE.test(value.trim()) ? null : `“${label}” must be a valid email address.`
    case 'regex': {
      if (!isSafeRegex(f.pattern) || value.length > 1000) return null
      try {
        return new RegExp(f.pattern).test(value) ? null : f.message || `“${label}” is not in the expected format.`
      } catch {
        return null
      }
    }
  }
}

/** Short description for lists and the CSV export. */
export function describeFormat(f: FormatSpec): string {
  switch (f.type) {
    case 'none':
      return ''
    case 'number':
      return `Number, ${f.decimals} decimals${f.min !== undefined || f.max !== undefined ? `, ${f.min ?? '…'} to ${f.max ?? '…'}` : ''}`
    case 'percent':
      return `Percentage, ${f.decimals} decimals`
    case 'date':
      return `Date ${f.format}`
    case 'time':
      return 'Time'
    case 'special':
      return { zip: 'ZIP code', zip4: 'ZIP+4 code', phone: 'Phone number', ssn: 'Social security number' }[f.special]
    case 'email':
      return 'Email address'
    case 'regex':
      return `Pattern ${f.pattern}`
  }
}
