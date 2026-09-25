/**
 * Built-in search patterns for "find and mark": e-mail addresses, phone numbers, payment cards (Luhn), national ID
 * numbers, IBANs (mod-97), dates, URLs and IP addresses. Each preset is a fixed, reviewed regular expression
 * (bounded quantifiers only, so it cannot backtrack catastrophically) plus a validator that removes look-alikes.
 */

export interface Preset {
  id: string
  label: string
  description: string
  /** Text that must match / must not match (used by the tests and shown as hints). */
  examples: string[]
  build(): RegExp
  validate?(match: string): boolean
}

const digits = (s: string): string => s.replace(/\D/g, '')

/** Luhn checksum of a digit string. */
export function luhn(d: string): boolean {
  if (!/^\d+$/.test(d) || d.length < 2) return false
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
  NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, TL: 23, TN: 24, TR: 26, UA: 29,
  VA: 22, VG: 24, XK: 20
}

/** IBAN validity: country length and the ISO 13616 mod-97 check. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false
  const want = IBAN_LENGTHS[s.slice(0, 2)]
  if (want !== undefined ? s.length !== want : s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return rem === 1
}

const daysIn = (y: number, m: number): number => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)
const validYmd = (y: number, m: number, d: number): boolean => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m) && y >= 1000 && y <= 2999

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function dateValid(s: string): boolean {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) return validYmd(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s)
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    const a = +m[1]
    const b = +m[2]
    return validYmd(y, b, a) || validYmd(y, a, b) || (m[3].length === 2 && (validYmd(1900 + +m[3], b, a) || validYmd(1900 + +m[3], a, b)))
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s)
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    return mi >= 0 && validYmd(+m[3], mi + 1, +m[2])
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s)
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    return mi >= 0 && validYmd(+m[3], mi + 1, +m[1])
  }
  return false
}

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'

function nationalIdValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  // United Kingdom National Insurance number
  if (/^[A-Z]{2}\d{6}[A-D]$/.test(s)) return !['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ'].includes(s.slice(0, 2)) && !/[DFIQUV]/.test(s.slice(0, 2))
  // Spanish DNI / NIE
  if (/^[XYZ]?\d{7,8}[A-Z]$/.test(s)) {
    const body = s.slice(0, -1).replace('X', '0').replace('Y', '1').replace('Z', '2')
    return /^\d+$/.test(body) && DNI_LETTERS[Number(body) % 23] === s[s.length - 1]
  }
  // French INSEE number (13 digits + 2-digit key)
  if (/^[12]\d{2}(0[1-9]|1[0-2])(\d{2}|2[AB])\d{6}\d{2}$/.test(s)) {
    const dept = s.slice(5, 7)
    const base = s.slice(0, 5) + (dept === '2A' ? '19' : dept === '2B' ? '18' : dept) + s.slice(7, 13)
    return 97 - Number(BigInt(base) % 97n) === Number(s.slice(13))
  }
  // Canadian SIN (9 digits, Luhn)
  if (/^\d{9}$/.test(s)) return luhn(s) && s[0] !== '0' && s[0] !== '8'
  return false
}

const MONTH_NAME = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'

export const PRESETS: Preset[] = [
  {
    id: 'email',
    label: 'E-mail addresses',
    description: 'name@example.com',
    examples: ['jane.doe+tag@example.co.uk', 'a_b@sub.domain.org'],
    build: () => /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g
  },
  {
    id: 'phone',
    label: 'Phone numbers (US and international)',
    description: '(555) 123-4567, +1 555-123-4567, +44 20 7946 0958',
    examples: ['(555) 123-4567', '+1 555-123-4567', '555.123.4567', '+44 20 7946 0958', '+49 30 901820'],
    build: () =>
      /(?<![\w+])(?:(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}|\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5})(?![\w-])/g,
    validate: (m) => {
      const d = digits(m)
      return d.length >= 7 && d.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(m)
    }
  },
  {
    id: 'card',
    label: 'Payment card numbers (Luhn checked)',
    description: '4111 1111 1111 1111',
    examples: ['4111 1111 1111 1111', '5500-0000-0000-0004', '378282246310005'],
    build: () => /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    validate: (m) => {
      const d = digits(m)
      return d.length >= 13 && d.length <= 19 && luhn(d)
    }
  },
  {
    id: 'ssn',
    label: 'Social Security numbers (US)',
    description: '123-45-6789',
    examples: ['123-45-6789', '078 05 1120'],
    build: () => /(?<!\d)(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}(?!\d)/g
  },
  {
    id: 'national-id',
    label: 'National ID numbers (UK NINO, Canada SIN, Spain DNI/NIE, France INSEE)',
    description: 'QQ 12 34 56 C, 046 454 286, 12345678Z',
    examples: ['QQ 12 34 56 C', '046 454 286', '12345678Z', '1 84 12 76 451 089 46'],
    build: () =>
      /(?<![A-Za-z0-9])(?:[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]|\d{3}[ -]\d{3}[ -]\d{3}|[XYZ]?\d{7,8}-?[A-Z]|[12] ?\d{2} ?(?:0[1-9]|1[0-2]) ?(?:\d{2}|2[AB]) ?\d{3} ?\d{3} ?\d{2})(?![A-Za-z0-9])/g,
    validate: nationalIdValid
  },
  {
    id: 'iban',
    label: 'IBANs (checksum verified)',
    description: 'DE89 3704 0044 0532 0130 00',
    examples: ['DE89 3704 0044 0532 0130 00', 'GB82WEST12345698765432'],
    build: () => /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g,
    validate: ibanValid
  },
  {
    id: 'date',
    label: 'Dates',
    description: '2024-03-15, 15/03/2024, March 15, 2024, 15 March 2024',
    examples: ['2024-03-15', '15/03/2024', '03.15.24', 'March 15, 2024', '15th March 2024'],
    build: () =>
      new RegExp(
        `(?<![\\w/.-])(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|${MONTH_NAME}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH_NAME}\\.?,? \\d{4})(?![\\w/-])`,
        'g'
      ),
    validate: dateValid
  },
  {
    id: 'url',
    label: 'URLs',
    description: 'https://example.com/path, www.example.com',
    examples: ['https://example.com/a/b?c=d', 'www.example.org'],
    build: () => /(?<![\w@])(?:https?:\/\/|www\.)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g
  },
  {
    id: 'ip',
    label: 'IP addresses (IPv4 and IPv6)',
    description: '192.168.0.1, 2001:db8::1',
    examples: ['192.168.0.1', '10.0.0.255', '2001:db8::ff00:42:8329', '2001:0db8:0000:0000:0000:ff00:0042:8329'],
    build: () =>
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)|(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}(?![\w:])|(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){1,6}(?::[A-Fa-f0-9]{1,4}){1,6}(?![\w:])|(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){1,7}:(?![\w:])/g,
    validate: (m) => {
      if (m.includes(':')) {
        const parts = m.split('::')
        if (parts.length > 2) return false
        const groups = m.split(':').filter((x) => x !== '').length
        return parts.length === 2 ? groups <= 7 : groups === 8
      }
      return true
    }
  }
]

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id)

export interface TextRange {
  start: number
  end: number
}

/** All valid matches of a preset in `text`. */
export function findPreset(text: string, preset: Preset): TextRange[] {
  const re = preset.build()
  const out: TextRange[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (!preset.validate || preset.validate(m[0])) out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}
