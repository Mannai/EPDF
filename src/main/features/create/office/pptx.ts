import { OfficeError, type ConvertEnv } from './env'
import type { Page } from './ops'

/** STUB - replaced by the PPTX converter. */
export async function convertPptx(_bytes: Uint8Array, _env: ConvertEnv): Promise<Page[]> {
  throw new OfficeError('PowerPoint presentations are not supported yet.')
}
