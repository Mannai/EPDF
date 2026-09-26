import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pageText, rememberPdfjs } from '../../pdf/pagetext'
import { describeFont } from './fonts'
import { assignTextColors, compose, interpretOperators, type OpsTable, type PaintedImage } from './graphics'
import type { ImageItem, LinkItem, PageModel, PdfModel, TextItem } from './model'
import { encodePng, toRgba } from './png'

/**
 * The thin layer that needs PDF.js: reads text, fonts, colours, rulings, images and links of every page into
 * the plain `PdfModel`. It takes a `PDFDocumentProxy` (the renderer's, or the legacy build's in tests).
 */

export interface ExtractOptions {
  /** PDF.js' `OPS` table (passed in so this module has no runtime dependency on pdfjs-dist). */
  OPS: OpsTable
  signal?: AbortSignal
  onProgress?: (fraction: number, message: string) => void
  includeImages: boolean
}

export const abortError = (): Error => {
  const e = new Error('The export was cancelled.')
  e.name = 'AbortError'
  return e
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const MAX_IMAGES_PER_PAGE = 60
const MAX_IMAGE_PIXELS = 36_000_000

interface RawImage {
  width: number
  height: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
  bitmap?: ImageBitmap
}

interface ObjStore {
  has(id: string): boolean
  get(id: string, cb?: (v: unknown) => void): unknown
}

/** Reads a resolved PDF.js object (image, font), waiting briefly for objects that are still being decoded. */
function getObj(objs: ObjStore, id: string, timeoutMs = 4000): Promise<unknown> {
  try {
    if (objs.has(id)) return Promise.resolve(objs.get(id))
  } catch {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    try {
      objs.get(id, (v) => {
        clearTimeout(timer)
        resolve(v)
      })
    } catch {
      clearTimeout(timer)
      resolve(undefined)
    }
  })
}

function rawToPng(raw: RawImage): { png: Uint8Array; w: number; h: number } | null {
  const { width: w, height: h } = raw
  if (!w || !h || w * h > MAX_IMAGE_PIXELS) return null
  let rgba: Uint8Array | null = null
  if (raw.data && raw.kind) {
    rgba = toRgba(raw.data, w, h, raw.kind)
  } else if (raw.bitmap && typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(raw.bitmap, 0, 0)
    rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)
  }
  return rgba ? { png: encodePng(rgba, w, h), w, h } : null
}

/** Content fingerprint (length + two FNV-1a style hashes) used to recognise identical images. */
function fingerprint(b: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193)
    h2 = Math.imul(h2 + b[i], 0x85ebca6b) ^ (h2 >>> 13)
  }
  return `${b.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`
}

const safeUrl =(u: unknown): string | null => {
  if (typeof u !== 'string') return null
  try {
    const p = new URL(u)
    return ['http:', 'https:', 'mailto:', 'ftp:'].includes(p.protocol) ? p.toString() : null
  } catch {
    return null
  }
}

