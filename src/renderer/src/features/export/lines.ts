import type { Align, Run, TextItem } from './model'

/** A run of text that is separated from its neighbours on the same baseline by a wide gap (a "cell"). */
export interface Seg {
  x0: number
  x1: number
  items: TextItem[]
}

export interface Line {
  /** Baseline y (top-down page coordinates). */
  y: number
  top: number
  bottom: number
  x0: number
  x1: number
  /** Font size of the dominant (longest) text on the line. */
  size: number
  segs: Seg[]
  items: TextItem[]
}

const styleKey = (i: TextItem): string => `${i.family}|${Math.round(i.size * 2) / 2}|${i.bold ? 1 : 0}${i.italic ? 1 : 0}|${i.color}|${i.url ?? ''}|${i.rtl ? 'r' : ''}`

/** Merges text items (already ordered left to right) into styled runs, inserting spaces where the gap needs one. */
export function runsOf(items: TextItem[]): Run[] {
  const runs: (Run & { key: string })[] = []
  let prev: TextItem | null = null
  for (const it of items) {
    let needSpace = false
    if (prev) {
      const gap = it.x - (prev.x + prev.width)
      needSpace = gap > 0.12 * Math.min(prev.size, it.size) && !/\s$/.test(prev.text) && !/^\s/.test(it.text)
    }
    const key = styleKey(it)
    const last = runs[runs.length - 1]
    if (last && last.key === key) {
      last.text += (needSpace ? ' ' : '') + it.text
    } else {
      if (needSpace && last) last.text += ' '
      runs.push({ key, text: it.text, size: Math.round(it.size * 2) / 2, family: it.family, bold: it.bold, italic: it.italic, color: it.color, url: it.url, ...(it.rtl ? { rtl: true } : {}) })
    }
    prev = it
  }
  return runs.map(({ key: _k, ...r }) => r)
}

export const textOfRuns = (runs: Run[]): string => runs.map((r) => r.text).join('')

/** Gap (points) above which two pieces of text on one baseline are treated as separate cells. */
const segGap = (size: number): number => Math.max(1.6 * size, 10)

/**
 * Groups text items into lines by baseline and splits each line into segments at wide gaps.
 * Items must already be in top-left page coordinates.
 */
export function buildLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const groups: { items: TextItem[]; y: number; size: number }[] = []
  for (const it of sorted) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(it.y - last.y) <= Math.max(1.2, 0.3 * Math.min(it.size, last.size))) {
      last.y = (last.y * last.items.length + it.y) / (last.items.length + 1)
      last.items.push(it)
    } else groups.push({ items: [it], y: it.y, size: it.size })
  }
  return groups.map((g) => {
    const its = g.items.sort((a, b) => a.x - b.x)
    const dominant = its.reduce((m, i) => (i.text.length > m.text.length ? i : m), its[0])
    const size = dominant.size
    const segs: Seg[] = []
    let cur: Seg | null = null
    for (const it of its) {
      const prev: TextItem | undefined = cur?.items[cur.items.length - 1]
      if (!cur || !prev || it.x - (prev.x + prev.width) > segGap(Math.min(prev.size, it.size))) {
        cur = { x0: it.x, x1: it.x + it.width, items: [it] }
        segs.push(cur)
      } else {
        cur.items.push(it)
        cur.x1 = Math.max(cur.x1, it.x + it.width)
      }
    }
    const maxSize = Math.max(...its.map((i) => i.size))
    return {
      y: g.y,
      top: g.y - 0.8 * maxSize,
      bottom: g.y + 0.2 * maxSize,
      x0: Math.min(...its.map((i) => i.x)),
      x1: Math.max(...its.map((i) => i.x + i.width)),
      size,
      segs,
      items: its
    }
  })
}

const sameStyle = (a: Run, b: Run): boolean =>
  a.family === b.family && a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.url === b.url && !!a.rtl === !!b.rtl

/** Appends `more` to `runs`, merging neighbours with the same style. */
export function appendRuns(runs: Run[], more: Run[]): void {
  for (const r of more) {
    const last = runs[runs.length - 1]
    if (last && sameStyle(last, r)) last.text += r.text
    else runs.push({ ...r })
  }
}

/** Removes leading whitespace of the first run and trailing whitespace of the last, dropping empty runs. */
export function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }))
  while (out.length && !out[0].text.trimStart()) out.shift()
  if (out.length) out[0].text = out[0].text.trimStart()
  while (out.length && !out[out.length - 1].text.trimEnd()) out.pop()
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd()
  return out
}

/**
 * Joins consecutive lines of one paragraph into runs. Lines are separated by a space; a hyphen that ends a
 * line right after a letter, when the next line continues in lower case, is removed (the word was split by
 * hyphenation). `fullLine(i)` says whether line `i` reaches the right edge of the text area, which is what
 * makes a trailing hyphen a hyphenation point and not a genuine compound hyphen.
 */
export function joinLines(lines: Line[], fullLine: (i: number) => boolean = () => false): Run[] {
  const runs: Run[] = []
  lines.forEach((l, i) => {
    const lr: Run[] = []
    l.segs.forEach((s, k) => {
      if (k > 0) lr.push({ ...runsOf(s.items)[0], text: '\t' })
      appendRuns(lr, runsOf(s.items))
    })
    if (i > 0) {
      const prev = runs[runs.length - 1]
      const next = lr[0]
      if (prev && next && /[A-Za-zÀ-ɏ]-$/.test(prev.text) && /^[a-zß-ÿ]/.test(next.text) && fullLine(i - 1)) {
        prev.text = prev.text.slice(0, -1)
      } else if (prev && !/\s$/.test(prev.text)) {
        prev.text += ' '
      }
    }
    appendRuns(runs, lr)
  })
  return trimRuns(runs)
}

export const lineText =(l: Line): string => l.segs.map((s) => textOfRuns(runsOf(s.items)).trim()).join('  ')

export function alignOfBox(x0: number, x1: number, left: number, right: number, tol = 3): Align {
  const width = right - left
  if (width <= 0) return 'left'
  const center = (x0 + x1) / 2
  const mid = (left + right) / 2
  if (Math.abs(x0 - left) <= tol) return 'left'
  if (Math.abs(x1 - right) <= tol && x0 - left > 0.25 * width) return 'right'
  if (Math.abs(center - mid) <= tol + 0.01 * width && x0 - left > 0.06 * width) return 'center'
  return 'left'
}
