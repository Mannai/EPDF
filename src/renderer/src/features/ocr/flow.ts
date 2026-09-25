import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  LOW_CONFIDENCE,
  OCR_CHANNELS,
  OCR_JOBS,
  type BeginResponse,
  type OcrLine,
  type OcrPageResult,
  type OcrPrefs
} from '@shared/features/ocr'
import { currentBytes, editPdf, ensureEditable, useEdits } from '../../edit/session'
import { JobCancelledError, startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { applyOcrLayers, type PageOcr } from './pdf/apply'
import { openForOcr, pageHasText, renderPage } from './render'

/**
 * The OCR pipeline in the renderer. PDF.js draws each page (one at a time, with a few in flight so the
 * recognizer never waits), main recognizes it in worker threads (`ocr:run` job: progress + Cancel in the jobs
 * tray) and the words come back here. When every page is done ONE edit adds all the text layers, so the whole
 * run is a single undo step, "Recognize text".
 */

export interface OcrRunOptions {
  docId: string
  /** 0-based pages to recognize. */
  pages: number[]
  languages: string[]
  prefs: Pick<OcrPrefs, 'dpi' | 'contrast' | 'deskew' | 'force'>
  /** No success toast (callers such as Scanning show their own feedback). Errors are still reported. */
  silent?: boolean
}

export interface OcrOutcome {
  status: 'done' | 'cancelled' | 'failed' | 'nothing'
  pages: number
  words: number
  confidence: number
  skippedWithText: number
  failedPages: number[]
  message?: string
}

const running = new Set<string>()
export const isOcrRunning = (docId: string): boolean => running.has(docId)

const empty = (status: OcrOutcome['status'], message?: string): OcrOutcome => ({ status, pages: 0, words: 0, confidence: 0, skippedWithText: 0, failedPages: [], message })

/** An error's message without Electron's "Error invoking remote method ..." wrapper. */
export const clean = (err: unknown): string => errorMessage(err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export function summaryMessage(o: Pick<OcrOutcome, 'pages' | 'words' | 'confidence' | 'skippedWithText' | 'failedPages'>): string {
  let m = `Recognized ${plural(o.pages, 'page')}, ${plural(o.words, 'word')}, average confidence ${Math.round(o.confidence)}%.`
  if (o.skippedWithText) m += ` ${plural(o.skippedWithText, 'page')} already had text and ${o.skippedWithText === 1 ? 'was' : 'were'} skipped.`
  if (o.failedPages.length) m += ` ${plural(o.failedPages.length, 'page')} could not be read.`
  return m
}

/** Runs recognition for `opts.pages` of a document and applies the result as one undo step. Never throws. */
export async function runOcr(opts: OcrRunOptions): Promise<OcrOutcome> {
  const { docId } = opts
  if (running.has(docId)) {
    notify('info', 'Text recognition is already running for this document.')
    return empty('failed', 'already running')
  }
  running.add(docId)
  let pdfDoc: PDFDocumentProxy | null = null
  let sessionId: string | null = null
  try {
    if (!(await ensureEditable(docId))) {
      const m = 'This document is password protected, so text cannot be added to it. Unlock it (or remove the protection) first.'
      notify('error', m)
      return empty('cancelled', m)
    }
    const bytes = await currentBytes(docId)
    const editVersion = useEdits.getState()[docId]?.version ?? 0
    try {
      pdfDoc = await openForOcr(bytes)
    } catch (err) {
      const m = `This document could not be read for text recognition: ${errorMessage(err)}`
      notify('error', m)
      return empty('failed', m)
    }

    // Skip pages that already carry real text, unless the user asked to force them.
    const todo: number[] = []
    let skippedWithText = 0
    for (const i of opts.pages) {
      if (i < 0 || i >= pdfDoc.numPages) continue
      if (!opts.prefs.force && (await pageHasText(await pdfDoc.getPage(i + 1)))) skippedWithText++
      else todo.push(i)
    }
    if (todo.length === 0) {
      const m = skippedWithText
        ? `${skippedWithText === 1 ? 'That page already contains' : 'Those pages already contain'} text. Turn on “Recognize pages that already contain text” to run it again.`
        : 'There are no pages to recognize.'
      if (!opts.silent || skippedWithText === 0) notify('info', m)
      return { ...empty('nothing', m), skippedWithText }
    }

    let begin: BeginResponse
    try {
      begin = await window.epdf.call<BeginResponse>(OCR_CHANNELS.begin, { languages: opts.languages, total: todo.length })
    } catch (err) {
      const m = clean(err)
      notify('error', m)
      return empty('failed', m)
    }
    sessionId = begin.sessionId

    const job = startJob<{ recognized: number }>(OCR_JOBS.run, { sessionId })
    const state: { error: Error | null } = { error: null }
    void job.promise.catch((e: Error) => {
      state.error ??= e
    })

    const results = new Map<number, OcrPageResult>()
    const geometry = new Map<number, PageOcr>()
    const inflight: Promise<void>[] = []
    const depth = Math.max(1, begin.parallel) + 1

    const send = async (pageIndex: number): Promise<void> => {
      let rendered: Awaited<ReturnType<typeof renderPage>>
      try {
        const page = await pdfDoc!.getPage(pageIndex + 1)
        rendered = await renderPage(page, opts.prefs)
      } catch (err) {
        // One page that PDF.js cannot draw must not sink the whole run.
        results.set(pageIndex, { ok: false, error: `Page ${pageIndex + 1} could not be drawn: ${clean(err)}` })
        return
      }
      const sid = sessionId!
      const r = await window.epdf.call<OcrPageResult>(OCR_CHANNELS.addPage, { sessionId: sid, index: pageIndex, image: rendered.png })
      results.set(pageIndex, r)
      geometry.set(pageIndex, { pageIndex, geometry: rendered.geometry, lines: r.ok ? r.lines : [], deskew: rendered.deskew })
    }

    try {
      for (const i of todo) {
        if (state.error) break
        const p = send(i)
        // A failure here (job cancelled, engine could not start) surfaces through `state.error` / the rejected call.
        p.catch(() => undefined)
        inflight.push(p)
        if (inflight.length >= depth) await inflight.shift()!
        await new Promise((r) => setTimeout(r, 0)) // let the UI paint between pages
      }
      await Promise.all(inflight)
      // Nothing more will be sent (pages that could not be drawn never arrive): let the job finish.
      if (!state.error) await window.epdf.call(OCR_CHANNELS.end, { sessionId })
    } catch (err) {
      state.error ??= err instanceof Error ? err : new Error(String(err))
    }

    if (state.error) {
      job.cancel()
      const e = state.error
      if (e instanceof JobCancelledError || clean(e) === 'Cancelled') {
        notify('info', 'Text recognition was cancelled. The document was not changed.')
        return { ...empty('cancelled', 'Cancelled'), skippedWithText }
      }
      const m = clean(e)
      notify('error', `Text recognition failed: ${m}`)
      return { ...empty('failed', m), skippedWithText }
    }
    await job.promise.catch(() => undefined)

    const failedPages: number[] = []
    const good: PageOcr[] = []
    let firstError = ''
    for (const i of todo) {
      const r = results.get(i)
      if (r && r.ok) good.push(geometry.get(i)!)
      else {
        failedPages.push(i)
        if (r && !r.ok && !firstError) firstError = r.error
      }
    }
    if (good.length === 0) {
      const m = `Text recognition failed: ${firstError || 'no page could be read.'}`
      notify('error', m)
      return { ...empty('failed', m), skippedWithText, failedPages }
    }

    // The document must still be what was recognized (no edit, undo or page move while the job ran).
    if ((useEdits.getState()[docId]?.version ?? 0) !== editVersion) {
      const m = 'The document was changed while text was being recognized, so the result was not added. Run text recognition again.'
      notify('error', m)
      return { ...empty('failed', m), skippedWithText, failedPages }
    }

    const applied: { value: ReturnType<typeof applyOcrLayers> | null } = { value: null }
    await editPdf(docId, 'Recognize text', (pdf) => {
      applied.value = applyOcrLayers(pdf, good)
      if (applied.value.pages.length === 0) throw new Error('No text was found on the selected pages.')
    })
    const a = applied.value!
    const outcome: OcrOutcome = {
      status: 'done',
      pages: a.pages.length,
      words: a.words,
      confidence: a.confidence,
      skippedWithText,
      failedPages: [...failedPages, ...a.skipped.map((s) => s.pageIndex)]
    }
    if (!opts.silent) notify('success', summaryMessage(outcome))
    if (a.skipped.length) notify('info', `${plural(a.skipped.length, 'page')} changed while text was being recognized and ${a.skipped.length === 1 ? 'was' : 'were'} left as they are.`)
    if (outcome.confidence < LOW_CONFIDENCE) {
      notify('info', `Warning: recognition confidence is low (${Math.round(outcome.confidence)}%). Check that the right language is selected, or try a higher resolution.`)
    }
    return outcome
  } catch (err) {
    const m = clean(err)
    notify('error', m.startsWith('No text was found') ? m : `Text recognition failed: ${m}`)
    return empty('failed', m)
  } finally {
    if (sessionId) void window.epdf.call(OCR_CHANNELS.end, { sessionId }).catch(() => undefined)
    if (pdfDoc) void pdfDoc.loadingTask.destroy().catch(() => undefined)
    running.delete(docId)
  }
}

export type { OcrLine }
