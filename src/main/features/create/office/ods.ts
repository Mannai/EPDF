import { OfficeError, type ConvertEnv } from './env'
import type { Page } from './ops'

/** STUB - replaced by the ODS converter. */
export async function convertOds(_bytes: Uint8Array, _env: ConvertEnv): Promise<Page[]> {
  throw new OfficeError('OpenDocument spreadsheets are not supported yet.')
}
