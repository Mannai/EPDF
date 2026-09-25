/**
 * A small backtracking regular-expression engine with a hard step and time budget.
 *
 * JavaScript's RegExp cannot be interrupted, so a user-supplied pattern such as `(a+)+$` can freeze the app on
 * the wrong input (catastrophic backtracking). Custom patterns are therefore run by this engine: it counts every
 * step and gives up (RegexBudgetError) when the budget is spent. It implements the commonly used ECMAScript
 * syntax (literals, classes, escapes, groups, alternation, greedy/lazy quantifiers, anchors, \b, backreferences,
 * lookahead/lookbehind, \p{..} with the u flag) and refuses anything else with RegexUnsupportedError instead of
 * guessing. The built-in presets are fixed, reviewed patterns and use the native engine.
 */

export class RegexSyntaxError extends Error {}
export class RegexUnsupportedError extends Error {}
export class RegexBudgetError extends Error {
  constructor() {
    super('This pattern takes too long to evaluate (it may backtrack catastrophically). Simplify it or make it more specific.')
  }
}

export interface Budget {
  maxSteps: number
  maxMs: number
}

export const DEFAULT_BUDGET: Budget = { maxSteps: 4_000_000, maxMs: 1500 }

type SetItem = { lo: number; hi: number } | { cls: 'd' | 'D' | 'w' | 'W' | 's' | 'S' } | { prop: RegExp; neg: boolean }

type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'set'; neg: boolean; items: SetItem[] }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; alts: Node[] }
  | { t: 'group'; node: Node; idx: number }
  | { t: 'look'; ahead: boolean; neg: boolean; node: Node }
  | { t: 'rep'; node: Node; min: number; max: number; lazy: boolean }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'wordb'; neg: boolean }
  | { t: 'backref'; idx: number; name?: string }

const MAX_REPEAT = 1000
const MAX_PATTERN = 2000

// ---------------------------------------------------------------------------------------------------------
// Parser

class Parser {
  private i = 0
  groups = 0
  names = new Map<string, number>()
  readonly cps: number[]
  constructor(
    pattern: string,
    private unicode: boolean
  ) {
    this.cps = unicode ? Array.from(pattern, (c) => c.codePointAt(0)!) : Array.from({ length: pattern.length }, (_, k) => pattern.charCodeAt(k))
  }

  private peek(): number | undefined {
    return this.cps[this.i]
  }
  private eat(c: string): boolean {
    if (this.cps[this.i] === c.charCodeAt(0)) {
      this.i++
      return true
    }
    return false
  }
  private isNext(s: string): boolean {
    for (let k = 0; k < s.length; k++) if (this.cps[this.i + k] !== s.charCodeAt(k)) return false
    return true
  }

  parse(): Node {
    const n = this.alt()
    if (this.i < this.cps.length) throw new RegexSyntaxError('Unmatched ")" in the pattern.')
    return n
  }

  private alt(): Node {
    const alts: Node[] = [this.seq()]
    while (this.eat('|')) alts.push(this.seq())
    return alts.length === 1 ? alts[0] : { t: 'alt', alts }
  }

  private seq(): Node {
    const items: Node[] = []
    while (this.i < this.cps.length && this.peek() !== 0x7c && this.peek() !== 0x29) {
      let atom = this.atom()
      atom = this.quantifier(atom)
      items.push(atom)
    }
    return items.length === 1 ? items[0] : { t: 'seq', items }
  }

