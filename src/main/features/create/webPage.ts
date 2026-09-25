import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, session } from 'electron'
import { normalizeWebUrl } from '../../../shared/features/create'

/**
 * Renders a web page to PDF in a hidden, locked-down browser window: a private in-memory session (nothing is
 * shared with the app or kept afterwards), sandbox + context isolation, no preload, no Node, every permission
 * request denied, only http(s) requests, no pop-ups, no downloads, no navigation to other schemes, a hard timeout
 * and cancellation. The result is produced by Chromium's own printToPDF.
 */

export class WebPageError extends Error {}

export interface WebRenderOptions {
  url: string
  javascript: boolean
  signal: AbortSignal
  timeoutMs?: number
}

export interface WebRenderResult {
  bytes: Uint8Array
  status: number | null
  finalUrl: string
  title: string
}

const LOAD_ERRORS: Record<number, string> = {
  [-105]: 'That web address could not be found. Check the spelling and your internet connection.',
  [-137]: 'That web address could not be found. Check the spelling and your internet connection.',
  [-102]: 'The website refused the connection. Check the address and port.',
  [-106]: 'There is no internet connection.',
  [-109]: 'That website could not be reached.',
  [-118]: 'The website took too long to respond.',
  [-7]: 'The website took too long to respond.',
  [-101]: 'The connection to the website was reset.',
  [-100]: 'The connection to the website was closed.',
  [-324]: 'The website closed the connection without sending anything.',
  [-20]: 'This page tried to load something Epdf does not allow.'
}

export function describeLoadFailure(code: number, description: string): string {
  if (LOAD_ERRORS[code]) return LOAD_ERRORS[code]
  if (code <= -200 && code >= -299) return 'The website’s security certificate is not valid, so the page was not loaded.'
  return `The page could not be loaded (${description || `error ${code}`}).`
}

const isHttp = (u: string): boolean => /^https?:\/\//i.test(u)

/** Letter for the US/Canada, A4 elsewhere. */
export const defaultPaper = (): 'A4' | 'Letter' => (['US', 'CA', 'MX'].includes(app.getLocaleCountryCode().toUpperCase()) ? 'Letter' : 'A4')

export async function renderWebPage(o: WebRenderOptions): Promise<WebRenderResult> {
  const check = normalizeWebUrl(o.url)
  if (!check.ok) throw new WebPageError(check.error)
  if (o.signal.aborted) throw new Error('Cancelled')
  const timeoutMs = o.timeoutMs ?? (Number(process.env['EPDF_WEB_TIMEOUT_MS']) || 45_000) // the env override is for tests
  const partition = `epdf-web-${randomUUID()}` // no "persist:" prefix => in memory only
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(https?|data|blob):/i.test(details.url) }))

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1024,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: o.javascript,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => {
    if (!isHttp(url)) e.preventDefault()
  })
  wc.on('will-redirect', (e, url) => {
    if (!isHttp(url)) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())

  let status: number | null = null
  wc.on('did-navigate', (_e, _url, code) => {
    status = code
  })

  let settled = false
  return await new Promise<WebRenderResult>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      o.signal.removeEventListener('abort', onAbort)
      try {
        if (!win.isDestroyed()) win.destroy()
      } catch {
        /* already gone */
      }
      void ses.clearStorageData().catch(() => undefined)
      void ses.clearCache().catch(() => undefined)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = (): void => finish(() => reject(new Error('Cancelled')))
    const timer = setTimeout(() => finish(() => reject(new WebPageError(`The page did not finish loading within ${Math.round(timeoutMs / 1000)} seconds.`))), timeoutMs)
    o.signal.addEventListener('abort', onAbort, { once: true })

    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: aborted (e.g. a redirect replaced the load)
      finish(() => reject(new WebPageError(describeLoadFailure(code, description))))
    })
    wc.on('render-process-gone', () => finish(() => reject(new WebPageError('The page crashed while loading.'))))

    void (async () => {
      try {
        await win.loadURL(check.url)
      } catch (err) {
        if (settled) return
        const m = /\((-?\d+)\)/.exec(err instanceof Error ? err.message : '')
        finish(() => reject(new WebPageError(m ? describeLoadFailure(Number(m[1]), '') : 'The page could not be loaded.')))
        return
      }
      if (settled) return
      try {
        // Let late scripts, fonts and images settle before printing.
        await new Promise((r) => setTimeout(r, 400))
        if (o.javascript) {
          await Promise.race([wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined)
        }
        if (settled) return
        const pdf = await wc.printToPDF({ printBackground: true, pageSize: defaultPaper(), margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }, preferCSSPageSize: true, displayHeaderFooter: false, generateTaggedPDF: true })
        finish(() => resolve({ bytes: new Uint8Array(pdf), status, finalUrl: wc.getURL(), title: wc.getTitle() }))
      } catch (err) {
        finish(() => reject(new WebPageError(`The page could not be converted: ${err instanceof Error ? err.message : String(err)}`)))
      }
    })()
  })
}
