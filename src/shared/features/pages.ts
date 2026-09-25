import { z } from 'zod'

/** Payload schemas shared by the page-organizer's main-process half (channels, jobs) and its renderer. */

export const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')
const TokenSchema = z.string().min(8).max(64)

export const PickPdfRequestSchema = z.object({})
export interface PickedPdf {
  name: string
  bytes: Uint8Array
}

export const PickFolderRequestSchema = z.object({})
export interface PickedFolder {
  /** Opaque handle main resolves to a path; the renderer never sees or supplies paths. */
  token: string
  name: string
}

export const SaveBytesRequestSchema = z.object({
  docId: z.string().min(1).max(64),
  bytes: BytesSchema,
  suggestedName: z.string().max(200)
})
export interface SavedFile {
  token: string
  name: string
  size: number
}

export const TokenRequestSchema = z.object({ token: TokenSchema })

export const SplitSpecSchema = z.discriminatedUnion('by', [
  /** Page ranges as parsed by the renderer: 1-based inclusive. */
  z.object({ by: z.literal('ranges'), ranges: z.array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1) })).min(1).max(5000) }),
  z.object({ by: z.literal('every'), pages: z.number().int().min(1).max(100000) }),
  z.object({ by: z.literal('size'), maxBytes: z.number().int().min(10 * 1024).max(4 * 1024 * 1024 * 1024) }),
  z.object({ by: z.literal('bookmarks') })
])
export type SplitSpec = z.infer<typeof SplitSpecSchema>

export const SplitJobSchema = z.object({
  bytes: BytesSchema,
  spec: SplitSpecSchema,
  folderToken: TokenSchema,
  /** Used to name the output files ("<base> - 01 - <title>.pdf"). */
  baseName: z.string().max(200)
})

export interface SplitResult {
  files: { name: string; token: string; size: number; label: string; pages: string; oversized: boolean }[]
  warnings: string[]
  folderToken: string
}

export const PAGES_CHANNELS = {
  pickPdf: 'pages:pickPdf',
  pickFolder: 'pages:pickFolder',
  saveExtract: 'pages:saveExtract',
  openSaved: 'pages:openSaved',
  reveal: 'pages:reveal'
} as const
