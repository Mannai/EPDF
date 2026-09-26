import type { PageTextModel } from '@shared/pagetext'

/** Messages between the renderer and the page text worker (structured-cloneable). */

export type ToWorker =
  | { type: 'open'; key: string; bytes: Uint8Array }
  | { type: 'page'; key: string; id: number; pageIndex: number }
  | { type: 'close'; key: string }

export type FromWorker =
  | { type: 'opened'; key: string; ok: true; pages: number }
  | { type: 'opened'; key: string; ok: false; error: string }
  | { type: 'page'; id: number; model: PageTextModel | null; error?: string; ms: number }
