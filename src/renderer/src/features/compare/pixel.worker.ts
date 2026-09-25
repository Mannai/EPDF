import { diffPixels, diffRegions, type Region } from './diff/pixel'

/** Web Worker that compares two rendered pages pixel by pixel, so the UI stays responsive. */

export interface PixelRequest {
  id: number
  a: Uint8ClampedArray
  b: Uint8ClampedArray
  w: number
  h: number
  sensitivity: number
  /** Also return the per-pixel mask and the grouped regions (for the overlay); the bulk scan only needs the count. */
  wantMask: boolean
}

export interface PixelResponse {
  id: number
  count: number
  total: number
  ratio: number
  mask?: Uint8Array
  regions?: Region[]
  error?: string
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<PixelRequest>) => void) | null; postMessage(m: PixelResponse, transfer?: Transferable[]): void }

scope.onmessage = (e) => {
  const r = e.data
  try {
    const d = diffPixels(r.a, r.b, r.w, r.h, r.sensitivity)
    if (r.wantMask) {
      scope.postMessage({ id: r.id, count: d.count, total: d.total, ratio: d.ratio, mask: d.mask, regions: diffRegions(d.mask, r.w, r.h) }, [d.mask.buffer])
    } else scope.postMessage({ id: r.id, count: d.count, total: d.total, ratio: d.ratio })
  } catch (err) {
    scope.postMessage({ id: r.id, count: 0, total: 0, ratio: 0, error: err instanceof Error ? err.message : String(err) })
  }
}
