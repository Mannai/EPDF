import { z } from 'zod'
import { BytesSchema } from './pages'

/** Payload schemas for printing (channels and the "prepare" job). */

export const PrepareJobSchema = z.object({
  bytes: BytesSchema,
  /** 0-based pages to keep, in output order. */
  pages: z.array(z.number().int().min(0)).min(1).max(100000),
  annotations: z.boolean(),
  scale: z
    .object({
      scaling: z.enum(['fit', 'actual', 'custom']),
      percent: z.number().min(10).max(400),
      paper: z.enum(['source', 'a4', 'letter']),
      orientation: z.enum(['auto', 'portrait', 'landscape'])
    })
    .optional()
})
export type PrepareJob = z.infer<typeof PrepareJobSchema>

export const PrintBeginRequestSchema = z.object({ pageCount: z.number().int().min(1).max(5000) })

export const PrintAddPageRequestSchema = z.object({
  jobId: z.string().min(8).max(64),
  index: z.number().int().min(0).max(5000),
  jpeg: BytesSchema,
  widthPt: z.number().min(1).max(20000),
  heightPt: z.number().min(1).max(20000)
})

export const PrintRunRequestSchema = z.object({
  jobId: z.string().min(8).max(64),
  copies: z.number().int().min(1).max(99),
  scaling: z.enum(['fit', 'actual', 'custom']),
  percent: z.number().min(10).max(400),
  orientation: z.enum(['portrait', 'landscape']),
  /** Shown as the print job's name in the system dialog and spooler. */
  title: z.string().max(200)
})

export const PrintCancelRequestSchema = z.object({ jobId: z.string().min(8).max(64) })

export type PrintOutcome =
  | { status: 'printed' }
  | { status: 'cancelled' }
  /** Test hook (EPDF_PRINT_TO_FILE): the result was written to a file instead of showing the system dialog. */
  | { status: 'saved-to-file' }
  | { status: 'failed'; message: string }

export const PRINT_CHANNELS = {
  begin: 'print:begin',
  addPage: 'print:addPage',
  run: 'print:run',
  cancel: 'print:cancel',
  savePdf: 'print:savePdf'
} as const