  private quantifier(atom: Node): Node {
    const c = this.peek()
    let min: number
    let max: number
    if (c === 0x2a) (min = 0), (max = Infinity), this.i++
    else if (c === 0x2b) (min = 1), (max = Infinity), this.i++
    else if (c === 0x3f) (min = 0), (max = 1), this.i++
    else if (c === 0x7b) {
      const save = this.i
      this.i++
      const a = this.int()
      if (a === null) {
        this.i = save
        return atom
      }
      min = a
      max = a
      if (this.eat(',')) max = this.int() ?? Infinity
      if (!this.eat('}')) {
        this.i = save
        return atom
      }
      if (min > max) throw new RegexSyntaxError('Numbers out of order in {} quantifier.')
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) throw new RegexUnsupportedError(`Repeat counts above ${MAX_REPEAT} are not supported.`)
    } else return atom
    if (atom.t === 'bol' || atom.t === 'eol' || atom.t === 'wordb') throw new RegexSyntaxError('Nothing to repeat.')
    const lazy = this.eat('?')
    return { t: 'rep', node: atom, min, max, lazy }
  }

  private int(): number | null {
    let s = ''
    while (this.peek() !== undefined && this.peek()! >= 0x30 && this.peek()! <= 0x39) s += String.fromCharCode(this.cps[this.i++])
    return s === '' ? null : Number(s)
  }

  private atom(): Node {
    const c = this.cps[this.i++]
    switch (c) {
      case 0x28:
        return this.group()
      case 0x5b:
        return this.set()
      case 0x2e:
        return { t: 'any' }
      case 0x5e:
        return { t: 'bol' }
      case 0x24:
        return { t: 'eol' }
      case 0x5c:
        return this.escape(false) as Node
      case 0x2a:
      case 0x2b:
      case 0x3f:
        throw new RegexSyntaxError('Nothing to repeat.')
      case 0x7b:
        // a literal brace when not a quantifier
        return { t: 'char', c }
      default:
        return { t: 'char', c }
    }
  }

  private group(): Node {
    let node: Node
    if (this.isNext('?:')) {
      this.i += 2
      node = this.alt()
      this.expectClose()
      return { t: 'group', node, idx: -1 }
    }
    if (this.isNext('?=') || this.isNext('?!')) {
      const neg = this.cps[this.i + 1] === 0x21
      this.i += 2
      node = this.alt()
      this.expectClose()
      return { t: 'look', ahead: true, neg, node }
    }
    if (this.isNext('?<=') || this.isNext('?<!')) {
      const neg = this.cps[this.i + 2] === 0x21
      this.i += 3
      node = this.alt()
      this.expectClose()
      return { t: 'look', ahead: false, neg, node }
    }
    let name: string | undefined
    if (this.isNext('?<')) {
      this.i += 2
      name = ''
      while (this.peek() !== undefined && this.peek() !== 0x3e) name += String.fromCodePoint(this.cps[this.i++])
      if (!this.eat('>') || !name) throw new RegexSyntaxError('Invalid group name.')
    } else if (this.peek() === 0x3f) throw new RegexUnsupportedError('This group syntax is not supported.')
    const idx = ++this.groups
    if (name) this.names.set(name, idx)
    node = this.alt()
    this.expectClose()
    return { t: 'group', node, idx }
  }

  private expectClose(): void {
    if (!this.eat(')')) throw new RegexSyntaxError('Missing ")" in the pattern.')
  }

  private hex(n: number): number {
    let s = ''
    for (let k = 0; k < n; k++) s += String.fromCharCode(this.cps[this.i++] ?? 0x67)
    if (!/^[0-9a-fA-F]+$/.test(s)) throw new RegexSyntaxError('Invalid escape in the pattern.')
    return parseInt(s, 16)
  }

  /** After a backslash. In a set, returns set items; outside, a node. */
  private escape(inSet: boolean): Node | SetItem {
    const c = this.cps[this.i++]
    if (c === undefined) throw new RegexSyntaxError('A pattern cannot end with a backslash.')
    const ch = String.fromCharCode(c)
    switch (ch) {
      case 'd':
      case 'D':
      case 'w':
      case 'W':
      case 's':
      case 'S':
        return inSet ? { cls: ch } : { t: 'set', neg: false, items: [{ cls: ch }] }
      case 'b':
        return inSet ? { lo: 8, hi: 8 } : { t: 'wordb', neg: false }
      case 'B':
        if (inSet) throw new RegexSyntaxError('Invalid escape in a character class.')
        return { t: 'wordb', neg: true }
      case 'n':
        return this.lit(10, inSet)
      case 'r':
        return this.lit(13, inSet)
      case 't':
        return this.lit(9, inSet)
      case 'f':
        return this.lit(12, inSet)
      case 'v':
        return this.lit(11, inSet)
      case '0':
        return this.lit(0, inSet)
      case 'x':
        return this.lit(this.hex(2), inSet)
      case 'u':
        if (this.peek() === 0x7b && this.unicode) {
          this.i++
          let s = ''
          while (this.peek() !== undefined && this.peek() !== 0x7d) s += String.fromCharCode(this.cps[this.i++])
          this.i++
          return this.lit(parseInt(s, 16), inSet)
        }
        return this.lit(this.hex(4), inSet)
      case 'p':
      case 'P': {
        if (!this.unicode) return this.lit(c, inSet)
        if (!this.eat('{')) throw new RegexSyntaxError('Invalid property escape.')
        let s = ''
        while (this.peek() !== undefined && this.peek() !== 0x7d) s += String.fromCharCode(this.cps[this.i++])
        this.i++
        // \p{..} (and \P{..}) is tested on one character at a time with the native engine
        let item: SetItem
        try {
          item = { prop: new RegExp(`^\\p{${s}}$`, 'u'), neg: ch === 'P' }
        } catch {
          throw new RegexSyntaxError('Unknown Unicode property.')
        }
        return inSet ? item : { t: 'set', neg: false, items: [item] }
      }
      case 'k': {
        if (inSet) return this.lit(c, inSet)
        if (!this.eat('<')) throw new RegexSyntaxError('Invalid named reference.')
        let name = ''
        while (this.peek() !== undefined && this.peek() !== 0x3e) name += String.fromCodePoint(this.cps[this.i++])
        this.i++
        return { t: 'backref', idx: -1, name }
      }
      default:
        if (c >= 0x31 && c <= 0x39 && !inSet) {
          let n = String.fromCharCode(c)
          while (this.peek() !== undefined && this.peek()! >= 0x30 && this.peek()! <= 0x39) n += String.fromCharCode(this.cps[this.i++])
          return { t: 'backref', idx: Number(n) }
        }
        return this.lit(c, inSet)
    }
  }

  private lit(c: number, inSet: boolean): Node | SetItem {
    return inSet ? { lo: c, hi: c } : { t: 'char', c }
  }

  private set(): Node {
    const neg = this.eat('^')
    const items: SetItem[] = []
    while (true) {
      const c = this.cps[this.i++]
      if (c === undefined) throw new RegexSyntaxError('Missing "]" in the pattern.')
      if (c === 0x5d) break
      let lo: SetItem
      if (c === 0x5c) lo = this.escape(true) as SetItem
      else lo = { lo: c, hi: c }
      if (this.peek() === 0x2d && this.cps[this.i + 1] !== 0x5d && this.cps[this.i + 1] !== undefined && 'lo' in lo) {
        this.i++
        const c2 = this.cps[this.i++]
        const hi = c2 === 0x5c ? (this.escape(true) as SetItem) : ({ lo: c2, hi: c2 } as SetItem)
        if (!('lo' in hi)) throw new RegexSyntaxError('Invalid range in a character class.')
        if (hi.lo < lo.lo) throw new RegexSyntaxError('Range out of order in a character class.')
        items.push({ lo: lo.lo, hi: hi.lo })
      } else items.push(lo)
    }
    return { t: 'set', neg, items }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Matcher

interface State {
  t: number[]
  n: number
  caps: ([number, number] | undefined)[]
  steps: number
  max: number
  deadline: number
  icase: boolean
  multiline: boolean
  dotAll: boolean
}

type K = (p: number) => boolean
type M = (s: State, p: number, k: K) => boolean

const isWordCp = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122)
const isSpaceCp = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
const isLineTerm = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029

