import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { buildPageText, modelIsUsable, needsPageModel, type PageTextModel } from '@shared/pagetext'
import type { FromWorker, ToWorker } from './protocol'
import PageTextWorker from './worker?worker'

/**
 * The text of a page as the viewer, search and the other features use it.
 *
 * Pages whose PDF.js text contains right-to-left or complex-script characters are read with the page text model
 * (`src/shared/pagetext`, built in a Web Worker from the document bytes) when that model reads them well; every other
 * page keeps PDF.js's own text (fast, and unchanged for Latin documents). Both kinds carry the page text as a string;
 * the model kind also has per-character geometry.
 */

export interface PdfjsItems {
  /** Text of the page items joined (NBSP -> space), '\n' after items that end a line. */
  text: string
  /** Start offset of each text item within `text`; parallel to PDF.js's text layer items. */
  itemStarts: number[]
}

export type PageText = ({ kind: 'pdfjs' } & PdfjsItems) | { kind: 'model'; text: string; model: PageTextModel; pdfjs: PdfjsItems }

type ItemLike = { str?: string; hasEOL?: boolean }

const NBSP = / /g

export function itemsText(items: readonly ItemLike[]): PdfjsItems {
  let text = ''
  const itemStarts: number[] = []
  for (const it of items) {
    // Marked-content markers have no `str`; the text layer skips them too, so indices stay aligned.
    if (typeof it.str !== 'string') continue
    itemStarts.push(text.length)
    text += it.str.replace(NBSP, ' ')
    if (it.hasEOL) text += '\n'
  }
  return { text, itemStarts }
}

// ---- worker ---------------------------------------------------------------------------------------------------

let worker: Worker | null = null
let failedWorker = false
let nextId = 0
const waiting = new Map<number, (m: Extract<FromWorker, { type: 'page' }>) => void>()
const opening = new Map<string, (ok: boolean) => void>()

function getWorker(): Worker | null {
  if (worker || failedWorker) return worker
  if (typeof Worker === 'undefined') {
    failedWorker = true
    return null
  }
  try {
    worker = new PageTextWorker()
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'opened') {
        opening.get(m.key)?.(m.ok)
        opening.delete(m.key)
      } else {
        waiting.get(m.id)?.(m)
        waiting.delete(m.id)
      }
    }
    worker.onerror = () => {
      for (const r of opening.values()) r(false)
      for (const r of waiting.values()) r({ type: 'page', id: -1, model: null, error: 'worker failed', ms: 0 })
      opening.clear()
      waiting.clear()
    }
  } catch {
    failedWorker = true
    worker = null
  }
  return worker
}

const send = (w: Worker, msg: ToWorker, transfer: Transferable[] = []): void => w.postMessage(msg, transfer)

// ---- per-document state --------------------------------------------------------------------------------------

interface DocState {
  key: string
  open: Promise<boolean> | null
  /** Without a worker (Node tests, a worker that failed to start): the document parsed in this thread. */
  local: Promise<PDFDocument | null> | null
  models: Map<number, Promise<PageTextModel | null>>
  pages: Map<number, Promise<PageText>>
  pdfjs: Map<number, Promise<PdfjsItems>>
}

let docCounter = 0
const states = new WeakMap<PDFDocumentProxy, DocState>()
const MAX_PAGES = 300

function stateOf(doc: PDFDocumentProxy): DocState {
  let s = states.get(doc)
  if (!s) states.set(doc, (s = { key: `d${++docCounter}`, open: null, local: null, models: new Map(), pages: new Map(), pdfjs: new Map() }))
  return s
}

const bound = <K, V>(m: Map<K, V>): void => {
  while (m.size > MAX_PAGES) m.delete(m.keys().next().value as K)
}

