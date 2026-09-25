/// <reference lib="webworker" />
import { assemblePdf, encodeBilevel, type EncodedPage } from '@shared/features/scan/assemble'
import { detectPage } from '@shared/features/scan/detect'
import { fitLongSide, rotateQuarterTurns, type RgbaImage } from '@shared/features/scan/image'
import { processPage } from '@shared/features/scan/pipeline'
import type { Op, WorkerCall, WorkerReply, WorkerRequests, WorkerResponses } from './protocol'

/**
 * Worker half of the scan page editor: decoding, page detection, perspective correction, deskew, enhancement, JPEG /
 * 1-bit encoding and PDF assembly. Nothing here touches the DOM, so it runs off the UI thread.
 */

interface Cached {
  preview: RgbaImage
  width: number
  height: number
}

const PREVIEW_LONG = 1400
const CACHE_LIMIT = 40
const cache = new Map<string, Cached>()

function remember(id: string, c: Cached): void {
  cache.delete(id)
  cache.set(id, c)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

function rgbaFromBitmap(bm: ImageBitmap, maxLong?: number): RgbaImage {
  const f = maxLong ? Math.min(1, maxLong / Math.max(bm.width, bm.height)) : 1
  const w = Math.max(1, Math.round(bm.width * f))
  const h = Math.max(1, Math.round(bm.height * f))
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, w, h)
  g.drawImage(bm, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h)
  return { width: w, height: h, data: d.data }
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob)
  } catch {
    throw new Error('This picture could not be read. It may be damaged or in a format Epdf cannot show.')
  }
}

const toBitmap = (img: RgbaImage): Promise<ImageBitmap> => createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height))

const need = (id: string): Cached => {
  const c = cache.get(id)
  if (!c) throw new Error('The page is not loaded any more.')
  return c
}

async function encode(image: RgbaImage, preset: string, quality: number): Promise<{ kind: 'jpeg'; bytes: Uint8Array } | { kind: 'bilevel'; data: Uint8Array }> {
  if (preset === 'bw') return { kind: 'bilevel', data: encodeBilevel(image) }
  const canvas = new OffscreenCanvas(image.width, image.height)
  const g = canvas.getContext('2d')!
  g.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) }
}

type Handlers = { [O in Op]: (p: WorkerRequests[O]) => Promise<{ result: WorkerResponses[O]; transfer?: Transferable[] }> }

const handlers: Handlers = {
  async prepare({ id, blob, detect }) {
    const bm = await decode(blob)
    const width = bm.width
    const height = bm.height
    const preview = rgbaFromBitmap(bm, PREVIEW_LONG)
    bm.close()
    remember(id, { preview, width, height })
    const found = detect ? detectPage(preview) : null
    return { result: { width, height, quad: found?.quad ?? null, score: found?.score ?? 0 } }
  },

  async view({ id, rotation, maxSide }) {
    const c = need(id)
    const img = fitLongSide(rotateQuarterTurns(c.preview, rotation), maxSide)
    const bitmap = await toBitmap(img)
    return { result: { bitmap, width: img.width, height: img.height }, transfer: [bitmap] }
  },

  async preview({ id, params, maxSide }) {
    const c = need(id)
    // the working copy is smaller than the picture: scale the dpi so the page size shown is the real one
    const ratio = Math.max(c.preview.width, c.preview.height) / Math.max(c.width, c.height)
    const out = processPage(c.preview, { ...params, sourceDpi: params.sourceDpi ? params.sourceDpi * ratio : undefined, maxLongSide: maxSide })
    const bitmap = await toBitmap(out.image)
    return { result: { bitmap, width: out.image.width, height: out.image.height, pageWidthPt: out.pageWidthPt, pageHeightPt: out.pageHeightPt, dpi: out.dpi, skewDegrees: out.skewDegrees }, transfer: [bitmap] }
  },

  async detect({ id, rotation }) {
    const c = need(id)
    const found = detectPage(rotateQuarterTurns(c.preview, rotation))
    return { result: { quad: found?.quad ?? null, score: found?.score ?? 0 } }
  },

  async export({ blob, params, jpegQuality, maxLongSide }) {
    const bm = await decode(blob)
    let src: RgbaImage | null = rgbaFromBitmap(bm)
    bm.close()
    const out = processPage(src, { ...params, maxLongSide })
    src = null
    const enc = await encode(out.image, params.preset, jpegQuality)
    const base = { pageWidthPt: out.pageWidthPt, pageHeightPt: out.pageHeightPt }
    const page: EncodedPage = enc.kind === 'jpeg' ? { kind: 'jpeg', bytes: enc.bytes, ...base } : { kind: 'bilevel', data: enc.data, widthPx: out.image.width, heightPx: out.image.height, ...base }
    const buf = page.kind === 'jpeg' ? page.bytes : page.kind === 'bilevel' ? page.data : new Uint8Array(0)
    return { result: { page, dpi: out.dpi, skewDegrees: out.skewDegrees, bytes: buf.length }, transfer: [buf.buffer as ArrayBuffer] }
  },

  async detectFrame({ bitmap }) {
    const img = rgbaFromBitmap(bitmap, 256)
    bitmap.close()
    const found = detectPage(img, { fast: true, maxSide: 256 })
    return { result: { quad: found?.quad ?? null, score: found?.score ?? 0 } }
  },

  async assemble({ pages, title }) {
    const bytes = await assemblePdf(pages, { title })
    return { result: { bytes }, transfer: [bytes.buffer as ArrayBuffer] }
  },

  async drop({ id }) {
    cache.delete(id)
    return { result: {} }
  },

  async clear() {
    cache.clear()
    return { result: {} }
  }
}

self.onmessage = async (e: MessageEvent<WorkerCall>): Promise<void> => {
  const { reqId, op, payload } = e.data
  try {
    const h = handlers[op] as (p: unknown) => Promise<{ result: unknown; transfer?: Transferable[] }>
    const { result, transfer } = await h(payload)
    const reply: WorkerReply = { reqId, ok: true, result }
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, transfer ?? [])
  } catch (err) {
    const reply: WorkerReply = { reqId, ok: false, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(reply)
  }
}
