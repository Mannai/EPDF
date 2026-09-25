import { PDFDocument } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrPageResult } from '../../src/shared/features/ocr'
import { createScan1, createScan3 } from '../fixtures/ocr.mjs'

/**
 * The renderer half of a run, with the parts that need Electron/PDF.js/a real recognizer replaced by fakes: the
 * edit pipeline (backed by a real pdf-lib document), page rendering, the job runner and the IPC channels.
 */

const h = vi.hoisted(() => {
  const state = {
    editable: true,
    version: 0,
    bytes: new Uint8Array() as Uint8Array,
    textPages: new Set<number>(),
    /** pages (0-based) whose recognition result is a failure */
    failing: new Set<number>(),
    lines: [] as unknown[],
    jobOutcome: 'ok' as 'ok' | 'cancel' | 'fail',
    calls: [] as { channel: string; payload: unknown }[],
    edits: [] as { label: string; result: unknown }[],
    toasts: [] as { kind: string; message: string }[],
    renderThrows: new Set<number>(),
    onAddPage: undefined as undefined | (() => void)
  }
  class JobCancelledError extends Error {
    constructor() {
      super('Cancelled')
    }
  }
  return { state, JobCancelledError }
})

vi.mock('../../src/renderer/src/edit/session', () => ({
  ensureEditable: async () => h.state.editable,
  currentBytes: async () => h.state.bytes,
  useEdits: { getState: () => ({ doc1: { version: h.state.version } }) },
  editPdf: async (_id: string, label: string, fn: (pdf: PDFDocument) => void) => {
    const pdf = await PDFDocument.load(h.state.bytes)
    fn(pdf)
    h.state.bytes = await pdf.save()
    h.state.edits.push({ label, result: null })
  }
}))
vi.mock('../../src/renderer/src/state/jobs', () => ({
  JobCancelledError: h.JobCancelledError,
  startJob: (kind: string) => {
    h.state.calls.push({ channel: `job:${kind}`, payload: null })
    return {
      promise:
        h.state.jobOutcome === 'ok'
          ? Promise.resolve({ recognized: 1 })
          : h.state.jobOutcome === 'cancel'
            ? Promise.reject(new h.JobCancelledError())
            : Promise.reject(new Error('The German language data on disk is damaged or has been modified')),
      cancel: () => undefined
    }
  }
}))
vi.mock('../../src/renderer/src/state/notify', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  notify: (kind: string, message: string) => h.state.toasts.push({ kind, message })
}))
vi.mock('../../src/renderer/src/features/ocr/render', () => ({
  openForOcr: async (bytes: Uint8Array) => {
    const numPages = (await PDFDocument.load(bytes)).getPageCount()
    return { numPages, getPage: async (n: number) => ({ n }), loadingTask: { destroy: async () => undefined } }
  },
  pageHasText: async (p: { n: number }) => h.state.textPages.has(p.n - 1),
  renderPage: async (p: { n: number }) => {
    if (h.state.renderThrows.has(p.n - 1)) throw new Error('bad picture')
    return { png: new Uint8Array([1, 2, 3]), geometry: { view: [0, 0, 612, 792], rotate: 0, width: 1700, height: 2200 } }
  }
}))

const { runOcr, summaryMessage, isOcrRunning } = await import('../../src/renderer/src/features/ocr/flow')

const goodLines = (): unknown[] => [
  {
    words: [
      { text: 'Hello', x0: 200, y0: 270, x1: 340, y1: 307, conf: 90 },
      { text: 'world', x0: 360, y0: 270, x1: 500, y1: 307, conf: 80 }
    ],
    baseline: { x0: 200, y0: 306, x1: 500, y1: 306 },
    rowHeight: 41,
    bbox: { x0: 200, y0: 270, x1: 500, y1: 307 }
  }
]