const lower = (c: number): number => {
  const s = String.fromCodePoint(c).toLowerCase()
  return s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff) ? s.codePointAt(0)! : c
}
const upper = (c: number): number => {
  const s = String.fromCodePoint(c).toUpperCase()
  return s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff) ? s.codePointAt(0)! : c
}

function setHas(items: readonly SetItem[], c: number): boolean {
  for (const it of items) {
    if ('lo' in it) {
      if (c >= it.lo && c <= it.hi) return true
    } else if ('cls' in it) {
      switch (it.cls) {
        case 'd':
          if (c >= 48 && c <= 57) return true
          break
        case 'D':
          if (!(c >= 48 && c <= 57)) return true
          break
        case 'w':
          if (isWordCp(c)) return true
          break
        case 'W':
          if (!isWordCp(c)) return true
          break
        case 's':
          if (isSpaceCp(c)) return true
          break
        case 'S':
          if (!isSpaceCp(c)) return true
          break
      }
    } else if (it.prop.test(String.fromCodePoint(c)) !== it.neg) return true
  }
  return false
}

function tick(s: State): void {
  if (++s.steps > s.max) throw new RegexBudgetError()
  if ((s.steps & 1023) === 0 && Date.now() > s.deadline) throw new RegexBudgetError()
}

