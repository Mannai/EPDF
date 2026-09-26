import type { DestTail, ItemTarget } from '@shared/features/destinations'
import type { Quad } from '../../markup/pdf/quads'
import type { Rect } from '../../markup/pdf/geometry'

export type { Quad, Rect }

/** Border look of a link. Width 0 means no border at all (the usual "invisible link"). */
export interface LinkBorder {
  width: number
  dashed: boolean
  /** RGB 0..1; null = the reader's default (black). */
  color: [number, number, number] | null
}

export const INVISIBLE_BORDER: LinkBorder = { width: 0, dashed: false, color: null }
export const THIN_BORDER = (color: [number, number, number] | null = [0, 0.32, 0.8]): LinkBorder => ({ width: 1, dashed: false, color })

export interface LinkInfo {
  /** "<obj> <gen>" of the annotation (same scheme as the annotation list of the markup feature). */
  id: string
  pageIndex: number
  /** /Rect normalised to x0<=x1, y0<=y1, PDF user space. */
  rect: Rect
  /** /QuadPoints, when the link covers several text lines. */
  quads: Quad[]
  target: ItemTarget
  border: LinkBorder
  flags: number
  contents: string
  /** Created by Epdf (its border appearance is ours to regenerate). */
  ours: boolean
}

/** What the user can choose as a link target. */
export type LinkTargetInput =
  | { kind: 'uri'; uri: string }
  | { kind: 'page'; pageIndex: number; tail: DestTail }
  | { kind: 'named'; name: string }

export function describeTarget(t: ItemTarget): string {
  switch (t.kind) {
    case 'uri':
      return t.uri
    case 'page':
      return t.named ? `Named destination “${t.named}” (page ${t.dest.pageIndex + 1})` : `Page ${t.dest.pageIndex + 1}`
    case 'dead':
      return t.named ? `Missing destination “${t.named}”` : 'A page that no longer exists'
    case 'other':
      return t.detail ? `${t.action}: ${t.detail}` : t.action
    default:
      return 'No target'
  }
}
