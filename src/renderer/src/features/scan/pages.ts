import { fullQuad, orderQuad, rotateQuadQuarterTurns, type Quad } from '@shared/features/scan/geometry'
import { newSessionId, useScan, type ScanPage, type ScanSource } from './store'
import { scanWorker } from './worker/client'
import type { Op, PageParams, WorkerRequests, WorkerResponses } from './worker/protocol'

/** Page list actions and preview rendering (latest request wins; one in flight per page and kind). */

const get = (): ReturnType<typeof useScan.getState> => useScan.getState()

let counter = 0
const newPageId = (): string => `p${Date.now().toString(36)}${(counter++).toString(36)}`

export const THUMB_SIDE = 180
export const VIEW_SIDE = 1000
export const RESULT_SIDE = 1000

export function paramsFor(page: ScanPage): PageParams {
  const o = get().options
  return { quad: page.quad, rotation: page.rotation, preset: o.preset, straighten: o.straighten, paper: o.paper, sourceDpi: page.dpi }
}

/** Calls the worker for a page; if the worker lost the picture (it was restarted after Cancel) it is loaded again first. */
export async function callPrepared<O extends Exclude<Op, 'prepare' | 'detectFrame' | 'assemble' | 'clear' | 'drop'>>(page: ScanPage, op: O, payload: WorkerRequests[O]): Promise<WorkerResponses[O]> {
  try {
    return await scanWorker.call(op, payload)
  } catch (err) {
    if (!(err instanceof Error) || !/not loaded any more/.test(err.message)) throw err
    await scanWorker.call('prepare', { id: page.id, blob: page.blob, detect: false })
    return scanWorker.call(op, payload)
  }
}

export function announce(text: string): void {
  useScan.setState({ announce: text })
}

// ---- adding / removing / ordering ---------------------------------------------------------------------------------

