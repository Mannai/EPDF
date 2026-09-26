import { PDFDocument } from 'pdf-lib'
import { buildPageText } from '@shared/pagetext'
import type { FromWorker, ToWorker } from './protocol'

/**
 * The page text worker: parses documents with pdf-lib (once per document version) and builds page text models on
 * request, so large documents never block the UI thread. Keeps the few most recently used documents.
 */

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(m: FromWorker, transfer?: Transferable[]): void
}
const MAX_DOCS = 3
const docs = new Map<string, Promise<PDFDocument>>()

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer)
}

scope.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data
  if (msg.type === 'open') {
    const p = PDFDocument.load(msg.bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false })
    docs.delete(msg.key)
    docs.set(msg.key, p)
    while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value as string)
    try {
      const pdf = await p
      post({ type: 'opened', key: msg.key, ok: true, pages: pdf.getPageCount() })
    } catch (e) {
      docs.delete(msg.key)
      post({ type: 'opened', key: msg.key, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  if (msg.type === 'close') {
    docs.delete(msg.key)
    return
  }
  const t0 = performance.now()
  try {
    const d = docs.get(msg.key)
    if (!d) throw new Error('document not open')
    const pdf = await d
    const model = buildPageText(pdf, msg.pageIndex)
    post({ type: 'page', id: msg.id, model, ms: performance.now() - t0 }, [model.charQuad.buffer, model.quads.buffer])
  } catch (e) {
    post({ type: 'page', id: msg.id, model: null, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 })
  }
}
