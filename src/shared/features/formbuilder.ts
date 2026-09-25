import { z } from 'zod'

/** Main-process channels of the form builder (only the CSV save step needs main: it owns the save dialog). */
export const CsvSaveSchema = z.object({
  docId: z.string().min(1),
  /** UTF-8 text of the CSV (a byte-order mark is added on save so spreadsheets read it as UTF-8). */
  text: z.string().max(20_000_000)
})

export type CsvSaveRequest = z.infer<typeof CsvSaveSchema>
export interface CsvSaveResult {
  path: string
  name: string
}
