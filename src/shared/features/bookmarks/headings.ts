import { normalizeGlyphText } from '../../pagetext/unicode'
import { isRtlCodePoint, rtlRatio, visualToLogical, type TextLine } from '../textlines'

/**
 * Heading detection for auto-generated bookmarks. Pure TypeScript over `TextLine`s (see ../textlines), so it
 * runs in a worker and in Node tests.
 *
 * What it looks at: font size against the document's body size, bold, numbering patterns ("1.", "1.2", "II.",
 * "Chapter 3", "الفصل الأول", "第三章", ...), ALL-CAPS lines, isolation (space around the line), repetition of
 * the same style, and it discards running headers/footers (the same text at the top or bottom of many pages) and
 * page numbers. Heading levels come from numbering depth and from clusters of sizes. Multi-column and
 * right-to-left pages are ordered in reading order.
 */

export interface PageText {
  pageIndex: number
  /** Visible box of the page in user space: [x0, y0, x1, y1]. */
  box: [number, number, number, number]
  lines: TextLine[]
}

export interface HeadingCandidate {
  /** Stable within one detection run. */
  id: number
  pageIndex: number
  text: string
  /** 1-based nesting level. */
  level: number
  /** 0..1. Above `DEFAULT_ACCEPT` the review list pre-selects it. */
  confidence: number
  reasons: string[]
  size: number
  bold: boolean
  rtl: boolean
  /** Left edge and top of the heading in user space (the destination is written at the top). */
  x: number
  top: number
  numbering?: string
}

export interface DetectStats {
  bodySize: number
  pages: number
  lines: number
  headingSizes: number[]
  removedRunning: number
  columnPages: number
}

export interface DetectResult {
  candidates: HeadingCandidate[]
  stats: DetectStats
}

export interface DetectOptions {
  /** Candidates below this confidence are dropped. Default 0.35. */
  minConfidence?: number
  maxLevels?: number
}

export const DEFAULT_ACCEPT = 0.55
export const MAX_HEADING_LEVELS = 6

// ---------------------------------------------------------------- text helpers

const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g

/** Western digits for Arabic-Indic and Persian digits. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
}

/**
 * Arabic text from many producers (Chromium, Word) comes out of the font's /ToUnicode as shaped presentation
 * forms (U+FE70..U+FEFF: initial, medial, final and ligature glyphs). They become the base letters readers would
 * type and search for, with the same normalisation the page text model applies to glyph text.
 */
export function plainArabic(s: string): string {
  return normalizeGlyphText(s)
}

const ARABIC_ONLY = /[\u0629\u0623\u0625\u0649\u064A\u0643]/ // teh marbuta, hamza-alefs, alef maksura, Arabic yeh and kaf
const PERSIAN_ONLY = /[\u067E\u0686\u0698\u06AF]/ // Persian/Urdu-only: peh, tcheh, jeh, gaf

/**
 * Fonts often map a glyph to the Persian/Urdu variant of a letter (ھ U+06BE, ی U+06CC, ک U+06A9) although the
 * text is Arabic (Tahoma in Chromium output does). In a document that shows Arabic-only letters and no Persian-only
 * ones, those variants are folded back to the Arabic letters (ه ي ك) so titles read as they were typed.
 */
export function foldToArabicLetters(s: string): string {
  return s.replace(/\u06BE/g, '\u0647').replace(/\u06CC/g, '\u064A').replace(/\u06A9/g, '\u0643')
}

