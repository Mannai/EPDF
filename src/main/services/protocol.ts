import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { DocRegistry } from './docRegistry'

export const APP_SCHEME = 'epdf-app'
export const APP_ORIGIN = `${APP_SCHEME}://app`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf'
}

/** Must run before `app.whenReady()`. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

async function serveFile(
  file: string,
  mime: string,
  rangeHeader: string | null,
  extra: Record<string, string>
): Promise<Response> {
  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile()) return new Response('Not found', { status: 404, headers: extra })
  const size = st.size
  const headers: Record<string, string> = {
    ...extra,
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
  }
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } })

  let start = 0
  let end = size - 1
  let status = 200
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      start = Math.max(0, size - parseInt(m[2], 10))
    } else {
      start = parseInt(m[1], 10)
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1)
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(end - start + 1)
  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
  return new Response(body, { status, headers })
}

/**
 * Serves the renderer bundle (`/…`) and open PDF bytes (`/doc/<docId>`, range-capable) under one
 * origin. In dev the renderer comes from the Vite server, so CORS headers are added for it.
 */
export function registerAppProtocol(opts: { rendererRoot: string; registry: DocRegistry; devOrigin?: string }): void {
  const { rendererRoot, registry, devOrigin } = opts
  const cors: Record<string, string> = devOrigin ? { 'Access-Control-Allow-Origin': devOrigin } : {}
  const noStore = { 'Cache-Control': 'no-store' }

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method === 'OPTIONS' && devOrigin) {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD' }
      })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })

    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const pathname = decodeURIComponent(url.pathname)

    if (pathname.startsWith('/doc/')) {
      const path = registry.pathOf(pathname.slice('/doc/'.length))
      if (!path) return new Response('Unknown document', { status: 404, headers: cors })
      return serveFile(path, 'application/pdf', request.headers.get('range'), { ...cors, ...noStore })
    }

    // Static renderer files. Reject anything that resolves outside the bundle root.
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^[\\/]+/, '')
    const file = join(rendererRoot, rel)
    if (file !== rendererRoot && !file.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 })
    return serveFile(file, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', null, cors)
  })
}
