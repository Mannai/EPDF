import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { MultipartError, boundaryFrom, parseMultipart, sniffImage, type SniffedImage } from './multipart'
import { renderPhonePage } from './phonePage'

/**
 * A temporary, single-purpose HTTP server so a phone on the same network can send photos of pages.
 *
 * Security model (it is plain HTTP on a private network, which the UI says out loud):
 *  - one random 128-bit token in the URL path, compared in constant time; wrong tokens look exactly like any 404 and
 *    are rate limited per client address, with a lockout after repeated guesses
 *  - valid only while the dialog is open: `close()` and an absolute expiry time stop the listeners
 *  - only two routes: GET /<token> (the page) and POST /<token>/upload; no directory listing, no file serving
 *  - the upload needs a custom header and (when the browser sends them) same-origin `Origin` / `Sec-Fetch-Site`, and the
 *    server never sends CORS headers, so another web page cannot make a browser upload into it
 *  - the `Host` header must be one of the addresses we listen on (DNS-rebinding protection)
 *  - strict limits: request size, file size, files per request, files per session, concurrent uploads, connections,
 *    header size and time limits (slow-loris), image types decided by magic bytes (never by the client's claims)
 */

export interface UploadedImage {
  id: string
  mime: SniffedImage
  bytes: Buffer
}

export interface PhoneServerOptions {
  /** IPv4 addresses to listen on (one server each, random port). */
  addresses: string[]
  onUpload: (img: UploadedImage) => void
  onClose?: (reason: 'expired' | 'closed') => void
  token?: string
  ttlMs?: number
  maxFileBytes?: number
  maxRequestBytes?: number
  maxFilesPerRequest?: number
  maxTotalFiles?: number
  maxConcurrentUploads?: number
  maxConnections?: number
  headersTimeoutMs?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  /** Requests per client per minute, and wrong-token attempts before a lockout. */
  rateLimit?: { perMinute: number; badTokens: number; lockoutMs: number }
  now?: () => number
}

export interface PhoneEndpointInfo {
  address: string
  port: number
  url: string
}

const DEFAULTS = {
  ttlMs: 10 * 60 * 1000,
  maxFileBytes: 25 * 1024 * 1024,
  maxRequestBytes: 60 * 1024 * 1024,
  maxFilesPerRequest: 20,
  maxTotalFiles: 300,
  maxConcurrentUploads: 4,
  maxConnections: 32,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 90_000,
  idleTimeoutMs: 15_000,
  rateLimit: { perMinute: 240, badTokens: 12, lockoutMs: 60_000 }
}

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>()
  private locked = new Map<string, number>()
  private bad = new Map<string, { start: number; count: number }>()
  constructor(
    private readonly perMinute: number,
    private readonly badTokens: number,
    private readonly lockoutMs: number,
    private readonly now: () => number
  ) {}

  /** True if this request may proceed. */
  allow(key: string): boolean {
    const t = this.now()
    const until = this.locked.get(key)
    if (until !== undefined) {
      if (t < until) return false
      this.locked.delete(key)
    }
    const w = this.windows.get(key)
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 })
      this.prune(t)
      return true
    }
    w.count++
    return w.count <= this.perMinute
  }

  /** Records a wrong token; returns true when this client is now locked out. */
  badToken(key: string): boolean {
    const t = this.now()
    const b = this.bad.get(key)
    if (!b || t - b.start >= 60_000) this.bad.set(key, { start: t, count: 1 })
    else b.count++
    if ((this.bad.get(key)?.count ?? 0) >= this.badTokens) {
      this.locked.set(key, t + this.lockoutMs)
      this.bad.delete(key)
      return true
    }
    return false
  }

  private prune(t: number): void {
    if (this.windows.size < 512) return
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k)
  }
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

export class PhoneUploadServer {
  readonly token: string
  readonly expiresAt: number
  readonly endpoints: PhoneEndpointInfo[] = []
  readonly warnings: string[] = []
  accepted = 0
  private servers: Server[] = []
  private sockets = new Set<Socket>()
  private allowedHosts = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private uploading = 0
  private readonly o: Required<Omit<PhoneServerOptions, 'onClose' | 'token' | 'now'>> & Pick<PhoneServerOptions, 'onClose'>
  private readonly now: () => number
  private readonly limiter: RateLimiter
  private readonly tokenHash: Buffer

  private constructor(opts: PhoneServerOptions) {
    this.now = opts.now ?? Date.now
    this.o = { ...DEFAULTS, ...stripUndefined(opts), rateLimit: opts.rateLimit ?? DEFAULTS.rateLimit } as never
    this.token = opts.token ?? randomBytes(16).toString('base64url')
    this.tokenHash = sha(this.token)
    this.expiresAt = this.now() + this.o.ttlMs
    this.limiter = new RateLimiter(this.o.rateLimit.perMinute, this.o.rateLimit.badTokens, this.o.rateLimit.lockoutMs, this.now)
  }