/** Text with the variable parts flattened, for spotting the same header/footer on many pages. */
export function normalizeForRepeat(s: string): string {
  return asciiDigits(s.normalize('NFKC'))
    .replace(ARABIC_DIACRITICS, '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const letterCount = (s: string): number => (s.match(/\p{L}/gu) ?? []).length
const wordCount = (s: string): number => (s.trim().match(/\S+/g) ?? []).length

/** Latin/Greek/Cyrillic text with no lowercase letters. */
function isAllCaps(s: string): boolean {
  const letters = Array.from(s).filter((c) => /\p{L}/u.test(c) && !isRtlCodePoint(c.codePointAt(0)!) && /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(c))
  if (letters.length < 4) return false
  return letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase())
}

// ---------------------------------------------------------------- patterns

const ROMAN = '[IVXLCDM]{1,7}'
const KEYWORDS_EN = 'chapter|part|section|appendix|book|unit|lesson|article|annex|module|topic|volume'
const KEYWORDS_OTHER =
  'chapitre|partie|annexe|sección|capítulo|parte|apéndice|kapitel|teil|anhang|capitolo|sezione|глава|раздел|часть|приложение|' +
  'الفصل|فصل|الباب|باب|القسم|الجزء|الملحق|الوحدة|الدرس|المادة|المبحث|المحور|' +
  'פרק|חלק|נספח|' +
  'bölüm|kısım|ek'
const PART_LIKE = /^(part|book|volume|partie|parte|teil|الجزء|القسم|חלק)\b/i

interface Pattern {
  kind: 'number' | 'roman' | 'letter' | 'keyword' | 'standalone' | 'cjk'
  /** Numbering depth for "1.2.3"-style patterns, else undefined. */
  depth?: number
  label: string
  partLike?: boolean
}

const STANDALONE = new RegExp(
  '^(introduction|abstract|summary|executive summary|conclusions?|references|bibliography|acknowledge?ments?|preface|foreword|contents|table of contents|glossary|index|overview|background|methods?|methodology|results|discussion|appendix|' +
    'المقدمة|مقدمة|الملخص|ملخص|الخاتمة|خاتمة|المراجع|المصادر|الفهرس|فهرس|المحتويات|شكر وتقدير|تمهيد|التوصيات|النتائج|' +
    'מבוא|תקציר|סיכום|מקורות|תוכן עניינים|' +
    'introducción|resumen|conclusión|referencias|introduction|résumé|einleitung|zusammenfassung|литература|введение|заключение|' +
    '序言|前言|摘要|目录|目錄|结论|結論|参考文献|參考文獻|はじめに|まとめ|参考文献|서론|결론|참고문헌)$',
  'iu'
)

export function classify(rawText: string): Pattern | null {
  const text = asciiDigits(rawText.normalize('NFKC').replace(ARABIC_DIACRITICS, '')).replace(/\s+/g, ' ').trim()
  let m: RegExpExecArray | null
  if ((m = /^(\d{1,3}(?:\.\d{1,3}){0,4})[.)]?\s+\S/.exec(text))) {
    const depth = m[1].split('.').length
    return { kind: 'number', depth, label: m[1] }
  }
  if ((m = new RegExp(`^(${ROMAN})[.)]\\s+\\S`).exec(text))) return { kind: 'roman', depth: 1, label: m[1] }
  if ((m = /^([A-Z])[.)]\s+[A-ZÀ-ɏ]/.exec(text))) return { kind: 'letter', depth: 2, label: m[1] }
  if ((m = /^第\s*([0-9一二三四五六七八九十百千零〇两兩]+)\s*([章节節部篇编編卷])/.exec(text))) {
    return { kind: 'cjk', depth: m[2] === '章' || m[2] === '部' || m[2] === '篇' || m[2] === '卷' ? 1 : 2, label: `第${m[1]}${m[2]}` }
  }
  if ((m = new RegExp(`^(${KEYWORDS_EN}|${KEYWORDS_OTHER})(?:\\s*(\\d+)|\\s+(${ROMAN}|[A-Za-z]|[\\u0621-\\u064A]{2,12}|[\\u0590-\\u05FF]{1,10}|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third))?(?=\\s|[:.\\-\u2013\u2014]|$)`, 'iu').exec(text))) {
    // A bare "section" or "part" is not a heading by itself: it needs a number or ordinal after it, or a colon/dash.
    const rest = text.slice(m[0].length).trim()
    const hasToken = m[2] !== undefined || m[3] !== undefined
    const looksLikeHeading = (hasToken && (rest.length === 0 || wordCount(text) <= 10)) || /^[:.\-\u2013\u2014]/.test(rest)
    if (looksLikeHeading) return { kind: 'keyword', depth: 1, label: m[1], partLike: PART_LIKE.test(m[1]) }
  }
  if (STANDALONE.test(text.replace(/[:.]$/, ''))) return { kind: 'standalone', label: text }
  return null
}