beforeEach(() => {
  Object.assign(h.state, {
    editable: true,
    version: 0,
    textPages: new Set(),
    failing: new Set(),
    lines: goodLines(),
    jobOutcome: 'ok',
    calls: [],
    edits: [],
    toasts: [],
    renderThrows: new Set(),
    onAddPage: undefined
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    epdf: {
      call: async (channel: string, payload: { index?: number; languages?: string[]; total?: number }) => {
        h.state.calls.push({ channel, payload })
        if (channel === 'ocr:begin') {
          if (payload.languages?.includes('deu')) throw new Error("Error invoking remote method 'feature:call': Error: The German language data is not installed. Download it first.")
          return { sessionId: 'session-12345', parallel: 2 }
        }
        if (channel === 'ocr:addPage') {
          h.state.onAddPage?.()
          if (h.state.jobOutcome !== 'ok') throw new Error("Error invoking remote method 'feature:call': Error: Cancelled")
          return h.state.failing.has(payload.index!) ? ({ ok: false, error: 'This page picture could not be read.' } satisfies OcrPageResult) : { ok: true, lines: h.state.lines, confidence: 85, width: 1700, height: 2200 }
        }
        return undefined
      }
    }
  }
})

const run = (pages: number[], extra: Partial<Parameters<typeof runOcr>[0]> = {}): ReturnType<typeof runOcr> =>
  runOcr({ docId: 'doc1', pages, languages: ['eng'], prefs: { dpi: 300, contrast: true, deskew: true, force: false }, ...extra })

const channelsCalled = (): string[] => h.state.calls.map((c) => c.channel)

describe('runOcr', () => {
  it('recognizes pages, applies ONE edit "Recognize text" and reports what it did', async () => {
    h.state.bytes = await createScan3()
    const out = await run([0, 1, 2])
    expect(out).toMatchObject({ status: 'done', pages: 3, words: 6, skippedWithText: 0, failedPages: [] })
    expect(out.confidence).toBeCloseTo(85, 5)
    expect(h.state.edits).toEqual([{ label: 'Recognize text', result: null }]) // one undo step for three pages
    expect(channelsCalled().filter((c) => c === 'ocr:addPage')).toHaveLength(3)
    expect(channelsCalled()).toContain('ocr:begin')
    expect(channelsCalled()).toContain('ocr:end') // the session is always closed
    expect(h.state.toasts.at(-1)).toEqual({ kind: 'success', message: 'Recognized 3 pages, 6 words, average confidence 85%.' })
    expect(isOcrRunning('doc1')).toBe(false)
    const doc = await PDFDocument.load(h.state.bytes)
    expect(doc.getPageCount()).toBe(3)
  })

  it('asks main for the selected languages and pages only', async () => {
    h.state.bytes = await createScan3()
    await run([2], { languages: ['eng', 'fra'] })
    const begin = h.state.calls.find((c) => c.channel === 'ocr:begin')!
    expect(begin.payload).toEqual({ languages: ['eng', 'fra'], total: 1 })
    expect((h.state.calls.find((c) => c.channel === 'ocr:addPage')!.payload as { index: number }).index).toBe(2)
  })

  it('an encrypted document that is not unlocked is refused with an explanation, and nothing is started', async () => {
    h.state.bytes = await createScan1()
    h.state.editable = false
    const out = await run([0])
    expect(out.status).toBe('cancelled')
    expect(h.state.toasts).toEqual([{ kind: 'error', message: expect.stringMatching(/password protected/) }])
    expect(channelsCalled()).toEqual([])
    expect(h.state.edits).toEqual([])
  })

  it('once the password has been supplied (stubbed) the same document is recognized normally', async () => {
    h.state.bytes = await createScan1()
    h.state.editable = true // what ensureEditable returns after the decrypt hook returned the plaintext
    expect((await run([0])).status).toBe('done')
  })

  it('skips pages that already have text unless forced', async () => {
    h.state.bytes = await createScan3()
    h.state.textPages = new Set([0, 2])
    let out = await run([0, 1, 2])
    expect(out).toMatchObject({ status: 'done', pages: 1, skippedWithText: 2 })
    expect(h.state.toasts.at(-1)!.message).toBe('Recognized 1 page, 2 words, average confidence 85%. 2 pages already had text and were skipped.')
    h.state.calls.length = 0
    out = await run([0, 1, 2], { prefs: { dpi: 300, contrast: true, deskew: true, force: true } })
    expect(out).toMatchObject({ status: 'done', pages: 3, skippedWithText: 0 })
  })

  it('when every selected page has text it says so and changes nothing', async () => {
    h.state.bytes = await createScan3()
    h.state.textPages = new Set([0, 1, 2])
    const out = await run([0, 1])
    expect(out.status).toBe('nothing')
    expect(h.state.toasts.at(-1)!.message).toMatch(/Those pages already contain text/)
    expect(channelsCalled()).toEqual([])
    expect(h.state.edits).toEqual([])
    h.state.textPages = new Set([1])
    await run([1])
    expect(h.state.toasts.at(-1)!.message).toMatch(/That page already contains text/)
  })

  it('cancelling leaves the document as it was', async () => {
    h.state.bytes = await createScan3()
    h.state.jobOutcome = 'cancel'
    const before = h.state.bytes
    const out = await run([0, 1, 2])
    expect(out.status).toBe('cancelled')
    expect(h.state.edits).toEqual([])
    expect(h.state.bytes).toBe(before)
    expect(h.state.toasts.at(-1)).toEqual({ kind: 'info', message: 'Text recognition was cancelled. The document was not changed.' })
    expect(channelsCalled()).toContain('ocr:end')
    expect(isOcrRunning('doc1')).toBe(false)
  })

  it('a failing job (for example a damaged language file) is reported with its message', async () => {
    h.state.bytes = await createScan1()
    h.state.jobOutcome = 'fail'
    const out = await run([0])
    expect(out.status).toBe('failed')
    expect(h.state.toasts.at(-1)!.kind).toBe('error')
    expect(h.state.toasts.at(-1)!.message).toMatch(/damaged or has been modified/)
    expect(h.state.edits).toEqual([])
  })

  it('a language that is not installed is reported before any page is drawn', async () => {
    h.state.bytes = await createScan1()
    const out = await run([0], { languages: ['deu'] })
    expect(out.status).toBe('failed')
    expect(h.state.toasts.at(-1)).toEqual({ kind: 'error', message: 'The German language data is not installed. Download it first.' }) // no IPC wrapper text
    expect(channelsCalled()).toEqual(['ocr:begin'])
  })

  it('unreadable pages are counted and the others are still applied', async () => {
    h.state.bytes = await createScan3()
    h.state.failing = new Set([1])
    const out = await run([0, 1, 2])
    expect(out).toMatchObject({ status: 'done', pages: 2, failedPages: [1] })
    expect(h.state.toasts.at(-1)!.message).toBe('Recognized 2 pages, 4 words, average confidence 85%. 1 page could not be read.')
  })

  it('a page PDF.js cannot draw does not sink the run', async () => {
    h.state.bytes = await createScan3()
    h.state.renderThrows = new Set([0])
    const out = await run([0, 1, 2])
    expect(out).toMatchObject({ status: 'done', pages: 2, failedPages: [0] })
    expect(channelsCalled().filter((c) => c === 'ocr:addPage')).toHaveLength(2)
    expect(channelsCalled()).toContain('ocr:end') // the job is told nothing more will come
  })

  it('fails clearly when no page could be read at all', async () => {
    h.state.bytes = await createScan1()
    h.state.failing = new Set([0])
    const out = await run([0])
    expect(out.status).toBe('failed')
    expect(h.state.toasts.at(-1)).toEqual({ kind: 'error', message: 'Text recognition failed: This page picture could not be read.' })
    expect(h.state.edits).toEqual([])
  })

  it('says so when nothing was found on the pages', async () => {
    h.state.bytes = await createScan1()
    h.state.lines = []
    const out = await run([0])
    expect(out.status).toBe('failed')
    expect(h.state.toasts.at(-1)).toEqual({ kind: 'error', message: 'No text was found on the selected pages.' })
    expect(h.state.edits).toEqual([])
  })

  it('refuses to apply a result when the document was edited while it was being recognized', async () => {
    h.state.bytes = await createScan1()
    h.state.onAddPage = () => {
      h.state.version++ // the user did something (undo, another edit) during the run
    }
    const out = await run([0])
    expect(out.status).toBe('failed')
    expect(h.state.toasts.at(-1)!.message).toMatch(/document was changed while text was being recognized/)
    expect(h.state.edits).toEqual([])
  })

  it('warns when the mean confidence is low; silent runs skip the success message but keep the warning', async () => {
    h.state.bytes = await createScan1()
    h.state.lines = (goodLines() as { words: { conf: number }[] }[]).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, conf: 40 })) }))
    await run([0])
    expect(h.state.toasts.map((t) => t.kind)).toEqual(['success', 'info'])
    expect(h.state.toasts[1].message).toMatch(/confidence is low \(40%\)/)
    h.state.toasts.length = 0
    h.state.bytes = await createScan1()
    await run([0], { silent: true })
    expect(h.state.toasts.map((t) => t.kind)).toEqual(['info'])
    h.state.toasts.length = 0
    h.state.bytes = await createScan1()
    h.state.lines = goodLines()
    await run([0], { silent: true })
    expect(h.state.toasts).toEqual([]) // silent and fine: no toast at all
    expect(h.state.edits.at(-1)!.label).toBe('Recognize text')
  })

  it('does not start a second run on the same document while one is running', async () => {
    h.state.bytes = await createScan3()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const origCall = (globalThis as unknown as { window: { epdf: { call: (c: string, p: unknown) => Promise<unknown> } } }).window.epdf.call
    ;(globalThis as unknown as { window: { epdf: { call: (c: string, p: unknown) => Promise<unknown> } } }).window.epdf.call = async (c, p) => {
      if (c === 'ocr:addPage') await gate
      return origCall(c, p)
    }
    const first = run([0])
    await vi.waitFor(() => expect(isOcrRunning('doc1')).toBe(true))
    const second = await run([1])
    expect(second.status).toBe('failed')
    expect(h.state.toasts.at(-1)!.message).toMatch(/already running/)
    release()
    expect((await first).status).toBe('done')
    expect(isOcrRunning('doc1')).toBe(false)
  })
})

describe('summaryMessage', () => {
  it('uses singular and plural forms', () => {
    expect(summaryMessage({ pages: 1, words: 1, confidence: 99.6, skippedWithText: 0, failedPages: [] })).toBe('Recognized 1 page, 1 word, average confidence 100%.')
    expect(summaryMessage({ pages: 2, words: 30, confidence: 71.2, skippedWithText: 1, failedPages: [3] })).toBe(
      'Recognized 2 pages, 30 words, average confidence 71%. 1 page already had text and was skipped. 1 page could not be read.'
    )
  })
})
