import { z } from 'zod'

/** Payloads of the batch mode of "Reduce File Size" (several files chosen from disk). */

export const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')
const TokenSchema = z.string().min(8).max(64)

export const BatchPickRequestSchema = z.object({})
export interface BatchPicked {
  /** Opaque handle main resolves to a path; the renderer never sees or supplies paths. */
  token: string
  name: string
  size: number
}

export const BatchReadRequestSchema = z.object({ token: TokenSchema })
export interface BatchRead {
  name: string
  bytes: Uint8Array
}

export const BatchWriteRequestSchema = z.object({ token: TokenSchema, bytes: BytesSchema })
export interface BatchWritten {
  /** File name of the reduced copy (written next to the original, which is never modified). */
  name: string
  size: number
}

export const COMPRESS_CHANNELS = {
  batchPick: 'compress:batchPick',
  batchRead: 'compress:batchRead',
  batchWrite: 'compress:batchWrite'
} as const

export const MAX_BATCH_FILES = 200
export const MAX_BATCH_FILE_BYTES = 1024 * 1024 * 1024
