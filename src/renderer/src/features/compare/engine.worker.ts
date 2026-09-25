import { runCompare } from './diff/engine'
import type { CompareOptions, CompareResult } from './diff/types'

/** Web Worker running the comparison engine (alignment, per-page diffs, move detection) off the UI thread. */

export interface EngineRequest {
  type: 'run'
  old: string[][]
  new: string[][]
  opts: CompareOptions
}

export type EngineMessage =
  | { type: 'progress'; phase: 'align' | 'diff' | 'moves'; done: number; total: number }
  | { type: 'result'; result: CompareResult }
  | { type: 'error'; message: string }

const scope = self as unknown as { onmessage: ((e: MessageEvent<EngineRequest>) => void) | null; postMessage(m: EngineMessage): void }

scope.onmessage = (e) => {
  const req = e.data
  if (req.type !== 'run') return
  try {
    const result = runCompare(req.old, req.new, req.opts, { progress: (phase, done, total) => scope.postMessage({ type: 'progress', phase, done, total }) })
    scope.postMessage({ type: 'result', result })
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
