import { BrowserWindow, session, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { buildPrintHtml, printCsp } from '../../../shared/features/print/html'
import type { PrintOutcome } from '../../../shared/features/print'
import { APP_SCHEME } from '../../services/protocol'
import { atomicWrite } from '../../services/fileService'

/**
 * Printing. The renderer rasterizes the pages to print (PDF.js, at print resolution) and hands them over one
 * by one; this module lays them out in an inert HTML document (one sheet per page, no script) that lives only
 * in memory, and prints it with Chromium's print pipeline:
 *
 *   - normally `webContents.print()`, which shows the operating system's print dialog;
 *   - with `EPDF_PRINT_TO_FILE=<path>` (a test hook) `webContents.printToPDF()` writes the result to that
 *     file instead, so automated tests can inspect exactly what would be sent to the printer.
 *
 * The hidden window uses its own non-persistent session: no preload, no JavaScript, no permissions, and every
 * request except the job's own images is cancelled. Nothing is written to disk, so nothing can be left behind.
 */

interface PageData {
  jpeg: Buffer
  widthPt: number
  heightPt: number
}

interface PrintJob {
  id: string
  ownerWindowId: number | undefined
  pageCount: number
  pages: Map<number, PageData>
  bytes: number
  html?: string
  win?: BrowserWindow
}

const MAX_JOBS = 3
const MAX_JOB_BYTES = 2 * 1024 * 1024 * 1024
const jobs = new Map<string, PrintJob>()
let printSession: Session | null = null

const TEST_HOOK = 'EPDF_PRINT_TO_FILE'

function getPrintSession(): Session {
  if (printSession) return printSession
  const ses = session.fromPartition('epdf-print') // no "persist:" prefix: in memory only
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, cb) => {
    // Only the job documents themselves may load; nothing else (no network, no files, no data URLs).
    cb({ cancel: !details.url.startsWith(`${APP_SCHEME}://print-`) })
  })
  ses.protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    const job = jobs.get(url.host)
    if (!job || request.method !== 'GET') return new Response('Not found', { status: 404 })
    const headers = { 'Cache-Control': 'no-store' }
    if (url.pathname === '/index.html') {
      return new Response(job.html ?? '', {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': printCsp(`${APP_SCHEME}://${job.id}`) }
      })
    }
    const m = /^\/(\d+)\.jpg$/.exec(url.pathname)
    const page = m ? job.pages.get(Number(m[1])) : undefined
    if (!page) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(page.jpeg), { headers: { ...headers, 'Content-Type': 'image/jpeg' } })
  })
  printSession = ses
  return ses
}

export function beginJob(pageCount: number, ownerWindowId: number | undefined): string {
  if (jobs.size >= MAX_JOBS) throw new Error('Too many print jobs are being prepared. Wait for one to finish.')
  const id = `print-${randomUUID()}`
  jobs.set(id, { id, ownerWindowId, pageCount, pages: new Map(), bytes: 0 })
  return id
}

function jobFor(id: string, ownerWindowId: number | undefined): PrintJob {
  const job = jobs.get(id)
  if (!job || job.ownerWindowId !== ownerWindowId) throw new Error('That print job no longer exists.')
  return job
}

export function addPage(id: string, owner: number | undefined, index: number, jpeg: Uint8Array, widthPt: number, heightPt: number): void {
  const job = jobFor(id, owner)
  if (index >= job.pageCount) throw new Error('Page number out of range for this print job.')
  const prev = job.pages.get(index)
  if (prev) job.bytes -= prev.jpeg.length
  job.bytes += jpeg.length
  if (job.bytes > MAX_JOB_BYTES) {
    cancelJob(id, owner)
    throw new Error('This print job is too large to prepare in one go. Choose a smaller page range or a lower print quality.')
  }
  job.pages.set(index, { jpeg: Buffer.from(jpeg), widthPt, heightPt })
}

/** Drops a job and everything held for it. Safe to call for unknown ids. */
export function cancelJob(id: string, owner: number | undefined): void {
  const job = jobs.get(id)
  if (!job || job.ownerWindowId !== owner) return
  if (job.win && !job.win.isDestroyed()) job.win.destroy()
  jobs.delete(id)
}

/** Drops every job started by a window that closed. */
export function cancelJobsOf(ownerWindowId: number): void {
  for (const job of [...jobs.values()]) if (job.ownerWindowId === ownerWindowId) cancelJob(job.id, ownerWindowId)
}

export interface RunRequest {
  copies: number
  scaling: 'fit' | 'actual' | 'custom'
  percent: number
  orientation: 'portrait' | 'landscape'
  title: string
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export async function runJob(id: string, owner: number | undefined, req: RunRequest): Promise<PrintOutcome> {
  const job = jobFor(id, owner)
  if (job.win) throw new Error('This print job is already running.')
  const list = Array.from({ length: job.pageCount }, (_, i) => job.pages.get(i))
  if (list.some((p) => !p)) throw new Error('Some pages were not prepared. Try printing again.')
  const pages = list as PageData[]
  const hook = process.env[TEST_HOOK]
  job.html = buildPrintHtml(
    pages.map((p) => ({ widthPt: p.widthPt, heightPt: p.heightPt })),
    {
      origin: `${APP_SCHEME}://${job.id}`,
      scaling: req.scaling,
      percent: req.percent,
      copies: req.copies,
      target: hook ? 'file' : 'native',
      title: escapeHtml(req.title)
    }
  )

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: {
      session: getPrintSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false, // the print document is static; nothing in it may ever run
      webSecurity: true,
      spellcheck: false
    }
  })
  job.win = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  try {
    await win.loadURL(`${APP_SCHEME}://${job.id}/index.html`) // resolves once every page image has loaded
    if (win.isDestroyed()) return { status: 'cancelled' }
    const landscape = req.orientation === 'landscape'
    if (hook) {
      const pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        landscape,
        printBackground: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      await atomicWrite(hook, pdf)
      return { status: 'saved-to-file' }
    }
    return await new Promise<PrintOutcome>((resolve) => {
      win.webContents.print(
        { silent: false, printBackground: true, landscape, copies: 1, margins: { marginType: 'printableArea' } },
        (success, reason) => {
          if (success) resolve({ status: 'printed' })
          else if (/cancel/i.test(reason)) resolve({ status: 'cancelled' })
          else resolve({ status: 'failed', message: reason || 'The document could not be printed.' })
        }
      )
    })
  } catch (err) {
    if (win.isDestroyed()) return { status: 'cancelled' }
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    jobs.delete(id)
  }
}
