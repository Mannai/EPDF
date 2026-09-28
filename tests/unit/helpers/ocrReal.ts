import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import jpeg from 'jpeg-js'
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { RETRY_CONFIDENCE, type OcrLine } from '../../../src/shared/features/ocr'
import { OcrEngine } from '../../../src/main/features/ocr/engine'
import { applyOcrLayers, visibleBox } from '../../../src/renderer/src/features/ocr/pdf/apply'
import { normalizeRotation, type PageGeometry } from '../../../src/renderer/src/features/ocr/pdf/layout'
import { autoContrast, binarize, estimateSkew, otsuThreshold, shouldDeskew } from '../../../src/renderer/src/features/ocr/pixels'
import { buildPageText, type PageTextModel } from '../../../src/shared/pagetext'
import { encodeGrayPng } from '../../fixtures/ocr.mjs'

/**
 * Real recognition of the right-to-left scan fixtures (tests/fixtures/ocr-rtl) with REAL language data. The suite never
 * downloads: these helpers need `EPDF_OCR_TESSDATA` pointing at a folder with the `<code>.traineddata` files (the
 * catalogue's pinned tessdata_fast files; see docs/features/ocr.md, "Manual test"). Without it the tests skip.
 */

export const TESSDATA = process.env['EPDF_OCR_TESSDATA'] ?? ''
export const RTL_FIXTURES = resolve('tests/fixtures/ocr-rtl')

export interface CorpusPage {
  name: string
  lang: string
  dir: 'rtl' | 'ltr'
  font: string
  size: number
  angle: number
  lines: string[]
}
export const RTL_CORPUS: { pages: CorpusPage[] } = JSON.parse(readFileSync(join(RTL_FIXTURES, 'corpus.json'), 'utf8'))
export const languagesOf = (p: CorpusPage): string[] => p.lang.split('+')

export const hasTessdata = (codes: string[]): boolean => !!TESSDATA && codes.every((c) => c === 'eng' || existsSync(join(TESSDATA, `${c}.traineddata`)))

export interface Gray {
  gray: Uint8Array
  width: number
  height: number
}

/** The page picture of an image-only fixture PDF (its JPEG, decoded to grey). */
export async function fixturePicture(name: string): Promise<{ bytes: Uint8Array; picture: Gray }> {
  // EPDF_OCR_RTL_DIR: another rendering of the same corpus (e.g. the noise-free one, generate.mjs --clean)
  const bytes = new Uint8Array(readFileSync(join(process.env['EPDF_OCR_RTL_DIR'] || RTL_FIXTURES, `${name}.pdf`)))
  const pdf = await PDFDocument.load(bytes)
  const xo = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
  for (const [, ref] of xo.entries()) {
    const s = pdf.context.lookup(ref)
    if (s instanceof PDFRawStream && s.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode')) {
      const img = jpeg.decode(s.contents, { useTArray: true, formatAsRGBA: true })
      const gray = new Uint8Array(img.width * img.height)
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114 + 500) / 1000
      return { bytes, picture: { gray, width: img.width, height: img.height } }
    }
  }
  throw new Error(`${name}: no JPEG picture`)
}

/** Box-filter downscale by an integer-free factor (area average), e.g. 300 dpi -> 200 dpi. */
export function resample(src: Gray, scale: number): Gray {
  if (scale === 1) return src
  const width = Math.max(1, Math.round(src.width * scale))
  const height = Math.max(1, Math.round(src.height * scale))
  const out = new Uint8Array(width * height)
  const inv = 1 / scale
  for (let y = 0; y < height; y++) {
    const sy0 = y * inv
    const sy1 = Math.min(src.height, (y + 1) * inv)
    for (let x = 0; x < width; x++) {
      const sx0 = x * inv
      const sx1 = Math.min(src.width, (x + 1) * inv)
      let sum = 0
      let n = 0
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
        sum += src.gray[yy * src.width + xx]
        n++
      }
      out[y * width + x] = n ? Math.round(sum / n) : 255
    }
  }
  return { gray: out, width, height }
}

/** Rotates by -angle around the centre (what the renderer's canvas does before recognition), white outside. */
export function rotate(src: Gray, angle: number): Gray {
  const { width: w, height: h } = src
  const out = new Uint8Array(w * h).fill(255)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // destination = source rotated by -angle, so source = destination rotated by +angle
      const dx = x - cx
      const dy = y - cy
      const sx = cx + dx * c - dy * s
      const sy = cy + dx * s + dy * c
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue
      const fx = sx - x0
      const fy = sy - y0
      const i = y0 * w + x0
      const g = src.gray
      out[y * w + x] = Math.round((g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy)
    }
  }
  return { gray: out, width: w, height: h }
}

export interface Prep {
  /** Picture scale relative to the fixture's 300 dpi. */
  scale?: number
  contrast?: boolean
  deskew?: boolean
  /** Otsu binarisation (not what the app does; measured for comparison). */
  binarize?: boolean
  /** 3x3 median filter before recognition (measured for comparison). */
  denoise?: boolean
  /** The app's local binarisation (`binarize` in pixels.ts). */
  sauvola?: boolean
  /** Simulated uneven lighting before anything else. */
  shadow?: boolean
}