const PAGE_NUMBER_LIKE = /^(?:(?:page|p\.?|pg\.?|صفحة|עמוד|seite|página|страница)\s*)?[-–—]?\s*#{1,5}\s*[-–—]?(?:\s*(?:of|\/|من|מתוך|von|de|из)\s*#{1,5})?$/i
const CAPTION = /^(figure|fig\.?|table|tab\.?|chart|graph|listing|شكل|جدول|صورة|رسم|איור|טבלה|abbildung|tabelle|figura|tabla|рисунок|таблица|图|圖|表)\s*[0-9IVX#.]/i
const BULLET = /^[•·▪◦‣⁃\-–—*●○■□►▶➢✓✔]\s/
const TOC_ENTRY = /(?:\.{3,}|…{1,}|(?:\s\.){3,}|·{3,}|_{3,})\s*[0-9IVXivx٠-٩۰-۹]+\s*$/
const SENTENCE_END = /[.!?؟。！？]["'”’)\]]*$/

// ---------------------------------------------------------------- detection

interface Work {
  page: PageText
  line: TextLine
  text: string
  /** Same logical text with variants (as stored / reordered) for pattern matching. */
  variants: string[]
  pattern: Pattern | null
  ratio: number
  column: number
  fullWidth: boolean
  gapAbove: number
  gapBelow: number
  score: number
  reasons: string[]
  cluster: number
  merged?: Work[]
}

function bodySizeOf(pages: PageText[]): number {
  const hist = new Map<number, number>()
  for (const p of pages) {
    for (const l of p.lines) {
      const key = Math.round(l.size * 2) / 2
      hist.set(key, (hist.get(key) ?? 0) + letterCount(l.text))
    }
  }
  let best = 11
  let bw = -1
  for (const [k, w] of hist) {
    if (w > bw || (w === bw && k < best)) {
      best = k
      bw = w
    }
  }
  return best
}

/** Groups lines of a page into columns (by left edge, or right edge on right-to-left pages). */
function columnsOf(page: PageText, body: number): { boundaries: number[]; rtl: boolean; fullWidth: number } {
  const bodyLines = page.lines.filter((l) => Math.abs(l.size - body) <= body * 0.12 && letterCount(l.text) >= 25)
  const rtlLines = bodyLines.filter((l) => l.rtl).length
  const rtl = bodyLines.length > 0 && rtlLines / bodyLines.length > 0.5
  const pageW = page.box[2] - page.box[0]
  const edges = bodyLines.map((l) => (rtl ? l.x1 : l.x0)).sort((a, b) => a - b)
  if (edges.length < 6) return { boundaries: [], rtl, fullWidth: pageW }
  // Split the sorted edges wherever the gap is wide; keep clusters with real content.
  const clusters: number[][] = [[edges[0]]]
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] > pageW * 0.15) clusters.push([edges[i]])
    else clusters[clusters.length - 1].push(edges[i])
  }
  const real = clusters.filter((c) => c.length >= 4)
  if (real.length < 2) return { boundaries: [], rtl, fullWidth: pageW }
  const centers = real.map((c) => median(c))
  const boundaries = centers.slice(1).map((c, i) => (c + centers[i]) / 2)
  const minX = Math.min(...bodyLines.map((l) => l.x0))
  const maxX = Math.max(...bodyLines.map((l) => l.x1))
  return { boundaries, rtl, fullWidth: maxX - minX }
}

