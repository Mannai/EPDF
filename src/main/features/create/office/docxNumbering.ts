import { parsePPr, parseRPr, type PPr, type RPr, type Theme } from './docxStyles'
import type { Pkg } from './package'
import { attr, child, childrenNamed, numAttr, path, type XNode } from './xml'

/** Word list numbering (numbering.xml): counters per list, level formats, and bullet glyph clean-up. */

export interface LvlDef {
  start: number
  fmt: string
  text: string
  ppr: PPr
  rpr: RPr
  suff: 'tab' | 'space' | 'nothing'
  isLgl: boolean
  /** `lvlRestart` value: 0 = never restart, otherwise restart after the given (1-based) level. */
  restart?: number
  font?: string
}

interface AbstractNum {
  id: string
  levels: Map<number, LvlDef>
}

interface NumInstance {
  numId: number
  abstractId: string
  overrides: Map<number, { start?: number; lvl?: LvlDef }>
}

export interface Marker {
  text: string
  /** Character properties of the label (merge over the paragraph mark's). */
  rpr: RPr
  ppr: PPr
  suff: LvlDef['suff']
  isBullet: boolean
  fontHint?: string
}

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]

export function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n)
  let out = ''
  for (const [v, s] of ROMAN) while (n >= v) {
    out += s
    n -= v
  }
  return out
}

