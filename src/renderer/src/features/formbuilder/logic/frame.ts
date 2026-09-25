/**
 * The page as the reader sees it. PDF content lives in unrotated user space (origin bottom-left of the crop
 * box); the reader sees it after the page's /Rotate. Detection reasons about labels being "left of" or
 * "above" a line in the VISUAL frame (origin bottom-left of the displayed page, y up), and converts results
 * back to user space, where form widgets are stored. Pure TypeScript.
 */

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type Rotation = 0 | 90 | 180 | 270

export const normRotation = (deg: number): Rotation => ((((Math.round((deg || 0) / 90) * 90) % 360) + 360) % 360) as Rotation

/** The frame of a pdf-lib page (its crop box and /Rotate). */
export function frameForPage(page: { getCropBox(): { x: number; y: number; width: number; height: number }; getRotation(): { angle: number } }): PageFrame {
  const cb = page.getCropBox()
  return new PageFrame([cb.x, cb.y, cb.x + cb.width, cb.y + cb.height], normRotation(page.getRotation().angle))
}

export class PageFrame {
  readonly width: number
  readonly height: number

  /** `crop` = [x0, y0, x1, y1] of the visible page in user space. */
  constructor(
    readonly crop: readonly [number, number, number, number],
    readonly rotation: Rotation
  ) {
    const w = crop[2] - crop[0]
    const h = crop[3] - crop[1]
    this.width = rotation === 90 || rotation === 270 ? h : w
    this.height = rotation === 90 || rotation === 270 ? w : h
  }

  private get uw(): number {
    return this.crop[2] - this.crop[0]
  }
  private get uh(): number {
    return this.crop[3] - this.crop[1]
  }

  toVisual(x: number, y: number): [number, number] {
    const dx = x - this.crop[0]
    const dy = y - this.crop[1]
    switch (this.rotation) {
      case 90:
        return [dy, this.uw - dx]
      case 180:
        return [this.uw - dx, this.uh - dy]
      case 270:
        return [this.uh - dy, dx]
      default:
        return [dx, dy]
    }
  }

  toUser(vx: number, vy: number): [number, number] {
    switch (this.rotation) {
      case 90:
        return [this.crop[0] + this.uw - vy, this.crop[1] + vx]
      case 180:
        return [this.crop[0] + this.uw - vx, this.crop[1] + this.uh - vy]
      case 270:
        return [this.crop[0] + vy, this.crop[1] + this.uh - vx]
      default:
        return [this.crop[0] + vx, this.crop[1] + vy]
    }
  }

  /** A user-space vector (dx, dy) as it appears on screen. */
  dirToVisual(dx: number, dy: number): [number, number] {
    switch (this.rotation) {
      case 90:
        return [dy, -dx]
      case 180:
        return [-dx, -dy]
      case 270:
        return [-dy, dx]
      default:
        return [dx, dy]
    }
  }

  boxToVisual(b: Box): Box {
    const p = this.toVisual(b.x0, b.y0)
    const q = this.toVisual(b.x1, b.y1)
    return { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) }
  }

  boxToUser(b: Box): Box {
    const p = this.toUser(b.x0, b.y0)
    const q = this.toUser(b.x1, b.y1)
    return { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) }
  }
}
