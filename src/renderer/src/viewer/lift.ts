import { AnnotationMode, type PageViewport } from 'pdfjs-dist'
import { getLoaded } from '../pdf/docCache'

/**
 * "Lifting" something off a rendered page so it can be dragged smoothly. Every edit is saved and the page redrawn,
 * which takes a moment; without this only an outline moved and the real thing jumped once the page caught up.
 *
 *   - `image`: the thing itself, cut from the page canvas. For annotations (`mode: 'annotation'`) only its own pixels
 *     are kept (the page is re-rendered without annotations and compared), so a hollow shape doesn't carry the text
 *     behind it. For page content (`'content'`, e.g. an image) the whole box is taken.
 *   - `eraser` (annotations only): the page without annotations for the same box, to cover the original spot while it
 *     is being moved and until the redrawn page arrives.
 *
 * Rects are CSS px within the page. Returns null if the page isn't drawn yet or the box is empty.
 */
export interface Lifted {
  /** The box that was lifted (CSS px), padded a little so strokes and anti-aliasing are included. */
  box: [number, number, number, number]
  image: HTMLCanvasElement
  eraser: HTMLCanvasElement | null
}

const PAD = 3

export async function liftRegion(o: {
  pageEl: HTMLElement
  docId: string
  pageIndex: number
  viewport: PageViewport
  rect: [number, number, number, number]
  mode: 'annotation' | 'content'
}): Promise<Lifted | null> {
  const src = o.pageEl.querySelector<HTMLCanvasElement>(':scope > div > canvas')
  if (!src || src.width === 0) return null
  const cssW = o.viewport.width
  const cssH = o.viewport.height
  const k = src.width / cssW // device px per CSS px, as the page was drawn
  const l = Math.max(0, Math.min(o.rect[0], o.rect[2]) - PAD)
  const t = Math.max(0, Math.min(o.rect[1], o.rect[3]) - PAD)
  const r = Math.min(cssW, Math.max(o.rect[0], o.rect[2]) + PAD)
  const b = Math.min(cssH, Math.max(o.rect[1], o.rect[3]) + PAD)
  const sx = Math.floor(l * k)
  const sy = Math.floor(t * k)
  const sw = Math.max(1, Math.ceil(r * k) - sx)
  const sh = Math.max(1, Math.ceil(b * k) - sy)
  if (r - l < 1 || b - t < 1) return null
  const box: [number, number, number, number] = [sx / k, sy / k, (sx + sw) / k, (sy + sh) / k]

  const image = document.createElement('canvas')
  image.width = sw
  image.height = sh
  const ictx = image.getContext('2d', { willReadFrequently: o.mode === 'annotation' })
  if (!ictx) return null
  ictx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh)
  if (o.mode === 'content') return { box, image, eraser: null }

  const loaded = getLoaded(o.docId)
  if (!loaded) return null
  const page = await loaded.doc.getPage(o.pageIndex + 1)
  const eraser = document.createElement('canvas')
  eraser.width = sw
  eraser.height = sh
  const ectx = eraser.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!ectx) return null
  // The same drawing as the page, shifted so this box lands at the canvas origin, without any annotations.
  const vp = page.getViewport({ scale: o.viewport.scale * k, rotation: o.viewport.rotation, offsetX: -sx, offsetY: -sy })
  await page.render({ canvasContext: ectx, canvas: eraser, viewport: vp, annotationMode: AnnotationMode.DISABLE, background: 'rgb(255,255,255)' }).promise

  // Keep only the pixels the annotation changed.
  const a = ictx.getImageData(0, 0, sw, sh)
  const e = ectx.getImageData(0, 0, sw, sh).data
  const d = a.data
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(d[i] - e[i]) + Math.abs(d[i + 1] - e[i + 1]) + Math.abs(d[i + 2] - e[i + 2])
    if (diff < 12) d[i + 3] = 0
  }
  ictx.putImageData(a, 0, 0)
  return { box, image, eraser }
}

/** Where a lifted box goes when its item's rect moves from `from` to `to` (both CSS px): the same padding, scaled. */
export function liftedBoxAt(lifted: Lifted, from: [number, number, number, number], to: [number, number, number, number]): [number, number, number, number] {
  const fw = Math.max(1, from[2] - from[0])
  const fh = Math.max(1, from[3] - from[1])
  const sx = (to[2] - to[0]) / fw
  const sy = (to[3] - to[1]) / fh
  const [bl, bt, br, bb] = lifted.box
  return [to[0] + (bl - from[0]) * sx, to[1] + (bt - from[1]) * sy, to[2] + (br - from[2]) * sx, to[3] + (bb - from[3]) * sy]
}
