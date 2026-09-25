import { z } from 'zod'

/**
 * Types and pure helpers shared by the renderer and main halves of the Create PDF / Combine features.
 * Nothing here touches the file system: the renderer only ever refers to files by an opaque id that main
 * issued when the user picked them in a native dialog.
 */

export type SourceKind = 'pdf' | 'image' | 'tiff' | 'heic' | 'office'

const EXTENSIONS: Record<SourceKind, readonly string[]> = {
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png'],
  tiff: ['tif', 'tiff'],
  heic: ['heic', 'heif'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt']
}

export const SOURCE_EXTENSIONS = EXTENSIONS

export const extensionOf = (name: string): string => {
  const m = /\.([^./\\]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** What kind of source a file name denotes, or null if Epdf cannot make a PDF from it. */
export function classifyName(name: string): SourceKind | null {
  const ext = extensionOf(name)
  for (const kind of Object.keys(EXTENSIONS) as SourceKind[]) if (EXTENSIONS[kind].includes(ext)) return kind
  return null
}

export const KIND_LABEL: Record<SourceKind, string> = {
  pdf: 'PDF',
  image: 'Image',
  tiff: 'TIFF image',
  heic: 'HEIC image',
  office: 'Office document'
}

/** A file the user picked, as the renderer sees it. `id` is the only handle main will accept for it. */
export const PickedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  kind: z.enum(['pdf', 'image', 'tiff', 'heic', 'office']),
  /** Page count when known (PDFs; single images = 1). */
  pages: z.number().int().nullable(),
  /** Set when the file cannot be used as-is (e.g. an encrypted PDF), with a user-presentable reason. */
  problem: z.string().optional()
})
export type PickedFile = z.infer<typeof PickedFileSchema>

export const PickRequestSchema = z.object({ purpose: z.enum(['create', 'combine']) })

export const ImageOptionsSchema = z.object({
  /** `image`: the page is the size of the image. `a4`/`letter`: fit the image on that page with a margin. */
  pageSize: z.enum(['image', 'a4', 'letter']).default('image')
})
export type ImageOptions = z.infer<typeof ImageOptionsSchema>

export const CreateConvertPayloadSchema = z.object({
  ids: z.array(z.string().max(64)).min(1).max(200),
  images: ImageOptionsSchema.default({ pageSize: 'image' }),
  /** `ask`: a Save dialog (one file) or a folder chooser (several). `beside`: next to each source, no dialog. */
  saveMode: z.enum(['ask', 'beside']).default('ask'),
  /** Open the results in the app from main (command-line use). The renderer does this itself for menu use. */
  openInApp: z.boolean().default(false)
})
export type CreateConvertPayload = z.infer<typeof CreateConvertPayloadSchema>

export const CreateWebPayloadSchema = z.object({
  url: z.string().min(1).max(4096),
  javascript: z.boolean().default(true),
  openInApp: z.boolean().default(false)
})
export type CreateWebPayload = z.infer<typeof CreateWebPayloadSchema>

export interface CreateResult {
  /** Files that were written. Empty when the user cancelled the Save dialog. */
  saved: { path: string; name: string; pages: number }[]
  failed: { name: string; error: string }[]
  cancelled?: boolean
  /** Extra information worth showing (e.g. the web server answered 404 but the page was still saved). */
  notes: string[]
}

export interface ToolStatus {
  soffice: boolean
  /** Where LibreOffice would be looked up, for the "not installed" instructions. */
  sofficeHelp: string
}

// ---------------------------------------------------------------------------------------------------
// Web addresses
// ---------------------------------------------------------------------------------------------------

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string }

const HAS_SLASHES_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const OTHER_SCHEMES = /^(javascript|data|file|mailto|about|blob|ftp|ftps|chrome|view-source|vbscript|ws|wss|tel|sms|intent|devtools|epdf-app):/i

/**
 * Turns what the user typed into an http(s) URL. A missing scheme becomes `https://`; anything that is not
 * http(s) (file:, javascript:, data:, ftp:, ...) is refused, because the page is rendered by a locked-down
 * browser window that must never be pointed at local files or script URLs.
 */
export function normalizeWebUrl(input: string): UrlCheck {
  let text = input.trim()
  if (!text) return { ok: false, error: 'Enter a web address, for example example.com.' }
  if (text.length > 2048) return { ok: false, error: 'That web address is too long.' }
  if (/[\u0000-\u001f\u007f\s]/.test(text)) return { ok: false, error: 'A web address cannot contain spaces or control characters.' }
  if (OTHER_SCHEMES.test(text) || (HAS_SLASHES_SCHEME.test(text) && !/^https?:\/\//i.test(text))) {
    return { ok: false, error: 'Only web addresses starting with http:// or https:// can be converted.' }
  }
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { ok: false, error: 'That does not look like a valid web address.' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only web addresses starting with http:// or https:// can be converted.' }
  }
  if (!u.hostname) return { ok: false, error: 'That web address has no host name.' }
  return { ok: true, url: u.toString() }
}

/** A file-name-safe version of a URL's host for the default "Save as" name. */
export function fileNameForUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').replace(/[^A-Za-z0-9._-]+/g, '-')
    return host || 'web-page'
  } catch {
    return 'web-page'
  }
}

/** Strips characters Windows/macOS/Linux refuse in file names (and control characters) from a base name. */
export function safeFileBase(name: string, fallback = 'Document'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/[. ]+$/g, '').trim()
  return cleaned || fallback
}
