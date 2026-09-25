import type { FlowDocument } from './flow'
import { OfficeError, type ConvertEnv } from './env'

/** STUB - replaced by the DOCX reader. */
export async function readDocx(_bytes: Uint8Array, _env: ConvertEnv): Promise<FlowDocument> {
  throw new OfficeError('Word documents are not supported yet.')
}
