import { OfficeError, type ConvertEnv } from './env'
import type { Page } from './ops'

/** STUB - replaced by the CSV converter. */
export function convertCsv(_bytes: Uint8Array, _env: ConvertEnv): Page[] {
  throw new OfficeError('CSV files are not supported yet.')
}