export async function extractPdf(doc: PDFDocumentProxy, opts: ExtractOptions): Promise<PdfModel> {
  const { OPS, signal } = opts
  const warnings: string[] = []
  const pages: PageModel[] = []
  const pngPool = new Map<string, Uint8Array>()
  const n = doc.numPages
  let rotatedSkipped = 0
  let imagesSkipped = 0
  let title: string | undefined
  try {
    const meta = (await doc.getMetadata()) as { info?: { Title?: unknown } }
    if (typeof meta.info?.Title === 'string' && meta.info.Title.trim()) title = meta.info.Title.trim()
  } catch {
    /* metadata is optional */
  }

  for (let p = 1; p <= n; p++) {
    if (signal?.aborted) throw abortError()
    opts.onProgress?.((p - 1) / n, `Reading page ${p} of ${n}`)
    const page = await doc.getPage(p)
    try {
      const vp = page.getViewport({ scale: 1 })
      const vt = vp.transform as number[]
      const toPage = (x: number, y: number): [number, number] => [vt[0] * x + vt[2] * y + vt[4], vt[1] * x + vt[3] * y + vt[5]]

      const [content, ol] = await Promise.all([page.getTextContent(), page.getOperatorList()])
      if (signal?.aborted) throw abortError()

      const gfx = interpretOperators(ol.fnArray, ol.argsArray, OPS, toPage)
      const textItems = (content.items as { str?: string; transform: number[]; width: number; fontName: string }[]).filter(
        (it) => typeof it.str === 'string'
      ) as { str: string; transform: number[]; width: number; fontName: string }[]
      const colors = assignTextColors(textItems, gfx.textColors)

      // Real font names live in the font objects PDF.js resolves while it reads the operator list.
      const fontCache = new Map<string, ReturnType<typeof describeFont>>()
      for (const fontName of new Set(textItems.map((i) => i.fontName))) {
        const obj = (await getObj(page.commonObjs as unknown as ObjStore, fontName, 1500)) as { name?: string } | undefined
        fontCache.set(fontName, describeFont(obj?.name, (content.styles as Record<string, { fontFamily?: string }>)[fontName]?.fontFamily))
      }
      const fontOf = (fontName: string): ReturnType<typeof describeFont> => fontCache.get(fontName) ?? describeFont(undefined, undefined)

      const items: TextItem[] = []
      textItems.forEach((it, i) => {
        if (!it.str.trim()) return
        const m = compose(it.transform, vt)
        if (Math.abs(m[1]) > 0.2 * Math.abs(m[0])) {
          rotatedSkipped++
          return
        }
        const size = Math.hypot(m[2], m[3])
        if (!(size > 0.5)) return
        const f = fontOf(it.fontName)
        items.push({
          text: it.str,
          x: m[4],
          y: m[5],
          width: Math.abs(it.width),
          size,
          fontName: f.family,
          family: f.family,
          bold: f.bold,
          italic: f.italic,
          mono: f.mono,
          serif: f.serif,
          color: colors[i] ?? '000000'
        })
      })
      // Right-to-left and complex-script pages: PDF.js's items are in visual order (and garbled around marks); the
      // page text model gives each line in logical order. One item per line, styled like the PDF.js text under it.
      rememberPdfjs(doc, p, content.items as { str?: string; hasEOL?: boolean }[])
      const pt = await pageText(doc, p).catch(() => null)
      if (pt?.kind === 'model') {
        const styled = items.splice(0, items.length)
        for (const line of pt.model.lines) {
          if (line.angle !== 0) {
            rotatedSkipped++
            continue
          }
          const text = pt.model.text.slice(line.start, line.end)
          if (!text.trim()) continue
          const under = styled.find((s) => Math.abs(s.y - line.baseline) < line.size * 0.5 && s.x < line.x1 && s.x + s.width > line.x0)
          const f = under ?? { fontName: line.font, family: describeFont(line.font, undefined).family, mono: false, serif: false, color: '000000' }
          items.push({
            text,
            x: line.x0,
            y: line.baseline,
            width: line.x1 - line.x0,
            size: line.size,
            fontName: f.fontName,
            family: f.family,
            bold: line.bold,
            italic: line.italic,
            mono: f.mono,
            serif: f.serif,
            color: f.color,
            rtl: line.dir === 'rtl'
          })
        }
      }

      // Links
      const links: LinkItem[] = []
      try {
        const annots = (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]
        for (const a of annots) {
          if (a.subtype !== 'Link' || !a.rect) continue
          const url = safeUrl(a.url ?? a.unsafeUrl)
          if (!url) continue
          const [ax, ay] = toPage(a.rect[0], a.rect[1])
          const [bx, by] = toPage(a.rect[2], a.rect[3])
          links.push({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), url })
        }
      } catch {
        /* annotations are optional */
      }
      for (const it of items) {
        const cx = it.x + it.width / 2
        const cy = it.y - it.size * 0.3
        const hit = links.find((l) => cx >= l.x && cx <= l.x + l.width && cy >= l.y && cy <= l.y + l.height)
        if (hit) it.url = hit.url
      }

      // Images
      const images: ImageItem[] = []
      if (opts.includeImages) {
        const cache = new Map<string, { png: Uint8Array; w: number; h: number } | null>()
        for (const pi of gfx.images as PaintedImage[]) {
          if (images.length >= MAX_IMAGES_PER_PAGE) {
            imagesSkipped++
            continue
          }
          if (pi.width < 4 || pi.height < 4) continue
          const key = pi.name ?? ''
          let enc = pi.name ? cache.get(key) : undefined
          if (enc === undefined) {
            // Images used several times are shared by the whole document ("g_…" ids live in commonObjs).
            const store = (pi.name?.startsWith('g_') ? page.commonObjs : page.objs) as unknown as ObjStore
            const raw = pi.name ? await getObj(store, pi.name) : pi.inline
            enc = raw ? rawToPng(raw as RawImage) : null
            if (pi.name) cache.set(key, enc)
          }
          if (!enc) {
            imagesSkipped++
            continue
          }
          if (enc.w < 4 || enc.h < 4) continue
          // The same picture repeated on many pages (a logo) shares one byte array, so writers store it once.
          const fp = fingerprint(enc.png)
          const shared = pngPool.get(fp) ?? enc.png
          pngPool.set(fp, shared)
          images.push({ x: pi.x, y: pi.y, width: pi.width, height: pi.height, png: shared, pxWidth: enc.w, pxHeight: enc.h })
        }
        imagesSkipped += gfx.skippedImages
      }

      pages.push({
        number: p,
        width: vp.width,
        height: vp.height,
        items,
        images,
        rects: gfx.rects,
        lines: gfx.lines,
        links
      })
    } finally {
      page.cleanup()
    }
    await tick()
  }
  if (rotatedSkipped) warnings.push(`${rotatedSkipped} piece${rotatedSkipped === 1 ? '' : 's'} of rotated text could not be converted and ${rotatedSkipped === 1 ? 'was' : 'were'} skipped.`)
  if (imagesSkipped) warnings.push(`${imagesSkipped} image${imagesSkipped === 1 ? '' : 's'} (masks, unsupported or very large) could not be converted and ${imagesSkipped === 1 ? 'was' : 'were'} left out.`)
  return { title, pages, warnings }
}
