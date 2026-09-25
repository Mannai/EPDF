import type { FlowDocument } from './flow'
import { OfficeError, type ConvertEnv } from './env'

/** STUB - replaced by the ODT reader. */
export async function readOdt(_bytes: Uint8Array, _env: ConvertEnv): Promise<FlowDocument> {
  throw new OfficeError('OpenDocument text files are not supported yet.')
}
