import type { FontCatalog } from './fonts'
import type { Warnings } from './ops'

/** Everything a reader needs from the conversion pipeline. */
export interface ConvertEnv {
  catalog: FontCatalog
  warnings: Warnings
  signal?: AbortSignal
  /** Progress 0..1 with an optional step description. */
  progress(fraction: number, message?: string): void
  /** Page size for formats that do not define one (txt, csv, rtf without \paperw). Points. */
  page: { width: number; height: number }
  /** Names of the bundled font families available (informational). */
}

export class OfficeError extends Error {}

export const PAGE_A4 = { width: 595.28, height: 841.89 }
export const PAGE_LETTER = { width: 612, height: 792 }

export function throwIfCancelled(env: ConvertEnv): void {
  if (env.signal?.aborted) throw new Error('Cancelled')
}