  static async start(opts: PhoneServerOptions): Promise<PhoneUploadServer> {
    const s = new PhoneUploadServer(opts)
    await s.listenAll(opts.addresses)
    if (s.endpoints.length === 0) {
      throw new Error(s.warnings[0] ?? 'Epdf could not open a network port for your phone. Check that you are connected to a network and that a firewall is not blocking Epdf.')
    }
    const wait = Math.max(0, s.expiresAt - s.now())
    s.timer = setTimeout(() => s.close('expired'), wait)
    s.timer.unref()
    return s
  }

  get expired(): boolean {
    return this.now() >= this.expiresAt
  }

  private async listenAll(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: Math.max(50, Math.min(1000, Math.floor(this.o.headersTimeoutMs / 2))), keepAliveTimeout: 5000 }, (req, res) => this.handle(req, res))
      server.headersTimeout = this.o.headersTimeoutMs
      server.requestTimeout = this.o.requestTimeoutMs
      server.maxHeadersCount = 40
      server.maxConnections = this.o.maxConnections
      server.setTimeout(this.o.idleTimeoutMs)
      server.on('connection', (sock) => {
        this.sockets.add(sock)
        sock.on('close', () => this.sockets.delete(sock))
      })
      // Malformed or too-slow requests: answer once, then drop the connection (a stalling client cannot keep it half open).
      server.on('clientError', (err: NodeJS.ErrnoException, sock) => {
        const timedOut = err.code === 'ERR_HTTP_REQUEST_TIMEOUT' || err.code === 'ERR_HTTP_HEADERS_TIMEOUT'
        try {
          sock.end(`HTTP/1.1 ${timedOut ? '408 Request Timeout' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => sock.destroy())
        } catch {
          sock.destroy()
        }
        setTimeout(() => sock.destroy(), 1000).unref()
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen({ host: address, port: 0 }, () => {
            server.off('error', reject)
            resolve()
          })
        })
      } catch (err) {
        this.warnings.push(listenProblem(address, err))
        continue
      }
      const port = (server.address() as AddressInfo).port
      this.servers.push(server)
      this.allowedHosts.add(`${address}:${port}`)
      this.endpoints.push({ address, port, url: `http://${address}:${port}/${this.token}` })
    }
  }

  close(reason: 'expired' | 'closed' = 'closed'): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const s of this.servers) s.close()
    for (const sock of this.sockets) sock.destroy()
    this.sockets.clear()
    this.o.onClose?.(reason)
  }

  // ---- request handling -----------------------------------------------------------------------------------------

  private reply(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
    const buf = typeof body === 'string' ? Buffer.from(body) : body
    res.writeHead(status, {
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...headers
    })
    res.end(buf)
  }

  private text(res: ServerResponse, status: number, msg: string, extra: Record<string, string> = {}): void {
    this.reply(res, status, msg + '\n', { 'Content-Type': 'text/plain; charset=utf-8', ...extra })
  }

  private json(res: ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}): void {
    this.reply(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...extra })
  }

  private tokenMatches(candidate: string): boolean {
    return timingSafeEqual(sha(candidate), this.tokenHash)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.closed) return void res.destroy()
    const client = req.socket.remoteAddress ?? 'unknown'
    if (!this.limiter.allow(client)) return this.text(res, 429, 'Too many requests. Wait a minute and try again.', { 'Retry-After': '30', Connection: 'close' })

    // Host header must be one of ours (a rebinding page would carry its own name here).
    const host = (req.headers.host ?? '').toLowerCase()
    if (!this.allowedHosts.has(host)) return this.text(res, 421, 'Misdirected request.', { Connection: 'close' })

    const raw = req.url ?? ''
    if (raw.length > 200 || !raw.startsWith('/') || /[\0\\]/.test(raw)) return this.text(res, 404, 'Not found.')
    let path: string
    try {
      path = new URL(raw, 'http://localhost').pathname
    } catch {
      return this.text(res, 404, 'Not found.')
    }
    const segs = path.split('/').slice(1)
    if (segs[segs.length - 1] === '') segs.pop()
    if (segs.length < 1 || segs.length > 2 || !this.tokenMatches(segs[0])) {
      if (this.limiter.badToken(client)) return this.text(res, 429, 'Too many requests. Wait a minute and try again.', { 'Retry-After': '60', Connection: 'close' })
      return this.text(res, 404, 'Not found.')
    }
    if (this.expired) {
      res.once('finish', () => setTimeout(() => this.close('expired'), 20))
      return this.text(res, 410, 'This link has expired. Ask Epdf for a new QR code.', { Connection: 'close' })
    }

    if (segs.length === 1) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.text(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' })
      const nonce = randomBytes(16).toString('base64url')
      const html = renderPhonePage({ nonce, maxFileMb: this.o.maxFileBytes / 1024 / 1024, expiresInMinutes: Math.ceil((this.expiresAt - this.now()) / 60_000) })
      return this.reply(res, 200, req.method === 'HEAD' ? '' : html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' blob: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
        'X-Frame-Options': 'DENY'
      })
    }
    if (segs[1] !== 'upload') return this.text(res, 404, 'Not found.')
    if (req.method !== 'POST') return this.text(res, 405, 'Method not allowed.', { Allow: 'POST' })
    this.handleUpload(req, res, host)
  }

  private handleUpload(req: IncomingMessage, res: ServerResponse, host: string): void {
    const h = req.headers
    // CSRF: custom header (forces a CORS preflight we never answer), same-origin Origin / Fetch-Metadata when present.
    if (h['x-epdf-upload'] !== '1') return this.json(res, 403, { error: 'Forbidden.' }, { Connection: 'close' })
    if (typeof h.origin === 'string' && h.origin.toLowerCase() !== `http://${host}`) return this.json(res, 403, { error: 'Forbidden.' }, { Connection: 'close' })
    const fetchSite = h['sec-fetch-site']
    if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return this.json(res, 403, { error: 'Forbidden.' }, { Connection: 'close' })

    const boundary = boundaryFrom(h['content-type'])
    if (!boundary) return this.json(res, 415, { error: 'Send the photo as a normal form upload.' }, { Connection: 'close' })
    const declared = h['content-length'] !== undefined ? Number(h['content-length']) : NaN
    if (h['content-length'] !== undefined && (!Number.isFinite(declared) || declared < 0)) return this.json(res, 400, { error: 'Bad request.' }, { Connection: 'close' })
    if (declared > this.o.maxRequestBytes) return this.json(res, 413, { error: `That upload is too large (the limit is ${Math.floor(this.o.maxRequestBytes / 1024 / 1024)} MB).` }, { Connection: 'close' })
    if (this.accepted >= this.o.maxTotalFiles) return this.json(res, 409, { error: 'This session has received the maximum number of photos.' }, { Connection: 'close' })
    if (this.uploading >= this.o.maxConcurrentUploads) return this.json(res, 503, { error: 'Epdf is busy receiving other photos. Try again in a moment.' }, { 'Retry-After': '2', Connection: 'close' })

    this.uploading++
    let received = 0
    const chunks: Buffer[] = []
    let finished = false
    const done = (fn: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      this.uploading--
      fn()
    }
    const timer = setTimeout(() => {
      done(() => {
        this.json(res, 408, { error: 'The upload took too long.' }, { Connection: 'close' })
        req.destroy()
      })
    }, this.o.requestTimeoutMs)

    req.on('data', (c: Buffer) => {
      received += c.length
      if (received > this.o.maxRequestBytes) {
        done(() => {
          this.json(res, 413, { error: `That upload is too large (the limit is ${Math.floor(this.o.maxRequestBytes / 1024 / 1024)} MB).` }, { Connection: 'close' })
          req.destroy()
        })
        return
      }
      chunks.push(c)
    })
    req.on('aborted', () => done(() => undefined))
    req.on('error', () => done(() => undefined))
    req.on('close', () => done(() => undefined))
    req.on('end', () => {
      done(() => this.finishUpload(res, Buffer.concat(chunks, received), boundary))
    })
  }

  private finishUpload(res: ServerResponse, body: Buffer, boundary: string): void {
    let parts
    try {
      parts = parseMultipart(body, boundary, { maxParts: this.o.maxFilesPerRequest * 2 })
    } catch (err) {
      const status = err instanceof MultipartError ? err.status : 400
      return this.json(res, status, { error: err instanceof Error ? err.message : 'Bad upload.' })
    }
    const files = parts.filter((p) => p.filename !== null)
    if (files.length === 0) return this.json(res, 400, { error: 'No photo was found in the upload.' })
    if (files.length > this.o.maxFilesPerRequest) return this.json(res, 413, { error: `At most ${this.o.maxFilesPerRequest} photos per upload.` })
    let accepted = 0
    const rejected: { reason: string }[] = []
    for (const f of files) {
      if (f.data.length === 0) {
        rejected.push({ reason: 'Empty file.' })
        continue
      }
      if (f.data.length > this.o.maxFileBytes) {
        rejected.push({ reason: `Larger than ${Math.floor(this.o.maxFileBytes / 1024 / 1024)} MB.` })
        continue
      }
      if (this.accepted >= this.o.maxTotalFiles) {
        rejected.push({ reason: 'Session limit reached.' })
        continue
      }
      const mime = sniffImage(f.data)
      if (!mime) {
        rejected.push({ reason: 'Only JPEG, PNG and WebP pictures are accepted.' })
        continue
      }
      this.accepted++
      accepted++
      this.o.onUpload({ id: randomBytes(8).toString('hex'), mime, bytes: Buffer.from(f.data) })
    }
    if (accepted === 0) return this.json(res, 415, { accepted, rejected, error: rejected[0]?.reason ?? 'Nothing was accepted.' })
    this.json(res, 200, { accepted, rejected })
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** A clear sentence for a failed `listen`. */
export function listenProblem(address: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EADDRNOTAVAIL') return `The network address ${address} is not available any more. Check your network connection.`
  if (code === 'EACCES' || code === 'EPERM') return `Epdf is not allowed to open a network port on ${address}. A firewall or security program may be blocking it: allow Epdf on private networks and try again.`
  if (code === 'EADDRINUSE') return `Could not open a network port on ${address} (in use). Try again.`
  return `Could not open a network port on ${address}${code ? ` (${code})` : ''}. Check your network connection and firewall.`
}
