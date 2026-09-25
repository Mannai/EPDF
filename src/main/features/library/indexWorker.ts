import { parentPort } from 'node:worker_threads'
import { readWindowsAttributes } from './attributes'
import { extractText, hashFile } from './extract'
import { scanFolder } from './scanner'
import type { WorkerReply, WorkerRequest } from './engine'

/**
 * The index worker thread: folder scans and text extraction. It is long-lived for the duration of one sync job
 * (loading pdf.js costs ~100 ms, so files are fed to one worker instead of spawning one per file). All the
 * heavy lifting is here; the main thread only writes results to SQLite.
 */

if (!parentPort) throw new Error('indexWorker must run in a worker thread')
const port = parentPort
const aborts = new Map<number, AbortController>()
const post = (m: WorkerReply): void => port.postMessage(m)

port.on('message', (msg: WorkerRequest) => {
  if (msg.op === 'abort') {
    aborts.get(msg.target)?.abort()
    return
  }
  void (async () => {
    try {
      if (msg.op === 'scan') {
        const ctl = new AbortController()
        aborts.set(msg.id, ctl)
        try {
          const value = await scanFolder(msg.root, {
            ...msg.options,
            signal: ctl.signal,
            readAttributes: readWindowsAttributes,
            onProgress: (found, dir) => post({ id: msg.id, type: 'progress', found, dir })
          })
          post({ id: msg.id, type: 'result', value })
        } finally {
          aborts.delete(msg.id)
        }
      } else if (msg.op === 'extract') {
        post({ id: msg.id, type: 'result', value: await extractText(msg.request) })
      } else if (msg.op === 'hash') {
        post({ id: msg.id, type: 'result', value: await hashFile(msg.path) })
      }
    } catch (err) {
      post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })()
})
