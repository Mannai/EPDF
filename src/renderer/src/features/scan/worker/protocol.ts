import type { EncodedPage } from '@shared/features/scan/assemble'
import type { ScanPreset } from '@shared/features/scan/enhance'
import type { Quad } from '@shared/features/scan/geometry'
import type { PaperChoice } from '@shared/features/scan/pipeline'

/** Messages between the scan UI and its Web Worker (all image work happens there, so the UI never freezes). */

export interface PageParams {
  quad: Quad | null
  rotation: number
  preset: ScanPreset
  straighten: boolean
  paper: PaperChoice
  sourceDpi?: number
  bwBias?: number
}

export interface WorkerRequests {
  /** Decode, keep a working copy, and (optionally) detect the page edges. */
  prepare: { id: string; blob: Blob; detect: boolean }
  /** The rotated source at a size for on-screen editing. */
  view: { id: string; rotation: number; maxSide: number }
  /** The processed page (crop + perspective + straighten + enhance) at a preview size. */
  preview: { id: string; params: PageParams; maxSide: number }
  /** Re-run page detection on the working copy (the quad is relative to the rotated source). */
  detect: { id: string; rotation: number }
  /** Full resolution processing and encoding of one page. */
  export: { id: string; blob: Blob; params: PageParams; jpegQuality: number; maxLongSide: number }
  /** Live camera frames: fast detection on a small bitmap (transferred). */
  detectFrame: { bitmap: ImageBitmap }
  assemble: { pages: EncodedPage[]; title?: string }
  drop: { id: string }
  clear: Record<string, never>
}

export interface WorkerResponses {
  prepare: { width: number; height: number; quad: Quad | null; score: number }
  view: { bitmap: ImageBitmap; width: number; height: number }
  preview: { bitmap: ImageBitmap; width: number; height: number; pageWidthPt: number; pageHeightPt: number; dpi: number; skewDegrees: number }
  detect: { quad: Quad | null; score: number }
  export: { page: EncodedPage; dpi: number; skewDegrees: number; bytes: number }
  detectFrame: { quad: Quad | null; score: number }
  assemble: { bytes: Uint8Array }
  drop: Record<string, never>
  clear: Record<string, never>
}

export type Op = keyof WorkerRequests

export interface WorkerCall<O extends Op = Op> {
  reqId: number
  op: O
  payload: WorkerRequests[O]
}

export type WorkerReply = { reqId: number; ok: true; result: unknown } | { reqId: number; ok: false; error: string }
