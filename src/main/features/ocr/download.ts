import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import { join } from 'node:path'
import type { OcrLanguage } from '../../../shared/features/ocr'
import { fileNameOf } from './languages'

/**
 * Downloads one language pack. This is the ONLY network access in Epdf. The URL is never taken from the
 * renderer: it is `baseUrl + <catalogue code>.traineddata`. Safety rules, each covered by a test:
 *   - HTTPS only (plain HTTP only when the caller explicitly allows it, which only tests do),
 *   - at most `maxRedirects` redirects, each of which must again be HTTPS,
 *   - a hard size limit, checked against Content-Length and while streaming,
 *   - the SHA-256 pinned in the catalogue must match, otherwise nothing is installed,
 *   - the file is written to `<code>.traineddata.part` and renamed into place only after verification.
 */

export type DownloadState = 'connecting' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled'

export interface DownloadOptions {
  lang: OcrLanguage
  /** Expected SHA-256 (normally `lang.sha256`). */
  sha256: string
  baseUrl: string
  destDir: string
  signal?: AbortSignal
  onState?: (state: DownloadState) => void
  onProgress?: (received: number, total: number) => void
  maxRedirects?: number
  /** Upper bound in bytes. Defaults to twice the catalogue size (at least 16 MB), never above 64 MB. */
  maxBytes?: number
  /** Allow http:// (tests only). */
  allowHttp?: boolean
  /** Give up when no data arrives for this long. */
  idleTimeoutMs?: number
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'protocol' | 'size' | 'integrity' | 'cancelled'
  ) {
    super(message)
  }
}

const HARD_LIMIT = 64 * 1024 * 1024

export function urlFor(baseUrl: string, code: string): string {
  return `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}${fileNameOf(code)}`
}

function checkProtocol(url: URL, allowHttp: boolean): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && allowHttp) return
  throw new DownloadError('Language data can only be downloaded over a secure (HTTPS) connection.', 'protocol')
}

/** Resolves with the response of the final (non-redirect) request. */
function open(url: URL, opts: DownloadOptions, redirects: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    try {
      checkProtocol(url, !!opts.allowHttp)
    } catch (err) {
      return reject(err)
    }
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'Epdf', Accept: 'application/octet-stream' }, signal: opts.signal }, (res) => {
      const status = res.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume()
        const loc = res.headers.location
        if (!loc) return reject(new DownloadError('The server sent an invalid redirect.', 'protocol'))
        if (redirects >= (opts.maxRedirects ?? 3)) return reject(new DownloadError('The server redirected too many times.', 'protocol'))
        let next: URL
        try {
          next = new URL(loc, url)
        } catch {
          return reject(new DownloadError('The server sent an invalid redirect.', 'protocol'))
        }
        return open(next, opts, redirects + 1).then(resolve, reject)
      }
      if (status !== 200) {
        res.resume()
        return reject(new DownloadError(`The download server answered with status ${status}.`, 'network'))
      }
      resolve(res)
    })
    req.setTimeout(opts.idleTimeoutMs ?? 30000, () => req.destroy(new DownloadError('The download server stopped responding.', 'network')))
    req.on('error', (err) => {
      if (opts.signal?.aborted) return reject(new DownloadError('Cancelled', 'cancelled'))
      reject(err instanceof DownloadError ? err : new DownloadError(`Could not reach the download server (${err.message}).`, 'network'))
    })
  })
}

/** Downloads, verifies and installs a pack. Returns the installed path. Any failure leaves nothing behind. */
export async function downloadLanguage(opts: DownloadOptions): Promise<string> {
  const { lang, destDir } = opts
  const state = (s: DownloadState): void => opts.onState?.(s)
  const finalPath = join(destDir, fileNameOf(lang.code))
  const partPath = `${finalPath}.part`
  const limit = Math.min(opts.maxBytes ?? Math.max(lang.size * 2, 16 * 1024 * 1024), HARD_LIMIT)
  try {
    if (opts.signal?.aborted) throw new DownloadError('Cancelled', 'cancelled')
    state('connecting')
    await mkdir(destDir, { recursive: true })
    const res = await open(new URL(urlFor(opts.baseUrl, lang.code)), opts, 0)
    const declared = Number(res.headers['content-length'] ?? 0)
    if (declared > limit) {
      res.destroy()
      throw new DownloadError(`The ${lang.name} language file is larger than expected, so it was not downloaded.`, 'size')
    }
    state('downloading')
    const hash = createHash('sha256')
    const out = createWriteStream(partPath)
    let received = 0
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        reject(opts.signal?.aborted ? new DownloadError('Cancelled', 'cancelled') : err)
        res.destroy()
        out.destroy()
      }
      opts.signal?.addEventListener('abort', () => fail(new DownloadError('Cancelled', 'cancelled')), { once: true })
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > limit) return fail(new DownloadError(`The ${lang.name} language file is larger than expected, so the download was stopped.`, 'size'))
        hash.update(chunk)
        if (!out.write(chunk)) {
          res.pause()
          out.once('drain', () => res.resume())
        }
        opts.onProgress?.(received, declared || lang.size)
      })
      res.on('error', (err) => fail(new DownloadError(`The download was interrupted (${err.message}).`, 'network')))
      res.on('aborted', () => fail(new DownloadError('The download was interrupted.', 'network')))
      out.on('error', (err) => fail(new DownloadError(`Could not save the language file (${err.message}).`, 'network')))
      res.on('end', () => out.end(() => resolve()))
    })
    if (declared && received !== declared) throw new DownloadError('The download was incomplete.', 'network')
    state('verifying')
    const digest = hash.digest('hex')
    if (digest !== opts.sha256) {
      throw new DownloadError(`The downloaded ${lang.name} language file failed its integrity check and was discarded.`, 'integrity')
    }
    state('installing')
    await rename(partPath, finalPath) // atomic on one volume; replaces an older copy
    state('done')
    return finalPath
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => undefined)
    const e = err instanceof DownloadError ? err : new DownloadError(err instanceof Error ? err.message : String(err), 'network')
    state(e.kind === 'cancelled' ? 'cancelled' : 'failed')
    throw e
  }
}
