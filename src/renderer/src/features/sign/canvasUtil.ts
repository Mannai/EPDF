import { MAX_SIGNATURE_BYTES } from '@shared/features/sign'
import { fitWithin, trimTransparent, type Pixels } from './imageProcessing'

export interface SignatureImage {
  /** PNG with an alpha channel. */
  png: Uint8Array
  width: number
  height: number
}

/** Longest side of a stored signature. Big enough to print sharply at signature size, small enough to store. */
export const MAX_SIGNATURE_SIDE = 900

export function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) return reject(new Error('The image could not be encoded.'))
      blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
    }, 'image/png')
  })
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(width))
  c.height = Math.max(1, Math.round(height))
  return c
}

export function pixelsOf(c: HTMLCanvasElement): Pixels {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height)
  return { data: d.data, width: d.width, height: d.height }
}

export function canvasOfPixels(p: Pixels): HTMLCanvasElement {
  const c = makeCanvas(p.width, p.height)
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0)
  return c
}

/**
 * Turns a canvas with a signature on a transparent background into the image we store: trims the empty
 * margin, scales it down to a sensible size and encodes a PNG under the size limit. Null if it is empty.
 */
export async function finalizeSignature(source: HTMLCanvasElement): Promise<SignatureImage | null> {
  const trimmed = trimTransparent(pixelsOf(source), 4)
  if (!trimmed) return null
  let canvas = canvasOfPixels(trimmed)
  let side = MAX_SIGNATURE_SIDE
  for (let attempt = 0; attempt < 5; attempt++) {
    const { width, height } = fitWithin(canvas.width, canvas.height, side)
    if (width !== canvas.width || height !== canvas.height) {
      const scaled = makeCanvas(width, height)
      const ctx = scaled.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(canvas, 0, 0, width, height)
      canvas = scaled
    }
    const png = await canvasToPng(canvas)
    if (png.length <= MAX_SIGNATURE_BYTES) return { png, width: canvas.width, height: canvas.height }
    side = Math.round(side * 0.7)
  }
  throw new Error('This image is too detailed to store as a signature. Try a smaller or simpler image.')
}
