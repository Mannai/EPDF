/** Small pure helpers: colours, opacity, dates, author names, unique names. No PDF or DOM dependencies. */

export type Color = number[] // 1 (gray), 3 (RGB) or 4 (CMYK) components in 0..1

export const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)
export const clamp01 = (v: number): number => clamp(v, 0, 1)

/** Opacity is kept in 0.05..1 so a stray 0 can never create an invisible annotation. */
export const clampOpacity = (v: number, fallback = 1): number => (Number.isFinite(v) ? clamp(v, 0.05, 1) : fallback)

/** A usable colour: 1, 3 or 4 finite components clamped to 0..1; anything else falls back. */
export function sanitizeColor(c: readonly number[] | null | undefined, fallback: Color = [0, 0, 0]): Color {
  if (!c || ![1, 3, 4].includes(c.length)) return [...fallback]
  return c.map((v) => clamp01(v))
}

export function hexToRgb(hex: string, fallback: Color = [0, 0, 0]): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [...fallback]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Any colour space → RGB (for showing the colour of a foreign annotation in the UI). */
export function toRgb(c: readonly number[] | null | undefined): [number, number, number] | null {
  if (!c) return null
  if (c.length === 1) return [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])]
  if (c.length === 3) return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]
  if (c.length === 4) {
    const k = 1 - clamp01(c[3])
    return [(1 - clamp01(c[0])) * k, (1 - clamp01(c[1])) * k, (1 - clamp01(c[2])) * k]
  }
  return null
}

export function rgbToHex(c: readonly number[] | null | undefined, fallback = '#000000'): string {
  const rgb = toRgb(c)
  if (!rgb) return fallback
  return '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- dates

const p2 = (n: number): string => String(n).padStart(2, '0')

/** PDF date string `D:YYYYMMDDHHmmSS+HH'mm'` in the given UTC offset (default: the machine's). */
export function formatPdfDate(d: Date, offsetMinutes: number = -d.getTimezoneOffset()): string {
  const local = new Date(d.getTime() + offsetMinutes * 60000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return (
    `D:${local.getUTCFullYear()}${p2(local.getUTCMonth() + 1)}${p2(local.getUTCDate())}` +
    `${p2(local.getUTCHours())}${p2(local.getUTCMinutes())}${p2(local.getUTCSeconds())}` +
    `${sign}${p2(Math.floor(abs / 60))}'${p2(abs % 60)}'`
  )
}

/** Parses a PDF date (`D:YYYY[MM[DD[HH[mm[SS]]]]][Z|+HH'mm'|-HH'mm']`). Returns epoch ms, or null. */
export function parsePdfDate(s: string | undefined | null): number | null {
  if (!s) return null
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}(?:'?\d{2}'?)?)?/.exec(s.trim())
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz] = m
  let offset = 0
  if (tz && tz !== 'Z') {
    const t = /^([+-])(\d{2})(?:'?(\d{2}))?/.exec(tz)
    if (t) offset = (t[1] === '-' ? -1 : 1) * (parseInt(t[2], 10) * 60 + parseInt(t[3] ?? '0', 10))
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offset * 60000
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------- author

export const AUTHOR_FALLBACK = 'Author'
export const AUTHOR_MAX = 80

/** The author written into new annotations: the user's stored choice, else the OS user name, else "Author". */
export function resolveAuthor(stored: string | null | undefined, systemDefault: string | null | undefined): string {
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, AUTHOR_MAX)
  return clean(stored) || clean(systemDefault) || AUTHOR_FALLBACK
}

// ---------------------------------------------------------------- ids

/** `epdf-` + 16 random bytes as hex: the /NM (unique annotation name) of everything Epdf creates. */
export function newAnnotName(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return 'epdf-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const isOurName = (nm: string | undefined): boolean => !!nm && nm.startsWith('epdf-')
