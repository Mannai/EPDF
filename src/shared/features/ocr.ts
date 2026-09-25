import { z } from 'zod'
import { expandRanges, parsePageRanges } from './pages/ranges'

/**
 * Shared pieces of the OCR feature: the language catalogue (with pinned SHA-256 hashes), payload schemas,
 * result types and the pure page-selection logic. Everything here is free of Node/Electron/DOM APIs.
 */

// ---- language catalogue ---------------------------------------------------------------------------------

/**
 * Packs come from the official `tessdata_fast` repository (Apache-2.0), pinned to one commit so the hashes
 * below stay valid. Only `eng` ships inside the app; the others are downloaded on demand.
 */
export const TESSDATA_REPO_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd'
export const TESSDATA_BASE_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REPO_COMMIT}/`

export interface OcrLanguage {
  /** Tesseract language code, also the file name (`<code>.traineddata`). */
  code: string
  name: string
  nativeName: string
  /** Size of the traineddata file in bytes. */
  size: number
  /** Pinned SHA-256 (lowercase hex) of the file. A download or installed file that does not match is refused. */
  sha256: string
  /** Shipped inside the app (no download needed). */
  bundled: boolean
  /** Right-to-left script. */
  rtl?: boolean
}

export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: 'eng', name: 'English', nativeName: 'English', size: 4113088, sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2', bundled: true },
  { code: 'deu', name: 'German', nativeName: 'Deutsch', size: 1525436, sha256: '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d', bundled: false },
  { code: 'fra', name: 'French', nativeName: 'Français', size: 1130365, sha256: 'ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca', bundled: false },
  { code: 'spa', name: 'Spanish', nativeName: 'Español', size: 2294433, sha256: '6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464', bundled: false },
  { code: 'ita', name: 'Italian', nativeName: 'Italiano', size: 2701314, sha256: 'b8f89e1e785118dac4d51ae042c029a64edb5c3ee42ef73027a6d412748d8827', bundled: false },
  { code: 'por', name: 'Portuguese', nativeName: 'Português', size: 1982756, sha256: 'c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb', bundled: false },
  { code: 'nld', name: 'Dutch', nativeName: 'Nederlands', size: 6050296, sha256: 'ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6', bundled: false },
  { code: 'rus', name: 'Russian', nativeName: 'Русский', size: 3861738, sha256: 'e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225', bundled: false },
  { code: 'ara', name: 'Arabic', nativeName: 'العربية', size: 1432056, sha256: 'e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729', bundled: false, rtl: true },
  { code: 'chi_sim', name: 'Chinese (Simplified)', nativeName: '简体中文', size: 2469156, sha256: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730', bundled: false },
  { code: 'jpn', name: 'Japanese', nativeName: '日本語', size: 2471260, sha256: '1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d', bundled: false },
  { code: 'kor', name: 'Korean', nativeName: '한국어', size: 1677415, sha256: '6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2', bundled: false },
  { code: 'hin', name: 'Hindi', nativeName: 'हिन्दी', size: 1122751, sha256: '4c73ffc59d497c186b19d1e90f5d721d678ea6b2e277b719bee4e2af12271825', bundled: false }
]

export const DEFAULT_LANGUAGES = ['eng']
export const MAX_LANGUAGES_PER_RUN = 4

export const findLanguage = (code: string): OcrLanguage | undefined => OCR_LANGUAGES.find((l) => l.code === code)

export const LanguageCodeSchema = z.string().refine((c) => !!findLanguage(c), 'Unsupported language')

export const LanguageListSchema = z.array(LanguageCodeSchema).min(1, 'Choose at least one language').max(MAX_LANGUAGES_PER_RUN, `Choose at most ${MAX_LANGUAGES_PER_RUN} languages`)

/** "1.5 MB" for a byte count. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Keeps codes that exist in the catalogue, drops repeats, and falls back to English when nothing is left. */
export function sanitizeLanguages(codes: unknown): string[] {
  const list = Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string' && !!findLanguage(c)) : []
  const unique = [...new Set(list)].slice(0, MAX_LANGUAGES_PER_RUN)
  return unique.length ? unique : [...DEFAULT_LANGUAGES]
}

// ---- options / preferences ------------------------------------------------------------------------------

export const OCR_DPI_CHOICES = [150, 200, 300, 400] as const
export const MIN_WORD_CONFIDENCE = 15
/** Pages with at least this many non-blank characters of extractable text count as "already have text". */
export const REAL_TEXT_MIN_CHARS = 10
/** Below this mean confidence (percent) the result comes with a warning. */
export const LOW_CONFIDENCE = 60

export const OcrPrefsSchema = z.object({
  languages: z.array(z.string()).max(20),
  dpi: z.number().int().min(72).max(600),
  contrast: z.boolean(),
  deskew: z.boolean(),
  force: z.boolean()
})
export type OcrPrefs = z.infer<typeof OcrPrefsSchema>

export const DEFAULT_PREFS: OcrPrefs = { languages: [...DEFAULT_LANGUAGES], dpi: 300, contrast: true, deskew: true, force: false }

/** Reads whatever was stored and returns valid preferences (unknown fields dropped, bad values defaulted). */
export function sanitizePrefs(raw: unknown): OcrPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const dpi = typeof r.dpi === 'number' && (OCR_DPI_CHOICES as readonly number[]).includes(r.dpi) ? r.dpi : DEFAULT_PREFS.dpi
  return {
    languages: sanitizeLanguages(r.languages),
    dpi,
    contrast: typeof r.contrast === 'boolean' ? r.contrast : DEFAULT_PREFS.contrast,
    deskew: typeof r.deskew === 'boolean' ? r.deskew : DEFAULT_PREFS.deskew,
    force: typeof r.force === 'boolean' ? r.force : DEFAULT_PREFS.force
  }
}

// ---- channels & payloads --------------------------------------------------------------------------------

export const OCR_CHANNELS = {
  languages: 'ocr:languages',
  setPrefs: 'ocr:setPrefs',
  removeLanguage: 'ocr:removeLanguage',
  begin: 'ocr:begin',
  addPage: 'ocr:addPage',
  end: 'ocr:end'
} as const

export const OCR_JOBS = { run: 'ocr:run', download: 'ocr:download' } as const

/** No page picture comes near this (a 30-megapixel PNG is a few MB); it only bounds what a bad caller can send. */
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024
const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array && v.byteLength <= MAX_IMAGE_BYTES, 'Expected bytes (at most 256 MB)')
const SessionIdSchema = z.string().min(8).max(64)

export const BeginRequestSchema = z.object({ languages: LanguageListSchema, total: z.number().int().min(1).max(100000) })
export const AddPageRequestSchema = z.object({
  sessionId: SessionIdSchema,
  index: z.number().int().min(0).max(100000),
  /** PNG (or JPEG/BMP) bytes of the page picture. */
  image: BytesSchema
})
export const EndRequestSchema = z.object({ sessionId: SessionIdSchema })
export const RunJobSchema = z.object({ sessionId: SessionIdSchema })
export const DownloadJobSchema = z.object({ language: LanguageCodeSchema })
export const RemoveLanguageRequestSchema = z.object({ language: LanguageCodeSchema })
export const LanguagesRequestSchema = z.object({})
export const SetPrefsRequestSchema = OcrPrefsSchema

export interface LanguageStatus extends OcrLanguage {
  installed: boolean
}
export interface LanguagesResponse {
  languages: LanguageStatus[]
  prefs: OcrPrefs
}
export interface BeginResponse {
  sessionId: string
  /** How many pages are recognized at the same time (the renderer keeps that many, plus one, in flight). */
  parallel: number
}

/** A recognized word, in pixels of the picture that was sent (origin top-left, y down). */
export interface OcrWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** 0-100 */
  conf: number
}
export interface OcrLine {
  words: OcrWord[]
  /** Text baseline as a segment in picture pixels, when Tesseract found one. */
  baseline: { x0: number; y0: number; x1: number; y1: number } | null
  /** Tesseract's estimate of the line's em height in pixels (0 when unknown). */
  rowHeight: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}
export type OcrPageResult =
  | { ok: true; lines: OcrLine[]; confidence: number; width: number; height: number }
  | { ok: false; error: string }

// ---- page selection -------------------------------------------------------------------------------------

export type PageScope = { mode: 'all' } | { mode: 'current'; page: number } | { mode: 'range'; text: string }

export type PageSelection = { ok: true; pages: number[] } | { ok: false; error: string }

/** 0-based, ascending, de-duplicated page indices for the chosen scope (pages are 1-based in `current`/`text`). */
export function selectPages(scope: PageScope, numPages: number): PageSelection {
  if (numPages < 1) return { ok: false, error: 'The document has no pages.' }
  if (scope.mode === 'all') return { ok: true, pages: Array.from({ length: numPages }, (_, i) => i) }
  if (scope.mode === 'current') {
    const p = Math.round(scope.page)
    if (!(p >= 1 && p <= numPages)) return { ok: false, error: `Page ${scope.page} is out of range: the document has ${numPages} page${numPages === 1 ? '' : 's'}.` }
    return { ok: true, pages: [p - 1] }
  }
  const parsed = parsePageRanges(scope.text, numPages)
  if (!parsed.ok) return parsed
  return { ok: true, pages: [...new Set(expandRanges(parsed.ranges))].sort((a, b) => a - b) }
}
