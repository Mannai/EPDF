/**
 * Shared types of the pure comparison engine. Nothing under `diff/` may import pdfjs-dist, React or the DOM:
 * it has to run in Node (unit tests) and inside a Web Worker.
 *
 * Coordinates are PDF points with the origin at the TOP-LEFT of the page as displayed (page /Rotate applied), y down.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One text run from PDF.js, already converted to displayed page coordinates (axis-aligned bounds). */
export interface RawItem {
  str: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** Font size in points (used for gap thresholds). */
  size: number
  /** Direction the text runs on the displayed page: 0 left to right (default), 1 upwards, 2 right to left, 3 downwards. */
  dir?: 0 | 1 | 2 | 3
}

export interface CompareOptions {
  /** "Hello" equals "hello". */
  ignoreCase: boolean
  /** Punctuation is not compared at all ("end." equals "end"). */
  ignorePunctuation: boolean
  /** Spacing and line breaks are irrelevant ("Hello world" equals "Helloworld"). Compared character by character. */
  ignoreWhitespace: boolean
}

export const DEFAULT_OPTIONS: CompareOptions = { ignoreCase: false, ignorePunctuation: false, ignoreWhitespace: false }

/**
 * A page's words in reading order, stored compactly (typed arrays) so a 500-page document stays small.
 * `text` is what the page shows, `keys` what is compared.
 */
export interface PageModel {
  width: number
  height: number
  text: string[]
  keys: string[]
  /** x, y, w, h of each word's first rectangle (4 numbers per word). */
  box: Float32Array
  /** Further rectangles of words that wrap over lines (hyphenation): (wordIndex, x, y, w, h) tuples. */
  extra: Float32Array
  /** Paragraph/block id of each word (reading-order blocks; constant inside one paragraph). */
  block: Int32Array
  /** Line id of each word. */
  line: Int32Array
}

export type ChangeKind = 'added' | 'removed' | 'modified' | 'moved'

/** A place in one document: a page and the word ranges [from, to) changed there. */
export interface Loc {
  /** Index into `CompareResult.pairs` of the row this location is shown in. */
  pair: number
  /** 1-based page number. */
  page: number
  /** Word index ranges that actually differ (highlighted). */
  parts: [number, number][]
  /** First and last (exclusive) word of the whole change including small unchanged gaps. */
  span: [number, number]
}

export interface Change {
  /** Position in the sorted change list (0-based); stable for one comparison. */
  id: number
  kind: ChangeKind
  /** Index into `CompareResult.pairs`. */
  pair: number
  old?: Loc
  new?: Loc
  /** A moved block that also differs slightly. */
  edited?: boolean
}

export interface PagePair {
  /** 1-based page numbers, or null when the page exists on one side only. */
  old: number | null
  new: number | null
  /** Text similarity of the two pages in [0, 1]. */
  similarity: number
  /** The page sits somewhere else in the other document (reordered). */
  moved: boolean
  /** Number of changes located on this pair. */
  changes: number
}

export interface CompareCounts {
  added: number
  removed: number
  modified: number
  moved: number
  total: number
}

export interface CompareResult {
  pairs: PagePair[]
  changes: Change[]
  counts: CompareCounts
  /** Number of page pairs with at least one change (or an unpaired page). */
  changedPairs: number
}

/** What the diff engine needs to know about a page. */
export interface PageInput {
  keys: string[]
  /** Optional block ids (same length as keys). */
  block?: ArrayLike<number>
}
