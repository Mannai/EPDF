import type { Rect } from './geometry'

/** What the UI knows about one annotation, read from the PDF's annotation dictionaries. */

export type ReviewState = 'None' | 'Accepted' | 'Rejected' | 'Cancelled' | 'Completed'

/** Subtypes listed in the Comments panel and selectable. Everything else (Link, Widget, Popup, Redact, …) is left alone. */
export const LISTED_SUBTYPES = [
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'FileAttachment'
] as const

export const isListedSubtype = (s: string): boolean => (LISTED_SUBTYPES as readonly string[]).includes(s)

export const SUBTYPE_LABEL: Record<string, string> = {
  Text: 'Note',
  FreeText: 'Text box',
  Line: 'Line',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  Highlight: 'Highlight',
  Underline: 'Underline',
  Squiggly: 'Squiggly underline',
  StrikeOut: 'Strikethrough',
  Stamp: 'Stamp',
  Caret: 'Insert mark',
  Ink: 'Drawing',
  FileAttachment: 'Attachment'
}

export const subtypeLabel = (s: string): string => SUBTYPE_LABEL[s] ?? s

const FILL_MARK_LABEL: Record<string, string> = { EpdfCheck: 'Check mark', EpdfCross: 'Cross', EpdfDot: 'Dot' }

/** What the user calls it: "Signature", "Text", "Check mark" for Fill & sign items, else the annotation type. */
export function describeAnnot(a: Pick<AnnotInfo, 'subtype' | 'iconName'> & Partial<Pick<AnnotInfo, 'fillSign'>>): string {
  if (a.fillSign === 'Signature') return 'Signature'
  if (a.fillSign === 'Text') return 'Text'
  if (a.fillSign === 'Mark') return FILL_MARK_LABEL[a.iconName] ?? 'Mark'
  return subtypeLabel(a.subtype)
}

export interface AnnotInfo {
  /** Stable within one document version: "<obj> <gen>" for indirect annotations, "p<page>.<index>" for direct ones. */
  id: string
  pageIndex: number
  /** Position in the page's /Annots array (later = drawn on top). */
  order: number
  subtype: string
  rect: Rect
  contents: string
  author: string
  subject: string
  /** Epoch ms, or null when absent/unparseable. */
  modified: number | null
  created: number | null
  /** /NM */
  name: string
  /** Stroke/markup colour (/C); for FreeText the text colour from /DA. */
  color: number[] | null
  /** Fill colour: /IC for shapes, /C for FreeText. */
  fill: number[] | null
  opacity: number
  flags: number
  quads: number[][]
  /** InkList strokes, each a flat [x, y, x, y, …]. */
  ink: number[][]
  /** /L for Line annotations. */
  line: number[] | null
  lineEnds: [string, string]
  borderWidth: number
  dashed: boolean
  fontSize: number
  /** Stamp /Name or Text-annotation icon /Name. */
  iconName: string
  /** id of the annotation this replies to (/IRT), or null. */
  irt: string | null
  replyType: 'R' | 'Group'
  state: string | null
  stateModel: string | null
  hasAppearance: boolean
  /** Has features we cannot redraw (cloud border, exotic line endings): its appearance is never regenerated. */
  complex: boolean
  /** Created by Epdf (its /NM starts with "epdf-"): we may safely regenerate/replace its appearance. */
  ours: boolean
  /** A Fill & sign item (/EpdfFill): a mark, typed text or a signature, not a comment. */
  fillSign: 'Mark' | 'Text' | 'Signature' | null
}

export interface Capabilities {
  move: boolean
  resize: boolean
  recolor: boolean
  fill: boolean
  opacity: boolean
  width: boolean
  text: boolean
}

/** What can be changed on an annotation without destroying it (see ops.ts for how each edit is applied). */
export function capabilities(a: Pick<AnnotInfo, 'subtype' | 'complex' | 'ours'> & Partial<Pick<AnnotInfo, 'fillSign'>>): Capabilities {
  const regen = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'FreeText', 'Text'].includes(a.subtype) && !a.complex
  const stamp = a.subtype === 'Stamp' && a.ours
  // A Fill & sign check / cross / dot is drawn from /C, so it can be recoloured.
  const mark = stamp && a.fillSign === 'Mark'
  return {
    move: true,
    resize: ['FreeText', 'Square', 'Circle', 'Ink'].includes(a.subtype) || a.subtype === 'Stamp',
    recolor: regen || mark,
    fill: ['Square', 'Circle', 'FreeText'].includes(a.subtype) && regen,
    opacity: regen || stamp,
    width: ['Ink', 'Square', 'Circle', 'Line', 'FreeText'].includes(a.subtype) && regen,
    text: true
  }
}

export const isTextMarkup = (subtype: string): boolean => ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(subtype)

/** Hidden (2) or NoView (32) annotations are not drawn and cannot be clicked on the page. */
export const isVisible = (a: Pick<AnnotInfo, 'flags'>): boolean => (a.flags & (2 | 32)) === 0
