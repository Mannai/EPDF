import { OfficeError, type ConvertEnv } from './env'
import type { Page } from './ops'

/** STUB - replaced by the XLSX converter. */
export async function convertXlsx(_bytes: Uint8Array, _env: ConvertEnv): Promise<Page[]> {
  throw new OfficeError('Excel workbooks are not supported yet.')
}
