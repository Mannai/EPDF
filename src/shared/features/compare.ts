import { z } from 'zod'

/** Payload schemas for the compare feature's main-process half (native picker and report saving). */

export const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')

export const PickCompareRequestSchema = z.object({
  /** Which side the file is for; only used to word the dialog title. */
  side: z.enum(['old', 'new']).default('old')
})
export interface PickedCompareFile {
  name: string
  bytes: Uint8Array
}

export const SaveReportRequestSchema = z.object({
  /** The document the comparison was started from; only used to suggest a folder for the report. */
  docId: z.string().min(1).max(64),
  kind: z.enum(['pdf', 'csv']),
  bytes: BytesSchema,
  suggestedName: z.string().max(200)
})
export interface SavedReport {
  name: string
  size: number
}

export const COMPARE_CHANNELS = {
  pickFile: 'compare:pickFile',
  saveReport: 'compare:saveReport'
} as const

/** The largest file the picker will load into memory. */
export const MAX_COMPARE_BYTES = 1024 * 1024 * 1024