export function detectHeadings(pages: PageText[], options: DetectOptions = {}): DetectResult {
  const minConfidence = options.minConfidence ?? 0.35
  const maxLevels = Math.min(options.maxLevels ?? MAX_HEADING_LEVELS, MAX_HEADING_LEVELS)
  const totalPages = pages.length
  const totalLines = pages.reduce((s, p) => s + p.lines.length, 0)
  const body = bodySizeOf(pages)

  // ---- running headers / footers and page numbers
  const repeat = new Map<string, Set<number>>()
  const bandOf = (p: PageText, l: TextLine): 'top' | 'bottom' | null => {
    const h = p.box[3] - p.box[1]
    if (l.y1 > p.box[3] - 0.1 * h) return 'top'
    if (l.y0 < p.box[1] + 0.1 * h) return 'bottom'
    return null
  }
  const keyOf = (p: PageText, l: TextLine): string | null => {
    const band = bandOf(p, l)
    // A running header/footer sits at the same height on every page: the position is part of the key.
    return band ? `${band}|${Math.round(l.size)}|${Math.round(l.y1 / 4)}|${normalizeForRepeat(l.text)}` : null
  }
  for (const p of pages) {
    for (const l of p.lines) {
      const k = keyOf(p, l)
      if (!k) continue
      const set = repeat.get(k) ?? new Set<number>()
      set.add(p.pageIndex)
      repeat.set(k, set)
    }
  }
  const repeatThreshold = Math.max(2, Math.ceil(totalPages * 0.4))
  let removedRunning = 0
  const isRunning = (p: PageText, l: TextLine): boolean => {
    const k = keyOf(p, l)
    if (!k) return false
    const norm = normalizeForRepeat(l.text)
    if (PAGE_NUMBER_LIKE.test(norm)) return true
    // Running headers are usually set small. Heading-sized text has to repeat on nearly every page to count as one:
    // the same section title in each chapter (numbers aside) is a heading, and losing a real heading is worse than
    // listing a stray line.
    const needed = l.size >= body * 1.12 ? Math.max(repeatThreshold, Math.ceil(totalPages * 0.75)) : repeatThreshold
    return totalPages >= 2 && (repeat.get(k)?.size ?? 0) >= needed
  }

  // ---- is right-to-left text stored in visual order (most producers) or in logical order? Vote by which reading makes known heading patterns match.
  let votesVisual = 0
  let votesLogical = 0
  for (const p of pages) {
    for (const l of p.lines) {
      if (!l.rtl) continue
      if (classify(visualToLogical(l.text))) votesVisual++
      if (classify(l.text)) votesLogical++
    }
  }
  const streamIsLogical = votesLogical > votesVisual
  let arabicMarks = 0
  let persianMarks = 0
  for (const p of pages) {
    for (const l of p.lines) {
      if (!l.rtl) continue
      const t = plainArabic(l.text)
      if (ARABIC_ONLY.test(t)) arabicMarks++
      if (PERSIAN_ONLY.test(t)) persianMarks++
    }
  }
  const foldArabic = arabicMarks > 0 && persianMarks === 0

  // ---- per-page working set
  const works: Work[] = []
  let columnPages = 0
  const bodyGaps: number[] = []
  for (const p of pages) {
    const cols = columnsOf(p, body)
    if (cols.boundaries.length) columnPages++
    const colOf = (l: TextLine): number => {
      const x = cols.rtl ? l.x1 : l.x0
      let c = 0
      for (const b of cols.boundaries) if (x > b) c++
      return cols.rtl ? cols.boundaries.length - c : c
    }
    const perCol = new Map<number, TextLine[]>()
    for (const l of p.lines) {
      const c = colOf(l)
      perCol.set(c, [...(perCol.get(c) ?? []), l])
    }
    for (const list of perCol.values()) {
      list.sort((a, b) => b.y1 - a.y1)
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]
        const b = list[i]
        if (Math.abs(a.size - body) <= body * 0.12 && Math.abs(b.size - body) <= body * 0.12) bodyGaps.push(a.y0 - b.y1)
      }
    }
    for (const l of p.lines) {
      if (isRunning(p, l)) {
        removedRunning++
        continue
      }
      const c = colOf(l)
      const list = perCol.get(c)!
      const idx = list.indexOf(l)
      const above = idx > 0 ? list[idx - 1] : undefined
      const below = idx < list.length - 1 ? list[idx + 1] : undefined
      const pageTop = p.box[3]
      const pageBottom = p.box[1]
      const tidy = (s: string): string => {
        const t = plainArabic(s.replace(/\s+/g, ' ').trim())
        return foldArabic && l.rtl ? foldToArabicLetters(t) : t
      }
      const logical = tidy(l.rtl && streamIsLogical ? l.text : l.logical)
      const variants = Array.from(new Set([logical, tidy(l.text), l.rtl ? tidy(visualToLogical(l.text)) : ''])).filter(Boolean)
      let pattern: Pattern | null = null
      let text = logical
      for (const v of variants) {
        const pat = classify(v)
        if (pat) {
          pattern = pat
          text = v
          break
        }
      }
      works.push({
        page: p,
        line: l,
        text,
        variants,
        pattern,
        ratio: l.size / body,
        column: c,
        fullWidth: cols.boundaries.length > 0 && l.x1 - l.x0 > cols.fullWidth * 0.6,
        gapAbove: above ? above.y0 - l.y1 : pageTop - l.y1 + 40,
        gapBelow: below ? l.y0 - below.y1 : l.y0 - pageBottom + 40,
        score: 0,
        reasons: [],
        cluster: -1
      })
    }
  }
  const bodyGap = Math.max(0.5, median(bodyGaps.filter((g) => g > -body && g < body * 2)))

  // ---- which lines can be headings
  const firstPageIndex = pages.length ? Math.min(...pages.map((p) => p.pageIndex)) : 0
  const firstPageLines = works.filter((w) => w.page.pageIndex === firstPageIndex).length
  const candidates: Work[] = []
  for (const w of works) {
    const l = w.line
    const text = w.text
    const words = wordCount(text)
    const letters = letterCount(text)
    if (letters < 1 || text.length < 2 || text.length > 160) continue
    if (BULLET.test(text) || CAPTION.test(asciiDigits(text))) continue
    if (l.size < body * 0.85) continue
    const isBigger = w.ratio >= 1.1
    const isBold = l.bold && w.ratio >= 0.95
    const caps = isAllCaps(text) && w.ratio >= 0.95
    const pat = w.pattern
    const maxWords = l.rtl ? 14 : 16
    if (words > maxWords) continue
    if (TOC_ENTRY.test(text)) continue
    if (pat && (pat.kind === 'number' || pat.kind === 'keyword') && /\s\d{1,4}$/.test(asciiDigits(text)) && !isBigger && !isBold) continue
    const endsSentence = SENTENCE_END.test(text)
    if (endsSentence && words > 6 && !(pat && pat.kind === 'number')) continue
    const isolated = w.gapAbove > bodyGap * 2.5 + 2 || w.gapBelow > bodyGap * 2.5 + 2

    let ok = false
    if (isBigger) ok = true
    else if (isBold && words <= 12) ok = true
    else if (pat && pat.kind !== 'letter' && (isBold || isBigger || caps || isolated) && pat.kind !== 'standalone') ok = true
    else if (pat && pat.kind === 'standalone' && (isBold || caps || isolated) && words <= 6) ok = true
    else if (caps && words <= 8 && isolated) ok = true
    else if (pat && pat.kind === 'letter' && isBold) ok = true
    if (!ok) continue
    // A digits-only or punctuation-only line is not a heading (page numbers that slipped past the band test).
    if (!/\p{L}/u.test(text)) continue

    // ---- score
    let s = 0.3
    const reasons: string[] = []
    if (w.ratio >= 1.4) {
      s += 0.3
      reasons.push(`Much larger than body text (${w.ratio.toFixed(1)}×)`)
    } else if (w.ratio >= 1.2) {
      s += 0.22
      reasons.push(`Larger than body text (${w.ratio.toFixed(1)}×)`)
    } else if (w.ratio >= 1.1) {
      s += 0.12
      reasons.push(`Slightly larger than body text (${w.ratio.toFixed(2)}×)`)
    }
    if (isBold) {
      s += 0.12
      reasons.push('Bold')
    }
    if (pat) {
      if (pat.kind === 'number') {
        s += 0.14
        reasons.push(`Numbered (${pat.label})`)
      } else if (pat.kind === 'keyword' || pat.kind === 'cjk') {
        s += 0.2
        reasons.push(`Starts with “${pat.label}”`)
      } else if (pat.kind === 'standalone') {
        s += 0.12
        reasons.push('Common section title')
      } else {
        s += 0.06
        reasons.push(`Lettered or numbered (${pat.label})`)
      }
    }
    if (caps) {
      s += 0.08
      reasons.push('ALL CAPS')
    }
    if (isolated) {
      s += 0.1
      reasons.push('Space around the line')
    }
    if (words <= 8) s += 0.04
    if (endsSentence) s -= 0.12
    if (words > 12) s -= 0.1
    if (/[,;]$/.test(text)) s -= 0.15
    if ((text.match(/\d/g) ?? []).length > letters) s -= 0.15
    if (!isBigger && !isBold && !(pat && pat.kind !== 'letter')) s -= 0.1
    // Text on a sparse first page (a cover) is rarely a heading unless it says so.
    if (w.page.pageIndex === firstPageIndex && firstPageLines <= 10 && !pat) {
      s -= 0.25
      reasons.push('On a cover-like first page')
    }
    w.score = s
    w.reasons = reasons
    candidates.push(w)
  }

  // ---- join wrapped headings
  const merged: Work[] = []
  const used = new Set<Work>()
  const byPage = new Map<number, Work[]>()
  for (const w of candidates) byPage.set(w.page.pageIndex, [...(byPage.get(w.page.pageIndex) ?? []), w])
  for (const list of byPage.values()) {
    list.sort((a, b) => a.column - b.column || b.line.y1 - a.line.y1)
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (used.has(a)) continue
      let head = a
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (used.has(b) || b.column !== head.column) continue
        const last = head.merged ? head.merged[head.merged.length - 1] : head
        const gap = last.line.y0 - b.line.y1
        const sameStyle = Math.abs(last.line.size - b.line.size) <= last.line.size * 0.04 && last.line.bold === b.line.bold
        if (sameStyle && gap >= -last.line.size * 0.3 && gap < last.line.size * 0.7 && !b.pattern && !SENTENCE_END.test(last.text) && !TOC_ENTRY.test(b.text)) {
          head = { ...head, merged: [...(head.merged ?? [head]), b] }
          used.add(b)
        } else if (b.line.y1 < last.line.y0 - last.line.size * 2) break
      }
      if (head.merged) {
        head.text = head.merged.map((m) => m.text).join(' ')
        head.reasons = [...head.reasons, `Wraps over ${head.merged.length} lines`]
      }
      merged.push(head)
    }
  }

  // ---- style clusters (largest first; bold ranks above regular text of the same size)
  const sizeOf = (w: Work): number => Math.round(w.line.size * 2) / 2
  const styles = Array.from(new Map(merged.map((w) => [`${sizeOf(w)}|${w.line.bold}`, { size: sizeOf(w), bold: w.line.bold }])).values()).sort((a, b) => b.size - a.size || Number(b.bold) - Number(a.bold))
  const clusters: { size: number; bold: boolean }[] = []
  for (const st of styles) {
    const last = clusters[clusters.length - 1]
    if (last && last.bold === st.bold && last.size - st.size < 0.75) continue // same cluster (sizes within 0.75pt)
    clusters.push(st)
  }
  const clusterOf = (w: Work): number => {
    let best = 0
    let bd = Infinity
    clusters.forEach((c, i) => {
      const d = Math.abs(c.size - sizeOf(w)) + (c.bold === w.line.bold ? 0 : 0.5)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }
  merged.forEach((w) => (w.cluster = clusterOf(w)))

  // A single much larger line on the first page: the document title, not a chapter.
  let titleWork: Work | undefined
  if (clusters.length >= 2) {
    const top = merged.filter((w) => w.cluster === 0)
    const second = merged.find((w) => w.cluster === 1)
    if (top.length === 1 && second && top[0].page.pageIndex === Math.min(...pages.map((p) => p.pageIndex)) && top[0].line.size >= second.line.size * 1.3 && merged.length >= 4) {
      titleWork = top[0]
    }
  }

  // ---- levels
  const partLikePresent = merged.some((w) => w.pattern?.partLike)
  const depthOf = (w: Work): number | undefined => {
    const p = w.pattern
    if (!p) return undefined
    if (p.kind === 'keyword') return p.partLike ? 1 : partLikePresent ? 2 : 1
    if (p.kind === 'number' || p.kind === 'cjk' || p.kind === 'roman') return p.depth
    return undefined
  }
  const usable = merged.filter((w) => w !== titleWork)
  const activeClusters = Array.from(new Set(usable.map((w) => w.cluster))).sort((a, b) => a - b)
  const clusterLevel = new Map<number, number>()
  let prevLevel = 0
  for (const c of activeClusters) {
    const depths = usable.filter((w) => w.cluster === c).map(depthOf).filter((d): d is number => d !== undefined)
    let lvl = depths.length >= Math.max(1, usable.filter((w) => w.cluster === c).length * 0.4) ? Math.round(median(depths)) : prevLevel + 1
    if (lvl < prevLevel) lvl = prevLevel
    if (lvl === prevLevel && depths.length === 0) lvl = prevLevel + 1
    clusterLevel.set(c, Math.min(lvl, maxLevels))
    prevLevel = lvl
  }
  const clusterSizes = new Map<number, number>()
  for (const c of activeClusters) clusterSizes.set(c, usable.filter((w) => w.cluster === c).length)

  // ---- confidence adjustments from repetition, then build candidates in reading order
  interface Entry {
    cand: HeadingCandidate
    col: number
    full: boolean
  }
  const entries: Entry[] = []
  for (const w of merged) {
    let sc = w.score
    const reasons = [...w.reasons]
    if (w === titleWork) {
      sc = Math.min(sc - 0.2, 0.45)
      reasons.push('Looks like the document title')
    } else if ((clusterSizes.get(w.cluster) ?? 0) >= 3) {
      sc += 0.1
      reasons.push(`One of ${clusterSizes.get(w.cluster)} headings in this style`)
    } else if ((clusterSizes.get(w.cluster) ?? 0) === 1 && activeClusters.length > 1 && !w.pattern) {
      sc -= 0.05
    }
    const confidence = Math.max(0, Math.min(1, sc))
    if (confidence < minConfidence) continue
    let level = w === titleWork ? 1 : (clusterLevel.get(w.cluster) ?? 1)
    const d = depthOf(w)
    if (w !== titleWork && d !== undefined && d > level) level = Math.min(d, maxLevels)
    const first = w.merged ? w.merged[0] : w
    entries.push({
      col: first.column,
      full: first.fullWidth,
      cand: {
        id: 0,
        pageIndex: w.page.pageIndex,
        text: w.text.replace(/\s+/g, ' ').trim(),
        level,
        confidence: Math.round(confidence * 100) / 100,
        reasons,
        size: Math.round(w.line.size * 10) / 10,
        bold: w.line.bold,
        rtl: w.line.rtl,
        x: first.line.x0,
        top: first.line.y1,
        numbering: w.pattern?.kind === 'number' || w.pattern?.kind === 'roman' ? w.pattern.label : undefined
      }
    })
  }

  // ---- reading order: pages in order; on a page, full-width headings split it into bands, columns inside a band
  const ordered: Entry[] = []
  const perPage = new Map<number, Entry[]>()
  for (const e of entries) perPage.set(e.cand.pageIndex, [...(perPage.get(e.cand.pageIndex) ?? []), e])
  for (const idx of [...perPage.keys()].sort((a, b) => a - b)) {
    const list = perPage.get(idx)!
    const fulls = list.filter((e) => e.full)
    const band = (e: Entry): number => fulls.filter((f) => f !== e && f.cand.top > e.cand.top).length
    list.sort((a, b) => band(a) - band(b) || (a.full ? -1 : a.col) - (b.full ? -1 : b.col) || b.cand.top - a.cand.top)
    ordered.push(...list)
  }

  // ---- make levels well-formed: start at 1, never jump down by more than one level, at most `maxLevels`
  let prev = 0
  const result = ordered.map((e, i) => {
    const level = Math.max(1, Math.min(e.cand.level, prev + 1, maxLevels))
    prev = level
    return { ...e.cand, level, id: i }
  })

  return {
    candidates: result,
    stats: {
      bodySize: body,
      pages: totalPages,
      lines: totalLines,
      headingSizes: clusters.map((c) => c.size),
      removedRunning,
      columnPages
    }
  }
}

// ---------------------------------------------------------------- tree

export interface HeadingTreeNode {
  candidate: HeadingCandidate
  children: HeadingTreeNode[]
}

/** Nests a flat, ordered list by level (a level never jumps by more than one below its predecessor). */
export function nestHeadings(list: readonly HeadingCandidate[]): HeadingTreeNode[] {
  const roots: HeadingTreeNode[] = []
  const stack: { level: number; node: HeadingTreeNode }[] = []
  for (const c of list) {
    const node: HeadingTreeNode = { candidate: c, children: [] }
    while (stack.length && stack[stack.length - 1].level >= c.level) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ level: c.level, node })
  }
  return roots
}

export { rtlRatio }
