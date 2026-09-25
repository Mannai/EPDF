import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib'

/**
 * Page labels ("i, ii, iii, 1, 2, A-1"...) live in a number tree keyed by page index, so they do not travel
 * with pages when pages are moved. We expand them to one label per page, permute those with the pages, and
 * compress them back into ranges.
 */

export type LabelStyle = 'D' | 'R' | 'r' | 'A' | 'a'

export interface PageLabel {
  /** Numbering style, or null for a label that is only a prefix (or empty). */
  style: LabelStyle | null
  prefix: string
  /** The number shown (meaningless when `style` is null). */
  value: number
}

/** A page with no label at all: shows nothing. Used for pages inserted from elsewhere. */
export const EMPTY_LABEL: PageLabel = { style: null, prefix: '', value: 0 }

const N = (s: string): PDFName => PDFName.of(s)
const STYLES = new Set(['D', 'R', 'r', 'A', 'a'])

/** Collects [key, value] pairs of a number tree, sorted by key. */
function readNumberTree(pdf: PDFDocument, root: PDFObject | undefined): [number, PDFObject][] {
  const out: [number, PDFObject][] = []
  const seen = new Set<PDFObject>()
  const walk = (o: PDFObject | undefined, depth: number): void => {
    const node = o instanceof PDFRef ? pdf.context.lookup(o) : o
    if (!(node instanceof PDFDict) || seen.has(node) || depth > 32 || out.length > 200_000) return
    seen.add(node)
    const nums = node.lookupMaybe(N('Nums'), PDFArray)
    if (nums) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const k = nums.lookupMaybe(i, PDFNumber)
        if (k) out.push([k.asNumber(), nums.get(i + 1)])
      }
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1)
  }
  walk(root, 0)
  return out.sort((a, b) => a[0] - b[0])
}

/** One label per page, or null if the document has no (usable) /PageLabels. */
export function readPageLabels(pdf: PDFDocument): PageLabel[] | null {
  const tree = pdf.catalog.get(N('PageLabels'))
  if (!tree) return null
  const entries = readNumberTree(pdf, tree)
  if (entries.length === 0) return null
  const n = pdf.getPageCount()
  const labels: PageLabel[] = []
  let e = -1
  for (let i = 0; i < n; i++) {
    while (e + 1 < entries.length && entries[e + 1][0] <= i) e++
    if (e < 0) {
      labels.push({ style: 'D', prefix: '', value: i + 1 }) // before the first range: plain decimal
      continue
    }
    const [key, obj] = entries[e]
    const dict = obj instanceof PDFRef ? pdf.context.lookup(obj) : obj
    const d = dict instanceof PDFDict ? dict : undefined
    const s = d?.lookupMaybe(N('S'), PDFName)?.decodeText()
    const style = s && STYLES.has(s) ? (s as LabelStyle) : null
    const p = d?.lookup(N('P'))
    const prefix = p && 'decodeText' in p ? (p as unknown as { decodeText(): string }).decodeText() : ''
    const start = d?.lookupMaybe(N('St'), PDFNumber)?.asNumber() ?? 1
    labels.push({ style, prefix, value: start + (i - key) })
  }
  return labels
}

const isDefault = (labels: PageLabel[]): boolean => labels.every((l, i) => l.style === 'D' && l.prefix === '' && l.value === i + 1)

/** Writes one label per page back as compact ranges (removes /PageLabels if they are just 1, 2, 3...). */
export function writePageLabels(pdf: PDFDocument, labels: PageLabel[]): void {
  if (labels.length === 0 || isDefault(labels)) {
    pdf.catalog.delete(N('PageLabels'))
    return
  }
  const ctx = pdf.context
  const nums: PDFObject[] = []
  labels.forEach((l, i) => {
    const prev = labels[i - 1]
    const continues = prev && prev.style === l.style && prev.prefix === l.prefix && (l.style === null || l.value === prev.value + 1)
    if (continues) return
    const dict = ctx.obj({}) as PDFDict
    if (l.style) dict.set(N('S'), N(l.style))
    if (l.prefix) dict.set(N('P'), PDFHexString.fromText(l.prefix))
    if (l.style && l.value !== 1) dict.set(N('St'), PDFNumber.of(l.value))
    nums.push(PDFNumber.of(i), dict)
  })
  pdf.catalog.set(N('PageLabels'), ctx.obj({ Nums: nums }))
}

/** Roman / letter formatting, used for the organizer's page captions and tests. */
export function formatLabel(l: PageLabel): string {
  const num = (): string => {
    switch (l.style) {
      case 'D':
        return String(l.value)
      case 'R':
        return roman(l.value).toUpperCase()
      case 'r':
        return roman(l.value)
      case 'A':
        return letters(l.value).toUpperCase()
      case 'a':
        return letters(l.value)
      default:
        return ''
    }
  }
  return l.prefix + num()
}

function roman(v: number): string {
  if (v <= 0) return ''
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [n, s] of table) while (v >= n) ((out += s), (v -= n))
  return out
}

function letters(v: number): string {
  if (v <= 0) return ''
  // PDF: 1..26 = a..z, 27..52 = aa..zz, 53.. = aaa..
  const letter = String.fromCharCode(97 + ((v - 1) % 26))
  return letter.repeat(Math.floor((v - 1) / 26) + 1)
}