function openDoc(doc: PDFDocumentProxy, s: DocState): Promise<boolean> {
  s.open ??= (async () => {
    const w = getWorker()
    if (!w) return false
    let bytes: Uint8Array
    try {
      bytes = await doc.getData() // the exact bytes this PDF.js document shows (a copy)
    } catch {
      return false
    }
    return new Promise<boolean>((resolve) => {
      opening.set(s.key, resolve)
      send(w, { type: 'open', key: s.key, bytes }, [bytes.buffer])
    })
  })()
  return s.open
}

/** The page text model of page `pageNo` (1-based), or null when the document cannot be read that way (encrypted, damaged). */
export function pageModel(doc: PDFDocumentProxy, pageNo: number): Promise<PageTextModel | null> {
  const s = stateOf(doc)
  let p = s.models.get(pageNo)
  if (!p) {
    p = (async () => {
      if (!getWorker()) {
        s.local ??= doc
          .getData()
          .then((bytes) => PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }))
          .catch(() => null)
        const pdf = await s.local
        if (!pdf || pageNo > pdf.getPageCount()) return null
        try {
          return buildPageText(pdf, pageNo - 1)
        } catch {
          return null
        }
      }
      if (!(await openDoc(doc, s))) return null
      const w = getWorker()
      if (!w) return null
      const id = ++nextId
      const reply = await new Promise<Extract<FromWorker, { type: 'page' }>>((resolve) => {
        waiting.set(id, resolve)
        send(w, { type: 'page', key: s.key, id, pageIndex: pageNo - 1 })
      })
      if (!reply.model && reply.error) console.warn(`Page text model of page ${pageNo}: ${reply.error}`)
      return reply.model
    })()
    s.models.set(pageNo, p)
    bound(s.models)
  }
  return p
}

/** PDF.js's own text of a page (cached; filled from the text layer's content when the page was rendered). */
export function pdfjsText(doc: PDFDocumentProxy, pageNo: number): Promise<PdfjsItems> {
  const s = stateOf(doc)
  let p = s.pdfjs.get(pageNo)
  if (!p) {
    p = (async () => {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      page.cleanup()
      return itemsText(content.items as ItemLike[])
    })()
    s.pdfjs.set(pageNo, p)
    p.catch(() => s.pdfjs.delete(pageNo))
    bound(s.pdfjs)
  }
  return p
}

/** Stores the text content a caller already has (the viewer's text layer) so it is not read twice. */
export function rememberPdfjs(doc: PDFDocumentProxy, pageNo: number, items: readonly ItemLike[]): PdfjsItems {
  const s = stateOf(doc)
  const pt = itemsText(items)
  if (!s.pdfjs.has(pageNo)) {
    s.pdfjs.set(pageNo, Promise.resolve(pt))
    bound(s.pdfjs)
  }
  return pt
}

/** Set to false (tests, diagnostics) to read every page with PDF.js only. */
let enabled = true
export const setPageModelEnabled = (on: boolean): void => {
  enabled = on
}

/**
 * The text of a page for display, selection and search: the page text model for pages with right-to-left or
 * complex-script text that it reads well, PDF.js's text otherwise. The same page always gets the same kind.
 */
export function pageText(doc: PDFDocumentProxy, pageNo: number): Promise<PageText> {
  const s = stateOf(doc)
  let p = s.pages.get(pageNo)
  if (!p) {
    p = (async (): Promise<PageText> => {
      const pj = await pdfjsText(doc, pageNo)
      if (!enabled || !needsPageModel(pj.text)) return { kind: 'pdfjs', ...pj }
      const model = await pageModel(doc, pageNo).catch(() => null)
      if (model && modelIsUsable(model, pj.text)) return { kind: 'model', text: model.text, model, pdfjs: pj }
      return { kind: 'pdfjs', ...pj }
    })()
    s.pages.set(pageNo, p)
    p.catch(() => s.pages.delete(pageNo))
    bound(s.pages)
  }
  return p
}

// ---- test and diagnostics hook (no UI) ------------------------------------------------------------------------
;(globalThis as unknown as { __epdfPageText?: unknown }).__epdfPageText = {
  pageText,
  pageModel,
  setEnabled: setPageModelEnabled
}
