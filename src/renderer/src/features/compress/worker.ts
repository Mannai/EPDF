import { browserCodec } from './browserCodec'
import { analyzePdf } from './pdf/analyze'
import { compressPdf } from './pdf/compress'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * The compression Web Worker: all PDF parsing, pixel work and serialising happens here so the app never freezes.
 * Cancelling from the UI simply terminates the worker.
 */

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

scope.onmessage = (e) => {
  const req = e.data
  void (async () => {
    try {
      if (req.type === 'analyze') {
        scope.postMessage({ type: 'analysis', id: req.id, analysis: await analyzePdf(req.bytes) })
      } else if (req.type === 'compress') {
        let last = 0
        const result = await compressPdf(req.bytes, req.options, {
          codec: browserCodec,
          onProgress: (fraction, label) => {
            const now = Date.now()
            if (now - last < 60 && fraction < 1) return
            last = now
            scope.postMessage({ type: 'progress', id: req.id, fraction, label })
          }
        })
        // When the original is kept there is nothing to send back (avoids copying a 100 MB file for nothing).
        const out = result.kept === 'result' ? result : { ...result, bytes: new Uint8Array(0) }
        scope.postMessage({ type: 'result', id: req.id, result: out }, result.kept === 'result' ? [out.bytes.buffer as ArrayBuffer] : [])
      }
    } catch (err) {
      scope.postMessage({ type: 'error', id: req.id, message: errText(err) })
    }
  })()
}
