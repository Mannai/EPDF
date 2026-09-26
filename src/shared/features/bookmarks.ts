import { z } from 'zod'
import type { DetectStats, HeadingCandidate } from './bookmarks/headings'

/** Payload schemas shared by the bookmarks feature's main-process half (the heading-detection job) and its renderer. */

export const BookmarkBytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')

export const DETECT_JOB = 'bookmarks:detect'

export const DetectJobSchema = z.object({
  bytes: BookmarkBytesSchema,
  /** Candidates below this confidence are dropped (default 0.35). */
  minConfidence: z.number().min(0).max(1).optional()
})
export type DetectJob = z.infer<typeof DetectJobSchema>

export interface DetectJobResult {
  candidates: HeadingCandidate[]
  stats: DetectStats
  /** Pages the analysis could read at least one line of text from. */
  pagesWithText: number
  pagesTotal: number
}
