import { estimateSkew } from './deskew'
import { enhance, type ScanPreset } from './enhance'
import { quadSize, rotateQuadQuarterTurns, scaleQuad, warpPerspective, type Quad } from './geometry'
import { fitLongSide, rotateDegrees, rotateQuarterTurns, type RgbaImage } from './image'

/** The per-page cleanup pipeline: rotate -> crop + perspective -> deskew -> enhance, with the output page size. */

export type PaperChoice = 'auto' | 'a4' | 'letter' | 'none'

export const A4_PT = { width: 595.276, height: 841.89 }
export const LETTER_PT = { width: 612, height: 792 }

export interface ProcessOptions {
  /** Corners TL/TR/BR/BL normalised to the *rotated* source; null means the whole image. */
  quad: Quad | null
  /** Quarter turns clockwise applied to the source before anything else (0..3). */
  rotation?: number
  preset: ScanPreset
  straighten: boolean
  /** Camera sources: snap the rectified page to a standard sheet when its shape is close. */
  paper: PaperChoice
  /** Resolution the source was scanned at, if known (scanners). Fixes the page size directly. */
  sourceDpi?: number
  /** Upper bound for the long side of the output in pixels. */
  maxLongSide?: number
  bwBias?: number
}

export interface ProcessedPage {
  image: RgbaImage
  pageWidthPt: number
  pageHeightPt: number
  /** Pixels per inch of the output at the chosen page size. */
  dpi: number
  skewDegrees: number
  cropped: boolean
}

const NEAR_FULL = 0.004

export const isFullQuad = (q: Quad | null): boolean =>
  !q || (Math.abs(q[0].x) < NEAR_FULL && Math.abs(q[0].y) < NEAR_FULL && Math.abs(q[2].x - 1) < NEAR_FULL && Math.abs(q[2].y - 1) < NEAR_FULL && Math.abs(q[1].x - 1) < NEAR_FULL && Math.abs(q[3].y - 1) < NEAR_FULL && Math.abs(q[1].y) < NEAR_FULL && Math.abs(q[3].x) < NEAR_FULL)

export interface OutputPlan {
  widthPx: number
  heightPx: number
  pageWidthPt: number
  pageHeightPt: number
  dpi: number
}

/** Decides the pixel size and PDF page size of the rectified page from the measured quad size (source pixels). */
export function planOutput(measured: { width: number; height: number }, o: { sourceDpi?: number; paper: PaperChoice; maxLongSide: number }): OutputPlan {
  const long = Math.max(measured.width, measured.height)
  const short = Math.min(measured.width, measured.height)
  const landscape = measured.width > measured.height
  if (o.sourceDpi) {
    const f = Math.min(1, o.maxLongSide / long)
    const widthPx = Math.max(1, Math.round(measured.width * f))
    const heightPx = Math.max(1, Math.round(measured.height * f))
    const dpi = o.sourceDpi * f
    return { widthPx, heightPx, pageWidthPt: (widthPx / dpi) * 72, pageHeightPt: (heightPx / dpi) * 72, dpi }
  }
  const ratio = long / Math.max(1, short)
  const candidates: { key: PaperChoice; w: number; h: number }[] = []
  if (o.paper === 'auto' || o.paper === 'a4') candidates.push({ key: 'a4', w: A4_PT.width, h: A4_PT.height })
  if (o.paper === 'auto' || o.paper === 'letter') candidates.push({ key: 'letter', w: LETTER_PT.width, h: LETTER_PT.height })
  let chosen: { w: number; h: number } | null = null
  let bestOff = Infinity
  for (const c of candidates) {
    const off = Math.abs(c.h / c.w / ratio - 1)
    if (off < bestOff) {
      bestOff = off
      chosen = c
    }
  }
  const forced = o.paper === 'a4' || o.paper === 'letter'
  if (chosen && (forced || bestOff <= 0.08)) {
    const longPx = Math.round(Math.min(Math.max(long, 800), o.maxLongSide))
    const shortPx = Math.round(longPx / (chosen.h / chosen.w))
    const widthPx = landscape ? longPx : shortPx
    const heightPx = landscape ? shortPx : longPx
    const pageWidthPt = landscape ? chosen.h : chosen.w
    const pageHeightPt = landscape ? chosen.w : chosen.h
    return { widthPx, heightPx, pageWidthPt, pageHeightPt, dpi: longPx / (Math.max(pageWidthPt, pageHeightPt) / 72) }
  }
  // Unknown shape: keep the pixels, scale so the long side is A4 long.
  const f = Math.min(1, o.maxLongSide / long)
  const widthPx = Math.max(1, Math.round(measured.width * f))
  const heightPx = Math.max(1, Math.round(measured.height * f))
  const ptPerPx = A4_PT.height / Math.max(widthPx, heightPx)
  return { widthPx, heightPx, pageWidthPt: widthPx * ptPerPx, pageHeightPt: heightPx * ptPerPx, dpi: 72 / ptPerPx }
}

export function processPage(sourceIn: RgbaImage, o: ProcessOptions): ProcessedPage {
  const src = o.rotation ? rotateQuarterTurns(sourceIn, o.rotation) : sourceIn
  const maxLong = o.maxLongSide ?? 3508
  const full = isFullQuad(o.quad)
  let rect: RgbaImage
  let plan: OutputPlan
  if (full) {
    // Without a crop there is no page shape to snap to: keep the picture's own proportions.
    plan = planOutput({ width: src.width, height: src.height }, { sourceDpi: o.sourceDpi, paper: 'none', maxLongSide: maxLong })
    rect = plan.widthPx === src.width && plan.heightPx === src.height ? src : fitLongSide(src, Math.max(plan.widthPx, plan.heightPx))
  } else {
    const qpx = scaleQuad(o.quad!, src.width, src.height)
    plan = planOutput(quadSize(qpx), { sourceDpi: o.sourceDpi, paper: o.paper, maxLongSide: maxLong })
    const warped = warpPerspective(src, qpx, plan.widthPx, plan.heightPx)
    if (!warped) throw new Error('The page corners do not form a valid shape. Drag the corners to the corners of the page.')
    rect = warped
    // camera sources: the paper aspect may have been snapped, so plan already holds the output size
  }
  let skew = 0
  if (o.straighten) {
    const s = estimateSkew(rect)
    if (s.confidence >= 1.5 && Math.abs(s.degrees) >= 0.3 && Math.abs(s.degrees) <= 15) {
      skew = s.degrees
      rect = rotateDegrees(rect, -s.degrees)
    }
  }
  const image = enhance(rect, o.preset, { bwBias: o.bwBias })
  return { image, pageWidthPt: plan.pageWidthPt, pageHeightPt: plan.pageHeightPt, dpi: plan.dpi, skewDegrees: skew, cropped: !full }
}

/** Re-exported for the editor: the quad after the source is rotated by whole quarter turns. */
export { rotateQuadQuarterTurns }
