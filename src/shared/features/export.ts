import { z } from 'zod'

export const EXPORT_FORMATS = ['docx', 'xlsx', 'pptx'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_LABEL: Record<ExportFormat, string> = {
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'PowerPoint presentation'
}

export const EXPORT_MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export const ExportSaveSchema = z.object({
  docId: z.string().min(1).max(64),
  format: z.enum(EXPORT_FORMATS),
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')
})

export interface ExportSaveResult {
  path: string
  name: string
}