/** Adds a picture (from a scanner, camera or phone) and prepares it in the background. Returns the new page id. */
export function addImage(blob: Blob, source: ScanSource, dpi?: number): string {
  const id = newPageId()
  const page: ScanPage = { id, source, blob, dpi, width: 0, height: 0, quad: null, rotation: 0, state: 'preparing' }
  useScan.setState((s) => ({ pages: [...s.pages, page], selectedId: s.selectedId ?? id }))
  void (async () => {
    try {
      const r = await scanWorker.call('prepare', { id, blob, detect: source !== 'scanner' })
      let quad: Quad | null = null
      let edgesNotFound = false
      if (source !== 'scanner') {
        quad = r.quad ?? fullQuad(0.03)
        edgesNotFound = !r.quad
      }
      get().patchPage(id, { state: 'ready', width: r.width, height: r.height, quad, edgesNotFound })
      void renderThumb(id)
      if (get().selectedId === id) selectPage(id)
      announce(`Page ${get().pages.findIndex((p) => p.id === id) + 1} added.`)
    } catch (err) {
      get().patchPage(id, { state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  })()
  return id
}

export function selectPage(id: string | null): void {
  useScan.setState({ selectedId: id })
  if (id && get().step === 'adjust') {
    void renderView(id)
    void renderResult(id)
  }
}

function freePreviews(id: string): void {
  const p = get().previews[id]
  p?.thumb?.close()
  p?.view?.close()
  p?.result?.close()
  useScan.setState((s) => {
    const { [id]: _gone, ...rest } = s.previews
    return { previews: rest }
  })
  void scanWorker.call('drop', { id }).catch(() => undefined)
}

export function removePage(id: string): void {
  const s = get()
  const i = s.pages.findIndex((p) => p.id === id)
  if (i < 0) return
  const rest = s.pages.filter((p) => p.id !== id)
  const next = s.selectedId === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : s.selectedId
  freePreviews(id)
  useScan.setState({ pages: rest })
  selectPage(next)
  announce(`Page ${i + 1} deleted. ${rest.length} ${rest.length === 1 ? 'page' : 'pages'} left.`)
  if (rest.length === 0 && get().step !== 'capture') useScan.setState({ step: 'capture' })
}

export function movePage(id: string, delta: -1 | 1): void {
  const pages = [...get().pages]
  const i = pages.findIndex((p) => p.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= pages.length) return
  ;[pages[i], pages[j]] = [pages[j], pages[i]]
  useScan.setState({ pages })
  announce(`Page moved to position ${j + 1}.`)
}

export function clearAllPages(): void {
  for (const p of get().pages) freePreviews(p.id)
  useScan.setState({ pages: [], selectedId: null, previews: {} })
  void scanWorker.call('clear', {}).catch(() => undefined)
}

// ---- editing ---------------------------------------------------------------------------------------------------------

export function setQuad(id: string, quad: Quad | null, opts: { render?: boolean } = {}): void {
  get().patchPage(id, { quad, edgesNotFound: false })
  void renderThumb(id)
  if (opts.render !== false) void renderResult(id)
}

export function rotatePage(id: string, turns: 1 | -1): void {
  const p = get().pages.find((x) => x.id === id)
  if (!p) return
  const rotation = (((p.rotation + turns) % 4) + 4) % 4
  // the crop follows the picture; a crop that covers everything keeps covering everything
  const quad = p.quad ? rotateQuadQuarterTurns(p.quad, turns === 1 ? 1 : 3) : null
  get().patchPage(id, { rotation, quad })
  void renderView(id)
  void renderThumb(id)
  void renderResult(id)
}

export async function autoDetect(id: string): Promise<boolean> {
  const p = get().pages.find((x) => x.id === id)
  if (!p) return false
  const r = await callPrepared(p, 'detect', { id, rotation: p.rotation })
  if (r.quad) {
    setQuad(id, orderQuad(r.quad))
    announce('Page edges found.')
    return true
  }
  get().patchPage(id, { edgesNotFound: true })
  announce('The page edges could not be found. Drag the corners to the corners of the page.')
  return false
}

export function resetQuad(id: string): void {
  setQuad(id, null)
}

// ---- rendering previews -----------------------------------------------------------------------------------------------

const inflight = new Set<string>()
const dirty = new Set<string>()

async function runLatest(kind: 'thumb' | 'view' | 'result', id: string, work: () => Promise<void>): Promise<void> {
  const key = `${kind}:${id}`
  if (inflight.has(key)) {
    dirty.add(key)
    return
  }
  inflight.add(key)
  try {
    do {
      dirty.delete(key)
      await work()
    } while (dirty.has(key))
  } catch (err) {
    if (!(err instanceof Error && err.message === 'Cancelled')) {
      const page = get().pages.find((p) => p.id === id)
      if (page && kind !== 'thumb') get().patchPage(id, { error: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    inflight.delete(key)
  }
}

export function renderThumb(id: string): Promise<void> {
  return runLatest('thumb', id, async () => {
    const page = get().pages.find((p) => p.id === id)
    if (!page || page.state !== 'ready') return
    const r = await callPrepared(page, 'preview', { id, params: paramsFor(page), maxSide: THUMB_SIDE })
    if (!get().pages.some((p) => p.id === id)) return r.bitmap.close()
    get().setPreviews(id, { thumb: r.bitmap })
  })
}

export function renderView(id: string): Promise<void> {
  return runLatest('view', id, async () => {
    const page = get().pages.find((p) => p.id === id)
    if (!page || page.state !== 'ready') return
    const r = await callPrepared(page, 'view', { id, rotation: page.rotation, maxSide: VIEW_SIDE })
    if (!get().pages.some((p) => p.id === id)) return r.bitmap.close()
    get().setPreviews(id, { view: r.bitmap })
  })
}

export function renderResult(id: string): Promise<void> {
  return runLatest('result', id, async () => {
    const page = get().pages.find((p) => p.id === id)
    if (!page || page.state !== 'ready') return
    const r = await callPrepared(page, 'preview', { id, params: paramsFor(page), maxSide: RESULT_SIDE })
    if (!get().pages.some((p) => p.id === id)) return r.bitmap.close()
    get().setPreviews(id, { result: r.bitmap, resultInfo: { width: r.width, height: r.height, pageWidthPt: r.pageWidthPt, pageHeightPt: r.pageHeightPt, dpi: r.dpi, skewDegrees: r.skewDegrees } })
  })
}

/** After a change to the enhancement options: every thumbnail (and the open page's result) is drawn again. */
export function rerenderAll(): void {
  for (const p of get().pages) void renderThumb(p.id)
  const sel = get().selectedId
  if (sel && get().step === 'adjust') void renderResult(sel)
}

// ---- dialog lifecycle -------------------------------------------------------------------------------------------------

export async function openScanDialog(): Promise<void> {
  const s = get()
  if (s.open) return
  const sessionId = newSessionId()
  try {
    await window.epdf.call('scan:session', { sessionId })
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
  useScan.setState({ open: true, step: 'capture', tab: s.tab, sessionId, error: null, busy: null, announce: '' })
}

export async function closeScanDialog(): Promise<void> {
  const { sessionId } = get()
  clearAllPages()
  scanWorker.terminate()
  useScan.setState({ open: false, step: 'capture', busy: null, error: null, sessionId: '' })
  if (sessionId) await window.epdf.call('scan:endSession', { sessionId }).catch(() => undefined)
}
