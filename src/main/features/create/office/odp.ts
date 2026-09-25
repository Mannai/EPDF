import { OfficeError, type ConvertEnv } from './env'
import type { Page } from './ops'

/** STUB - replaced by the ODP converter. */
export async function convertOdp(_bytes: Uint8Array, _env: ConvertEnv): Promise<Page[]> {
  throw new OfficeError('OpenDocument presentations are not supported yet.')
}