/** A node that consumes exactly one character, as a predicate (or null if it is not one). */
function singleChar(n: Node, icase: boolean, dotAll: boolean): ((c: number) => boolean) | null {
  switch (n.t) {
    case 'char': {
      const want = n.c
      if (!icase) return (c) => c === want
      const l = lower(want)
      const u = upper(want)
      return (c) => c === want || c === l || c === u || lower(c) === l
    }
    case 'any':
      return dotAll ? () => true : (c) => !isLineTerm(c)
    case 'set': {
      const { items, neg } = n
      if (!icase) return (c) => setHas(items, c) !== neg
      return (c) => (setHas(items, c) || setHas(items, lower(c)) || setHas(items, upper(c))) !== neg
    }
    case 'group':
      return n.idx === -1 ? singleChar(n.node, icase, dotAll) : null
    default:
      return null
  }
}

function compile(n: Node, names: Map<string, number>, icase: boolean, dotAll: boolean): M {
  const one = singleChar(n, icase, dotAll)
  if (one) {
    return (s, p, k) => {
      tick(s)
      return p < s.n && one(s.t[p]) ? k(p + 1) : false
    }
  }
  switch (n.t) {
    case 'seq': {
      const ms = n.items.map((x) => compile(x, names, icase, dotAll))
      return (s, p, k) => {
        const run = (i: number, pos: number): boolean => (i === ms.length ? k(pos) : ms[i](s, pos, (q) => run(i + 1, q)))
        return run(0, p)
      }
    }
    case 'alt': {
      const ms = n.alts.map((x) => compile(x, names, icase, dotAll))
      return (s, p, k) => {
        tick(s)
        for (const m of ms) if (m(s, p, k)) return true
        return false
      }
    }
    case 'group': {
      const m = compile(n.node, names, icase, dotAll)
      const idx = n.idx
      if (idx < 0) return m
      return (s, p, k) =>
        m(s, p, (q) => {
          const prev = s.caps[idx]
          s.caps[idx] = [p, q]
          if (k(q)) return true
          s.caps[idx] = prev
          return false
        })
    }
    case 'look': {
      const m = compile(n.node, names, icase, dotAll)
      if (n.ahead) {
        return (s, p, k) => {
          tick(s)
          const saved = s.caps.slice()
          const r = m(s, p, () => true)
          if (n.neg) {
            s.caps = saved
            return !r && k(p)
          }
          if (!r) return false
          if (k(p)) return true
          s.caps = saved
          return false
        }
      }
      return (s, p, k) => {
        tick(s)
        let found = false
        for (let j = p; j >= 0 && !found; j--) found = m(s, j, (e) => e === p)
        return n.neg ? !found && k(p) : found && k(p)
      }
    }
    case 'rep': {
      const pred = singleChar(n.node, icase, dotAll)
      const { min, max, lazy } = n
      if (pred) {
        return (s, p, k) => {
          if (lazy) {
            let c = 0
            while (c < min) {
              tick(s)
              if (p + c >= s.n || !pred(s.t[p + c])) return false
              c++
            }
            for (;;) {
              tick(s)
              if (k(p + c)) return true
              if (c >= max || p + c >= s.n || !pred(s.t[p + c])) return false
              c++
            }
          }
          let c = 0
          while (c < max && p + c < s.n && pred(s.t[p + c])) {
            c++
            if ((c & 255) === 0) tick(s)
          }
          for (; c >= min; c--) {
            tick(s)
            if (k(p + c)) return true
          }
          return false
        }
      }
      const m = compile(n.node, names, icase, dotAll)
      return (s, p, k) => {
        const rep = (pos: number, count: number): boolean => {
          tick(s)
          if (lazy) {
            if (count >= min && k(pos)) return true
            return count < max && m(s, pos, (q) => (q === pos && count >= min ? false : rep(q, count + 1)))
          }
          if (count < max && m(s, pos, (q) => (q === pos && count >= min ? false : rep(q, count + 1)))) return true
          return count >= min && k(pos)
        }
        return rep(p, 0)
      }
    }
    case 'bol':
      return (s, p, k) => (p === 0 || (s.multiline && isLineTerm(s.t[p - 1])) ? k(p) : false)
    case 'eol':
      return (s, p, k) => (p === s.n || (s.multiline && isLineTerm(s.t[p])) ? k(p) : false)
    case 'wordb':
      return (s, p, k) => {
        const a = p > 0 && isWordCp(s.t[p - 1])
        const b = p < s.n && isWordCp(s.t[p])
        return (a !== b) !== n.neg ? k(p) : false
      }
    case 'backref': {
      const idx = n.name !== undefined ? (names.get(n.name) ?? -1) : n.idx
      if (idx < 0) throw new RegexSyntaxError('Reference to a group that does not exist.')
      return (s, p, k) => {
        const cap = s.caps[idx]
        if (!cap) return k(p)
        const len = cap[1] - cap[0]
        if (p + len > s.n) return false
        for (let i = 0; i < len; i++) {
          const a = s.t[cap[0] + i]
          const b = s.t[p + i]
          if (a !== b && !(icase && lower(a) === lower(b))) return false
        }
        return k(p + len)
      }
    }
    default:
      throw new RegexUnsupportedError('Unsupported pattern element.')
  }
}

