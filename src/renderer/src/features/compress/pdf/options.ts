/** What "Reduce File Size" may do. Presets fill this in; the Custom preset lets the user edit every field. */

export interface CompressOptions {
  // --- images (the only lossy part) ---
  /** Master switch: downsample / re-encode images at all. */
  images: boolean
  /** Target resolution for colour and gray images (pixels per inch of the placed size). */
  colorDpi: number
  /** Target resolution for 1-bit images and stencil masks (scans). */
  monoDpi: number
  /** Images are only downsampled when they exceed the target by this factor (avoids blurring 160 dpi to 150 dpi). */
  downsampleFactor: number
  /** JPEG quality 1-100 used for photographs. */
  jpegQuality: number
  /** Re-encode existing JPEGs whose quality is clearly higher than `jpegQuality` even when they are not downsampled. */
  recompressJpeg: boolean
  /** Images whose stored data is smaller than this are left alone. */
  minImageBytes: number

  // --- structure (lossless) ---
  /** Merge identical streams, fonts, images and colour profiles. */
  dedupe: boolean
  /** Re-deflate streams at maximum level; convert LZW / ASCII85 / uncompressed streams to Flate. */
  recompressStreams: boolean
  /** Pack objects into compressed object streams with a compressed cross-reference stream. */
  objectStreams: boolean
  /**
   * Shrink fully embedded TrueType fonts to the glyphs the document actually uses. Text looks and copies the same, but the
   * font can no longer supply other characters (e.g. when editing that text later).
   */
  subsetFonts: boolean

  // --- removals (each optional) ---
  stripMetadata: boolean
  stripThumbnails: boolean
  stripPieceInfo: boolean
  stripJavaScript: boolean
  stripUnusedDests: boolean
  stripExtras: boolean
}

export type PresetId = 'high' | 'balanced' | 'smallest' | 'custom'

const BASE: CompressOptions = {
  images: true,
  colorDpi: 150,
  monoDpi: 300,
  downsampleFactor: 1.25,
  jpegQuality: 70,
  recompressJpeg: true,
  minImageBytes: 6 * 1024,
  dedupe: true,
  recompressStreams: true,
  objectStreams: true,
  subsetFonts: false,
  stripMetadata: false,
  stripThumbnails: true,
  stripPieceInfo: true,
  stripJavaScript: false,
  stripUnusedDests: false,
  stripExtras: false
}

export const PRESETS: Record<Exclude<PresetId, 'custom'>, CompressOptions> = {
  high: { ...BASE, colorDpi: 300, monoDpi: 600, jpegQuality: 85, stripThumbnails: false, stripPieceInfo: false },
  balanced: { ...BASE },
  smallest: { ...BASE, colorDpi: 96, monoDpi: 200, jpegQuality: 50, subsetFonts: true, stripMetadata: true, stripExtras: true }
}

export const PRESET_LABELS: Record<PresetId, { label: string; blurb: string }> = {
  high: { label: 'High quality', blurb: 'Images above 300 dpi are reduced, JPEG quality 85. Best for printing.' },
  balanced: { label: 'Balanced', blurb: 'Images above 150 dpi are reduced, JPEG quality 70. Good for screens and email.' },
  smallest: { label: 'Smallest file', blurb: 'Images reduced to 96 dpi, JPEG quality 50, fonts trimmed to the characters used, document properties removed. Text stays sharp.' },
  custom: { label: 'Custom', blurb: 'Choose the resolution, quality and what to remove yourself.' }
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback

/** Fills missing fields with the Balanced defaults and clamps numbers to sane ranges (options arrive from the UI / a worker message). */
export function sanitizeOptions(o: Partial<CompressOptions> | undefined): CompressOptions {
  const b = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const x = o ?? {}
  return {
    images: b(x.images, BASE.images),
    colorDpi: clampNum(x.colorDpi, 36, 1200, BASE.colorDpi),
    monoDpi: clampNum(x.monoDpi, 72, 2400, BASE.monoDpi),
    downsampleFactor: clampNum(x.downsampleFactor, 1, 4, BASE.downsampleFactor),
    jpegQuality: Math.round(clampNum(x.jpegQuality, 1, 100, BASE.jpegQuality)),
    recompressJpeg: b(x.recompressJpeg, BASE.recompressJpeg),
    minImageBytes: clampNum(x.minImageBytes, 0, 1 << 30, BASE.minImageBytes),
    dedupe: b(x.dedupe, BASE.dedupe),
    recompressStreams: b(x.recompressStreams, BASE.recompressStreams),
    objectStreams: b(x.objectStreams, BASE.objectStreams),
    subsetFonts: b(x.subsetFonts, BASE.subsetFonts),
    stripMetadata: b(x.stripMetadata, BASE.stripMetadata),
    stripThumbnails: b(x.stripThumbnails, BASE.stripThumbnails),
    stripPieceInfo: b(x.stripPieceInfo, BASE.stripPieceInfo),
    stripJavaScript: b(x.stripJavaScript, BASE.stripJavaScript),
    stripUnusedDests: b(x.stripUnusedDests, BASE.stripUnusedDests),
    stripExtras: b(x.stripExtras, BASE.stripExtras)
  }
}

/** Which preset the options exactly equal (else 'custom'). */
export function presetOf(o: CompressOptions): PresetId {
  for (const id of ['high', 'balanced', 'smallest'] as const) {
    const p = PRESETS[id]
    if ((Object.keys(p) as (keyof CompressOptions)[]).every((k) => p[k] === o[k])) return id
  }
  return 'custom'
}
