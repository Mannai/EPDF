import type { FlowDocument } from './flow'
import { OfficeError, type ConvertEnv } from './env'

/** STUB - replaced by the RTF reader. */
export function readRtf(_bytes: Uint8Array, _env: ConvertEnv): FlowDocument {
  throw new OfficeError('RTF files are not supported yet.')
}