/** The same preparation the renderer does (`render.ts`): grey, contrast stretch, deskew. */
export function prepare(src: Gray, p: Prep): { picture: Gray; deskew?: { angle: number; cx: number; cy: number } } {
  let pic = resample(src, p.scale ?? 1)
  pic = { ...pic, gray: pic.gray.slice() }
  if (p.shadow) {
    // uneven lighting: the page darkens towards the bottom-left corner (a photo, a shadow at the spine)
    for (let y = 0; y < pic.height; y++) {
      for (let x = 0; x < pic.width; x++) {
        const f = 1 - 0.5 * Math.min(1, Math.hypot(1 - x / pic.width, y / pic.height) / Math.SQRT2)
        pic.gray[y * pic.width + x] = Math.round(pic.gray[y * pic.width + x] * f)
      }
    }
  }
  if (p.contrast) autoContrast(pic.gray)
  const e = p.deskew ? estimateSkew(pic.gray, pic.width, pic.height) : null
  if (p.sauvola) binarize(pic.gray, pic.width, pic.height)
  if (p.denoise) pic.gray = median3(pic.gray, pic.width, pic.height)
  if (p.binarize) {
    const t = otsuThreshold(pic.gray)
    for (let i = 0; i < pic.gray.length; i++) pic.gray[i] = pic.gray[i] <= t ? 0 : 255
  }
  if (e && shouldDeskew(e)) return { picture: rotate(pic, e.angle), deskew: { angle: e.angle, cx: pic.width / 2, cy: pic.height / 2 } }
  return { picture: pic }
}

/** 3x3 median filter. */
export function median3(g: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(g.length)
  const v = new Array<number>(9)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v[k++] = g[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]
      v.sort((a, b) => a - b)
      out[y * w + x] = v[4]
    }
  }
  return out
}

export const pngOf = (g: Gray): Uint8Array => encodeGrayPng(g.gray, g.width, g.height)

/** An engine over a temp copy of the needed packs (eng from resources/ocr, the others from EPDF_OCR_TESSDATA). */
export async function realEngine(codes: string[], workers = 1): Promise<{ engine: OcrEngine; dispose(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-ocr-real-'))
  for (const c of codes) copyFileSync(c === 'eng' ? resolve('resources/ocr/eng.traineddata') : join(TESSDATA, `${c}.traineddata`), join(dir, `${c}.traineddata`))
  const engine = await OcrEngine.create({ langPath: dir, languages: codes, workers })
  return {
    engine,
    async dispose() {
      await engine.terminate()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export interface RealRun {
  lines: OcrLine[]
  confidence: number
  /** The fixture with the OCR layer added. */
  pdf: Uint8Array
  model: PageTextModel
  ms: number
}

/** Recognizes a fixture page as the app would and writes the text layer into it. */
export async function recognizeFixture(engine: OcrEngine, name: string, p: Prep = { contrast: true, deskew: true }): Promise<RealRun> {
  const { bytes, picture } = await fixturePicture(name)
  const { picture: pic, deskew } = prepare(picture, p)
  const t0 = Date.now()
  const r = await engine.recognize(pngOf(pic))
  const ms = Date.now() - t0
  if (!r.ok) throw new Error(r.error)
  const pdf = await PDFDocument.load(bytes)
  const page = pdf.getPage(0)
  const geometry: PageGeometry = { view: visibleBox(page), rotate: normalizeRotation(page.getRotation().angle), width: pic.width, height: pic.height }
  applyOcrLayers(pdf, [{ pageIndex: 0, geometry, lines: r.lines, deskew }])
  const out = await pdf.save()
  return { lines: r.lines, confidence: r.confidence, pdf: out, model: buildPageText(await PDFDocument.load(out), 0), ms }
}

/**
 * What the app does with its default options: contrast stretch and deskew; a page recognized with less than
 * RETRY_CONFIDENCE is recognized again from the binarised picture and the more confident result is kept.
 */
export async function recognizeLikeApp(engine: OcrEngine, name: string, scale = 1): Promise<RealRun & { retried: boolean; usedBinarized: boolean }> {
  const first = await recognizeFixture(engine, name, { contrast: true, deskew: true, scale })
  if (first.confidence >= RETRY_CONFIDENCE) return { ...first, retried: false, usedBinarized: false }
  const second = await recognizeFixture(engine, name, { contrast: true, deskew: true, sauvola: true, scale })
  const better = second.confidence > first.confidence
  return { ...(better ? second : first), ms: first.ms + second.ms, retried: true, usedBinarized: better }
}

// ---- accuracy ---------------------------------------------------------------------------------------------------

/** Comparison form: NFC, tatweel and bidi controls dropped, whitespace collapsed. */
export const normText = (s: string): string =>
  s
    .normalize('NFC')
    .replace(/[ـ‎‏؜]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export function levenshtein(a: string[], b: string[]): number {
  const prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** Character error rate of `got` against `want` (code points, after `normText`). */
export const cer = (want: string, got: string): number => {
  const w = [...normText(want)]
  return w.length ? levenshtein(w, [...normText(got)]) / w.length : 0
}

/** Fraction of the expected words (letters and digits only) found in `got`. */
export function wordRecall(want: string, got: string): number {
  const tok = (s: string): string[] => normText(s).split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)
  const have = new Map<string, number>()
  for (const t of tok(got)) have.set(t, (have.get(t) ?? 0) + 1)
  const ws = tok(want)
  let hit = 0
  for (const t of ws) {
    const n = have.get(t) ?? 0
    if (n > 0) {
      hit++
      have.set(t, n - 1)
    }
  }
  return ws.length ? hit / ws.length : 1
}