export function toLetters(n: number): string {
  if (n <= 0) return String(n)
  let out = ''
  while (n > 0) {
    n--
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

export function formatNumber(fmt: string, n: number): string {
  switch (fmt) {
    case 'decimal':
      return String(n)
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n)
    case 'upperRoman':
      return toRoman(n).toUpperCase()
    case 'lowerRoman':
      return toRoman(n)
    case 'upperLetter':
      return toLetters(n).toUpperCase()
    case 'lowerLetter':
      return toLetters(n)
    case 'ordinal':
      return ordinal(n)
    case 'none':
      return ''
    default:
      return String(n)
  }
}

/** Candidate replacements for private-use Symbol/Wingdings bullet code points, best first. */
export function bulletCandidates(text: string, font: string | undefined): string[] {
  const f = (font ?? '').toLowerCase()
  const cp = text.codePointAt(0) ?? 0x2022
  const low = cp & 0xff
  if (cp >= 0xf000 && cp <= 0xf0ff) {
    if (f.includes('symbol')) {
      if (low === 0xb7) return ['•']
      if (low === 0xa7) return ['▪', '■', '•']
      if (low === 0xd8) return ['➢', '>', '•']
      return ['•']
    }
    if (f.includes('wingdings')) {
      switch (low) {
        case 0xa7:
        case 0xa8:
          return ['▪', '■', '•']
        case 0x6c:
          return ['●', '•']
        case 0x6e:
          return ['■', '▪', '•']
        case 0x71:
        case 0x6f:
          return ['□', '▫', '•']
        case 0xd8:
          return ['➢', '>', '•']
        case 0xfc:
          return ['✓', '√', '•']
        case 0x76:
          return ['❖', '◆', '•']
        case 0xb7:
          return ['•']
        default:
          return ['•']
      }
    }
    return ['•']
  }
  if (text === 'o' && (f.includes('courier') || f.includes('mono'))) return ['◦', '○', 'o']
  if (text === '·' || text === '·') return ['•', '·']
  return [text || '•']
}

export class Numbering {
  private abstracts = new Map<string, AbstractNum>()
  private nums = new Map<number, NumInstance>()
  private counters = new Map<string, { count: number[]; started: boolean[] }>()

  constructor(pkg: Pkg, theme: Theme) {
    const root = pkg.xml('word/numbering.xml')?.children.find((c) => c.name === 'numbering')
    if (!root) return
    for (const a of childrenNamed(root, 'abstractNum')) {
      const id = attr(a, 'abstractNumId')
      if (id === undefined) continue
      const levels = new Map<number, LvlDef>()
      for (const l of childrenNamed(a, 'lvl')) {
        const ilvl = numAttr(l, 'ilvl') ?? 0
        levels.set(ilvl, this.parseLvl(l, theme))
      }
      this.abstracts.set(id, { id, levels })
    }
    for (const n of childrenNamed(root, 'num')) {
      const numId = numAttr(n, 'numId')
      const abs = attr(child(n, 'abstractNumId'), 'val')
      if (numId === undefined || abs === undefined) continue
      const overrides = new Map<number, { start?: number; lvl?: LvlDef }>()
      for (const o of childrenNamed(n, 'lvlOverride')) {
        const ilvl = numAttr(o, 'ilvl') ?? 0
        const start = numAttr(child(o, 'startOverride'), 'val')
        const lvlEl = child(o, 'lvl')
        overrides.set(ilvl, { start, lvl: lvlEl ? this.parseLvl(lvlEl, theme) : undefined })
      }
      this.nums.set(numId, { numId, abstractId: abs, overrides })
    }
  }

  private parseLvl(l: XNode, theme: Theme): LvlDef {
    const suff = attr(child(l, 'suff'), 'val')
    const rpr = parseRPr(child(l, 'rPr'), theme)
    return {
      start: numAttr(child(l, 'start'), 'val') ?? 1,
      fmt: attr(child(l, 'numFmt'), 'val') ?? 'decimal',
      text: attr(child(l, 'lvlText'), 'val') ?? '',
      ppr: parsePPr(child(l, 'pPr'), theme),
      rpr,
      suff: suff === 'space' ? 'space' : suff === 'nothing' ? 'nothing' : 'tab',
      isLgl: child(l, 'isLgl') !== undefined,
      restart: numAttr(child(l, 'lvlRestart'), 'val'),
      font: attr(path(l, 'rPr', 'rFonts'), 'ascii')
    }
  }

  has(numId: number): boolean {
    return this.nums.has(numId)
  }

  private lvlOf(num: NumInstance, ilvl: number): LvlDef | undefined {
    return num.overrides.get(ilvl)?.lvl ?? this.abstracts.get(num.abstractId)?.levels.get(ilvl)
  }

  /** Advances the counters for a numbered paragraph and returns its label; null if the list is unknown or numbering is off (numId 0). */
  next(numId: number, ilvl: number): Marker | null {
    const num = this.nums.get(numId)
    if (!num) return null
    const abs = this.abstracts.get(num.abstractId)
    if (!abs) return null
    const lvl = this.lvlOf(num, ilvl)
    if (!lvl) return null
    const hasOverride = [...num.overrides.values()].some((o) => o.start !== undefined)
    const key = hasOverride ? `n${numId}` : `a${num.abstractId}`
    let st = this.counters.get(key)
    if (!st) {
      st = { count: Array<number>(9).fill(0), started: Array<boolean>(9).fill(false) }
      this.counters.set(key, st)
    }
    const startOf = (l: number): number => num.overrides.get(l)?.start ?? this.lvlOf(num, l)?.start ?? 1
    if (!st.started[ilvl]) {
      st.count[ilvl] = startOf(ilvl)
      st.started[ilvl] = true
    } else st.count[ilvl]++
    for (let l = ilvl + 1; l < 9; l++) {
      const d = this.lvlOf(num, l)
      // levels restart unless lvlRestart says 0 (never) or names a deeper level
      if (d?.restart === 0) continue
      if (d?.restart !== undefined && d.restart - 1 > ilvl) continue
      st.started[l] = false
    }
    let text = ''
    if (lvl.fmt === 'bullet') text = lvl.text
    else {
      text = lvl.text.replace(/%([1-9])/g, (_m, d: string) => {
        const k = Number(d) - 1
        const l = this.lvlOf(num, k)
        const n = st!.started[k] ? st!.count[k] : startOf(k)
        return formatNumber(lvl.isLgl ? 'decimal' : (l?.fmt ?? 'decimal'), n)
      })
    }
    return { text, rpr: lvl.rpr, ppr: lvl.ppr, suff: lvl.suff, isBullet: lvl.fmt === 'bullet', fontHint: lvl.font }
  }
}