export interface Range {
  start: number
  end: number
}

export interface SafeRegex {
  /** All non-empty, non-overlapping matches (UTF-16 offsets). Throws RegexBudgetError when the budget is spent. */
  findAll(text: string, budget?: Budget): Range[]
}

export function compileSafeRegex(pattern: string, flags = ''): SafeRegex {
  if (pattern.length === 0) throw new RegexSyntaxError('The pattern is empty.')
  if (pattern.length > MAX_PATTERN) throw new RegexUnsupportedError('The pattern is too long.')
  if (!/^[gimsuyd]*$/.test(flags)) throw new RegexSyntaxError('Unknown flag.')
  if (/[vy]/.test(flags)) throw new RegexUnsupportedError('This flag is not supported.')
  const unicode = flags.includes('u')
  // native syntax check: gives the standard error message for anything malformed
  try {
    new RegExp(pattern, flags.replace(/[gd]/g, ''))
  } catch (e) {
    throw new RegexSyntaxError(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'Invalid pattern.')
  }
  const parser = new Parser(pattern, unicode)
  const ast = parser.parse()
  const icase = flags.includes('i')
  const multiline = flags.includes('m')
  const dotAll = flags.includes('s')
  const m = compile(ast, parser.names, icase, dotAll)
  const ngroups = parser.groups

  return {
    findAll(text, budget = DEFAULT_BUDGET) {
      // Work on code points when the u flag is set, on UTF-16 units otherwise; `offs` maps back to UTF-16 offsets.
      let cps: number[]
      let offs: number[] | null = null
      if (unicode) {
        cps = []
        offs = []
        for (let i = 0; i < text.length; ) {
          const cp = text.codePointAt(i)!
          offs.push(i)
          cps.push(cp)
          i += cp > 0xffff ? 2 : 1
        }
        offs.push(text.length)
      } else cps = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
      const s: State = { t: cps, n: cps.length, caps: new Array(ngroups + 1).fill(undefined), steps: 0, max: budget.maxSteps, deadline: Date.now() + budget.maxMs, icase, multiline, dotAll }
      const out: Range[] = []
      let pos = 0
      while (pos <= s.n) {
        let end = -1
        s.caps.fill(undefined)
        m(s, pos, (q) => {
          end = q
          return true
        })
        if (end > pos) {
          out.push({ start: offs ? offs[pos] : pos, end: offs ? offs[end] : end })
          pos = end
        } else pos++
      }
      return out
    }
  }
}

/** Checks a user-supplied pattern; on success it is safe to run through `compileSafeRegex`. */
export function validateRegex(pattern: string, flags = ''): { ok: true } | { ok: false; message: string } {
  try {
    compileSafeRegex(pattern, flags)
    return { ok: true }
  } catch (e) {
    if (e instanceof RegexSyntaxError || e instanceof RegexUnsupportedError) return { ok: false, message: e.message }
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
