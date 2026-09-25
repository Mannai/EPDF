import type { Analysis } from './pdf/analyze'
import type { CompressResult } from './pdf/compress'
import type { CompressOptions } from './pdf/options'

/** Messages between the dialog and the compression Web Worker. */

export type WorkerRequest =
  | { type: 'analyze'; id: number; bytes: Uint8Array }
  | { type: 'compress'; id: number; bytes: Uint8Array; options: CompressOptions }

export type WorkerResponse =
  | { type: 'progress'; id: number; fraction: number; label: string }
  | { type: 'analysis'; id: number; analysis: Analysis }
  | { type: 'result'; id: number; result: CompressResult }
  | { type: 'error'; id: number; message: string }
