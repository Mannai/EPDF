import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isPrivateIPv4, listLanAddresses } from '../../src/main/features/scan/lan'
import { MultipartError, boundaryFrom, parseMultipart, sniffImage } from '../../src/main/features/scan/multipart'
import { PhoneUploadServer, listenProblem, type PhoneServerOptions, type UploadedImage } from '../../src/main/features/scan/phoneServer'
import { makeFakeJpeg, makePng, solid } from '../support/images'

// ---- helpers ------------------------------------------------------------------------------------------------------

const B = 'EpdfTestBoundary7MA4YWxkTrZu0gW'
interface FileSpec {
  name?: string
  filename?: string | null
  data: Uint8Array | Buffer | string
  type?: string
}
function multipart(files: FileSpec[], boundary = B): Buffer {
  const parts: Buffer[] = []
  for (const f of files) {
    const esc = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`)
    const cd = `form-data; name="${f.name ?? 'photo'}"` + (f.filename === null ? '' : `; filename="${esc(f.filename ?? 'p.jpg')}"`)
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${cd}\r\nContent-Type: ${f.type ?? 'image/jpeg'}\r\n\r\n`), Buffer.from(f.data), Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

const jpeg = (w = 64, h = 48): Buffer => Buffer.from(makeFakeJpeg(w, h))
const png = (): Buffer => Buffer.from(makePng(8, 8, solid(1, 2, 3)))

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}
function send(url: string, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer | string; host?: string } = {}): Promise<Res> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, method: opts.method ?? 'GET', path: opts.path ?? u.pathname, headers: { Host: opts.host ?? u.host, Connection: 'close', ...opts.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

const upload = (base: string, files: FileSpec[], headers: Record<string, string> = {}, path?: string): Promise<Res> => {
  const body = multipart(files)
  return send(base, { method: 'POST', path: path ?? new URL(base).pathname.replace(/\/$/, '') + '/upload', body, headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': String(body.length), 'X-Epdf-Upload': '1', ...headers } })
}

let live: PhoneUploadServer[] = []
afterEach(() => {
  for (const s of live) s.close()
  live = []
})

async function start(over: Partial<PhoneServerOptions> = {}): Promise<{ server: PhoneUploadServer; url: string; got: UploadedImage[] }> {
  const got: UploadedImage[] = []
  const server = await PhoneUploadServer.start({ addresses: ['127.0.0.1'], onUpload: (i) => got.push(i), ...over })
  live.push(server)
  return { server, url: server.endpoints[0].url, got }
}

const refused = (url: string): Promise<boolean> =>
  send(url).then(
    () => false,
    (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET'
  )

// ---- LAN addresses ------------------------------------------------------------------------------------------------

describe('LAN address discovery', () => {
  it('classifies private IPv4 space (and not link-local, CGNAT, public or junk)', () => {
    for (const a of ['192.168.1.20', '10.0.0.5', '172.16.0.1', '172.31.255.254']) expect(isPrivateIPv4(a)).toBe(true)
    for (const a of ['172.15.0.1', '172.32.0.1', '169.254.3.4', '100.64.1.1', '8.8.8.8', '192.169.0.1', '300.1.1.1', '::1', 'fe80::1', '']) expect(isPrivateIPv4(a)).toBe(false)
  })

  it('lists usable interfaces, best first, virtual adapters last', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null })
    const out = listLanAddresses({
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      'vEthernet (WSL)': [v4('172.20.16.1')],
      Ethernet: [v4('10.1.2.3'), { ...v4('fe80::1'), family: 'IPv6' as const, scopeid: 0, address: 'fe80::1', cidr: null } as never],
      'Wi-Fi': [v4('192.168.0.77')],
      Tailscale: [v4('100.100.1.1')],
      Cellular: [v4('203.0.113.9')]
    })
    expect(out.map((a) => a.address)).toEqual(['192.168.0.77', '10.1.2.3', '172.20.16.1'])
    expect(out.map((a) => a.likelyVirtual)).toEqual([false, false, true])
  })
})

// ---- multipart parser ---------------------------------------------------------------------------------------------

describe('multipart parser', () => {
  it('parses several parts including binary data with CRLFs and quoted names', () => {
    const tricky = Buffer.from([0xff, 0xd8, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x0d, 0x0a, 0x00, 0x41])
    const body = multipart([{ data: tricky, filename: 'a "quoted" \\ name.jpg' }, { name: 'note', filename: null, data: 'hello', type: 'text/plain' }, { data: png(), filename: 'b.png', type: 'image/png' }])
    const parts = parseMultipart(body, B, { maxParts: 10 })
    expect(parts).toHaveLength(3)
    expect(parts[0].filename).toBe('a "quoted" \\ name.jpg')
    expect(Buffer.compare(parts[0].data, tricky)).toBe(0)
    expect(parts[1]).toMatchObject({ name: 'note', filename: null, contentType: 'text/plain' })
    expect(parts[1].data.toString()).toBe('hello')
    expect(sniffImage(parts[2].data)).toBe('image/png')
  })

  it('rejects malformed bodies with 400 and too many parts with 413', () => {
    expect(() => parseMultipart(Buffer.from('nothing here'), B, { maxParts: 5 })).toThrow(MultipartError)
    expect(() => parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n\r\ndata without end`), B, { maxParts: 5 })).toThrow(/ended unexpectedly/)
    expect(() => parseMultipart(Buffer.from(`--${B}\r\nbad header line\r\n\r\nx\r\n--${B}--`), B, { maxParts: 5 })).toThrow(/headers/)
    expect(() => parseMultipart(Buffer.from(`--${B}\r\nContent-Type: text/plain\r\n\r\nx\r\n--${B}--`), B, { maxParts: 5 })).toThrow(/invalid part/)
    expect(() => parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: attachment; name="a"\r\n\r\nx\r\n--${B}--`), B, { maxParts: 5 })).toThrow(/invalid part/)
    try {
      parseMultipart(multipart([{ data: 'a' }, { data: 'b' }, { data: 'c' }]), B, { maxParts: 2 })
      expect.unreachable()
    } catch (e) {
      expect((e as MultipartError).status).toBe(413)
    }
  })

  it('accepts only sane boundaries', () => {
    expect(boundaryFrom(`multipart/form-data; boundary=${B}`)).toBe(B)
    expect(boundaryFrom('multipart/form-data; boundary="abc def"')).toBe('abc def')
    expect(boundaryFrom('application/json')).toBeNull()
    expect(boundaryFrom('multipart/form-data')).toBeNull()
    expect(boundaryFrom(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeNull()
    expect(boundaryFrom('multipart/form-data; boundary=a\r\nb')).toBeNull()
    expect(boundaryFrom(undefined)).toBeNull()
  })

  it('decides the image type from the bytes', () => {
    expect(sniffImage(jpeg())).toBe('image/jpeg')
    expect(sniffImage(png())).toBe('image/png')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull()
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull()
    expect(sniffImage(new Uint8Array(0))).toBeNull()
  })
})

// ---- the server, over real HTTP -----------------------------------------------------------------------------------

describe('phone upload server: routes and token rules', () => {
  it('serves a self-contained page only at /<token>, with a strict CSP and the unencrypted-traffic warning', async () => {
    const { url, server } = await start()
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    const r = await send(url)
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toContain('text/html')
    const csp = String(r.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]
    expect(r.text).toContain(`nonce="${nonce}"`)
    expect(r.text).not.toMatch(/https?:\/\//i) // no external assets, no absolute links
    expect(r.text).toMatch(/not encrypted/i)
    expect(r.text).toContain('capture="environment"')
    expect(r.text).toContain('accept="image/*"')
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
    expect(String(r.headers['cache-control'])).toContain('no-store')
    expect((await send(url + '/')).status).toBe(200) // trailing slash
    expect((await send(url, { method: 'HEAD' })).status).toBe(200)
  })

  it('a different nonce for every response', async () => {
    const { url } = await start()
    const a = /nonce-([^']+)/.exec(String((await send(url)).headers['content-security-policy']))![1]
    const b = /nonce-([^']+)/.exec(String((await send(url)).headers['content-security-policy']))![1]
    expect(a).not.toBe(b)
  })

  it('everything else is an identical 404: no listing, no oracle for the token, no traversal', async () => {
    const { url, server } = await start()
    const base = new URL(url)
    const unknown = await send(url, { path: '/nothing' })
    expect(unknown.status).toBe(404)
    for (const path of ['/', '/index.html', `/${server.token.slice(0, -1)}x`, `/${server.token}/../`, `/${server.token}/other`, `/${server.token}/upload/extra`, '/%2e%2e/', `/${server.token}%00`, `/${server.token}\\upload`]) {
      const r = await send(url, { path })
      expect([404]).toContain(r.status)
      expect(r.text).toBe(unknown.text)
    }
    expect((await send(url, { path: '/' + 'a'.repeat(400) })).status).toBe(404)
    expect(base.pathname).toBe('/' + server.token)
  })

  it('rejects wrong methods on the real routes and never answers CORS', async () => {
    const { url, server } = await start()
    expect((await send(url, { method: 'POST' })).status).toBe(405)
    expect((await send(url, { method: 'DELETE' })).status).toBe(405)
    const g = await send(url, { path: `/${server.token}/upload` })
    expect(g.status).toBe(405)
    const pre = await send(url, { method: 'OPTIONS', path: `/${server.token}/upload`, headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } })
    expect([404, 405]).toContain(pre.status)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('refuses a Host header that is not one of our addresses (DNS rebinding)', async () => {
    const { url } = await start()
    expect((await send(url, { host: 'evil.example:80' })).status).toBe(421)
  })

  it('two servers never share a token', async () => {
    const a = await start()
    const b = await start()
    expect(a.server.token).not.toBe(b.server.token)
  })
})

describe('phone upload server: uploading', () => {
  it('accepts a photo, reports it and hands over the exact bytes', async () => {
    const { url, got } = await start()
    const data = jpeg(300, 200)
    const r = await upload(url, [{ data }])
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toMatchObject({ accepted: 1, rejected: [] })
    expect(got).toHaveLength(1)
    expect(got[0].mime).toBe('image/jpeg')
    expect(Buffer.compare(got[0].bytes, data)).toBe(0)
    expect(got[0].id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('takes several photos in one request and reports the ones it refused', async () => {
    const { url, got } = await start()
    const r = await upload(url, [{ data: jpeg() }, { data: png(), filename: 'x.png', type: 'image/png' }, { data: '<script>alert(1)</script>', filename: 'evil.jpg' }, { data: '', filename: 'empty.jpg' }])
    expect(r.status).toBe(200)
    const j = JSON.parse(r.text)
    expect(j.accepted).toBe(2)
    expect(j.rejected).toHaveLength(2)
    expect(got.map((g) => g.mime)).toEqual(['image/jpeg', 'image/png'])
  })

  it('a file whose name and type claim to be an image but whose bytes are not is refused', async () => {
    const { url, got } = await start()
    const r = await upload(url, [{ data: 'MZ\x90\x00 pretend executable', filename: 'photo.jpg', type: 'image/jpeg' }])
    expect(r.status).toBe(415)
    expect(got).toHaveLength(0)
  })

  it('needs the custom header, a same-origin Origin and same-origin Fetch Metadata (CSRF)', async () => {
    const { url, got } = await start()
    const noHeader = await upload(url, [{ data: jpeg() }], { 'X-Epdf-Upload': '0' })
    expect(noHeader.status).toBe(403)
    const evilOrigin = await upload(url, [{ data: jpeg() }], { Origin: 'http://evil.example' })
    expect(evilOrigin.status).toBe(403)
    const cross = await upload(url, [{ data: jpeg() }], { 'Sec-Fetch-Site': 'cross-site' })
    expect(cross.status).toBe(403)
    expect(got).toHaveLength(0)
    const host = new URL(url).host
    const ok = await upload(url, [{ data: jpeg() }], { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })
    expect(ok.status).toBe(200)
  })

  it('a form post without the header (what a hostile page could send cross-site) is refused', async () => {
    const { url, server } = await start()
    const body = multipart([{ data: jpeg() }])
    const r = await send(url, { method: 'POST', path: `/${server.token}/upload`, body, headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': String(body.length) } })
    expect(r.status).toBe(403)
  })

  it('rejects wrong content types and malformed bodies', async () => {
    const { url, server } = await start()
    const path = `/${server.token}/upload`
    const h = { 'X-Epdf-Upload': '1' }
    expect((await send(url, { method: 'POST', path, body: '{"a":1}', headers: { ...h, 'Content-Type': 'application/json' } })).status).toBe(415)
    expect((await send(url, { method: 'POST', path, body: 'garbage', headers: { ...h, 'Content-Type': `multipart/form-data; boundary=${B}` } })).status).toBe(400)
    expect((await send(url, { method: 'POST', path, body: `--${B}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\n\r\nabc`, headers: { ...h, 'Content-Type': `multipart/form-data; boundary=${B}` } })).status).toBe(400)
    expect((await send(url, { method: 'POST', path, body: multipart([{ name: 'note', filename: null, data: 'no file' }]), headers: { ...h, 'Content-Type': `multipart/form-data; boundary=${B}` } })).status).toBe(400)
    expect((await send(url, { method: 'POST', path, body: 'x', headers: { ...h, 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': '-5' } })).status).toBeGreaterThanOrEqual(400)
  })

  it('enforces the request size limit from Content-Length and while streaming without one', async () => {
    const { url, got } = await start({ maxRequestBytes: 100_000 })
    const big = Buffer.concat([jpeg(), Buffer.alloc(200_000, 7)])
    const declared = await upload(url, [{ data: big }])
    expect(declared.status).toBe(413)
    // chunked (no Content-Length): the server must stop reading at the limit
    const body = multipart([{ data: big }])
    const chunked = await send(url, { method: 'POST', path: new URL(url).pathname + '/upload', body, headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'X-Epdf-Upload': '1', 'Transfer-Encoding': 'chunked' } }).catch((e: NodeJS.ErrnoException) => ({ status: e.code === 'ECONNRESET' || e.code === 'EPIPE' ? 413 : 0 }))
    expect(chunked.status).toBe(413)
    expect(got).toHaveLength(0)
  })

  it('enforces the per-file limit even when the whole request is small enough', async () => {
    const { url, got } = await start({ maxFileBytes: 5000 })
    const r = await upload(url, [{ data: Buffer.concat([jpeg(), Buffer.alloc(8000, 1)]) }])
    expect(r.status).toBe(415)
    expect(JSON.parse(r.text).rejected[0].reason).toMatch(/Larger than/)
    expect(got).toHaveLength(0)
  })

  it('limits files per request and files per session', async () => {
    const a = await start({ maxFilesPerRequest: 2 })
    expect((await upload(a.url, [{ data: jpeg() }, { data: jpeg() }, { data: jpeg() }])).status).toBe(413)
    const b = await start({ maxTotalFiles: 2 })
    expect((await upload(b.url, [{ data: jpeg() }])).status).toBe(200)
    expect((await upload(b.url, [{ data: jpeg() }, { data: jpeg() }])).status).toBe(200) // second is cut off
    expect(b.got).toHaveLength(2)
    expect((await upload(b.url, [{ data: jpeg() }])).status).toBe(409)
  })

  it('a wrong token uploads nothing and looks like any 404', async () => {
    const { url, got, server } = await start()
    const r = await upload(url, [{ data: jpeg() }], {}, `/${server.token.slice(0, -1)}A/upload`)
    expect(r.status).toBe(404)
    expect(got).toHaveLength(0)
  })

  it('takes concurrent uploads', async () => {
    const { url, got } = await start()
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => upload(url, [{ data: jpeg(100 + i, 100) }, { data: jpeg(200 + i, 100) }])))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(got).toHaveLength(8)
    expect(new Set(got.map((g) => g.id)).size).toBe(8)
  })

  it('answers 503 when too many uploads are in flight', async () => {
    const { url, server } = await start({ maxConcurrentUploads: 2, requestTimeoutMs: 5000 })
    const u = new URL(url)
    const hang: Socket[] = []
    for (let i = 0; i < 2; i++) {
      const s = connect(Number(u.port), u.hostname)
      await new Promise<void>((r) => s.once('connect', () => r()))
      s.write(`POST /${server.token}/upload HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: multipart/form-data; boundary=${B}\r\nContent-Length: 5000\r\nX-Epdf-Upload: 1\r\n\r\n--${B}\r\n`)
      hang.push(s)
    }
    await new Promise((r) => setTimeout(r, 100))
    const third = await upload(url, [{ data: jpeg() }])
    expect(third.status).toBe(503)
    hang.forEach((s) => s.destroy())
  })
})

describe('phone upload server: abuse, expiry and shutdown', () => {
  it('locks a client out after repeated wrong tokens (even with the right one), other clients are unaffected in principle', async () => {
    const { url, server } = await start({ rateLimit: { perMinute: 1000, badTokens: 5, lockoutMs: 60_000 } })
    for (let i = 0; i < 4; i++) expect((await send(url, { path: `/guess${i}` })).status).toBe(404)
    expect((await send(url, { path: '/guess5' })).status).toBe(429)
    expect((await send(url, { path: `/${server.token}` })).status).toBe(429)
  })

  it('rate limits floods of valid requests', async () => {
    const { url } = await start({ rateLimit: { perMinute: 5, badTokens: 50, lockoutMs: 1000 } })
    const codes: number[] = []
    for (let i = 0; i < 8; i++) codes.push((await send(url)).status)
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(codes.slice(5)).toEqual([429, 429, 429])
  })

  it('an expired token answers 410 and shuts the server down (injected clock)', async () => {
    let t = 1_000_000
    let reason = ''
    const { url } = await start({ now: () => t, ttlMs: 60_000, onClose: (r) => (reason = r) })
    expect((await send(url)).status).toBe(200)
    t += 61_000
    const r = await send(url)
    expect(r.status).toBe(410)
    expect(r.text).toMatch(/expired/i)
    await new Promise((res) => setTimeout(res, 150))
    expect(reason).toBe('expired')
    expect(await refused(url)).toBe(true)
  })

  it('stops listening by itself when the time is up (real timer)', async () => {
    let reason = ''
    const { url } = await start({ ttlMs: 250, onClose: (r) => (reason = r) })
    expect((await send(url)).status).toBe(200)
    await new Promise((res) => setTimeout(res, 500))
    expect(reason).toBe('expired')
    expect(await refused(url)).toBe(true)
  })

  it('close() ends everything at once, including open connections', async () => {
    let reason = ''
    const { url, server } = await start({ onClose: (r) => (reason = r) })
    const u = new URL(url)
    const idle = connect(Number(u.port), u.hostname)
    await new Promise<void>((r) => idle.once('connect', () => r()))
    const closed = new Promise<void>((r) => idle.once('close', () => r()))
    server.close()
    await closed
    expect(reason).toBe('closed')
    expect(await refused(url)).toBe(true)
    server.close() // idempotent
  })

  it('slow-loris: a client that dribbles headers is cut off', async () => {
    const { url } = await start({ headersTimeoutMs: 300, idleTimeoutMs: 400 })
    const u = new URL(url)
    const s = connect(Number(u.port), u.hostname)
    await new Promise<void>((r) => s.once('connect', () => r()))
    const started = Date.now()
    const closed = new Promise<void>((r) => s.once('close', () => r()))
    s.write('GET / HTTP/1.1\r\nHost: ' + u.host + '\r\nX-Slow: ')
    const drip = setInterval(() => s.write('a', () => undefined), 100)
    s.on('error', () => undefined)
    await closed
    clearInterval(drip)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('slow body: an upload that stalls is cut off by the timeouts', async () => {
    const { url, server, got } = await start({ requestTimeoutMs: 600, idleTimeoutMs: 400 })
    const u = new URL(url)
    const s = connect(Number(u.port), u.hostname)
    await new Promise<void>((r) => s.once('connect', () => r()))
    const closed = new Promise<void>((r) => s.once('close', () => r()))
    s.write(`POST /${server.token}/upload HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: multipart/form-data; boundary=${B}\r\nContent-Length: 100000\r\nX-Epdf-Upload: 1\r\n\r\n--${B}\r\n`)
    const started = Date.now()
    await closed
    expect(Date.now() - started).toBeLessThan(5000)
    expect(got).toHaveLength(0)
  })

  it('caps simultaneous connections', async () => {
    const { url } = await start({ maxConnections: 3, idleTimeoutMs: 5000 })
    const u = new URL(url)
    const socks: Socket[] = []
    for (let i = 0; i < 3; i++) {
      const s = connect(Number(u.port), u.hostname)
      await new Promise<void>((r) => s.once('connect', () => r()))
      socks.push(s)
    }
    const extra = connect(Number(u.port), u.hostname)
    const dropped = await new Promise<boolean>((r) => {
      extra.once('close', () => r(true))
      extra.once('error', () => r(true))
      setTimeout(() => r(false), 1500)
    })
    expect(dropped).toBe(true)
    socks.forEach((s) => s.destroy())
  })
})

describe('starting up', () => {
  it('reports a clear reason when no address can be opened', async () => {
    await expect(PhoneUploadServer.start({ addresses: ['203.0.113.9'], onUpload: () => undefined })).rejects.toThrow(/not available|network address/i)
    await expect(PhoneUploadServer.start({ addresses: [], onUpload: () => undefined })).rejects.toThrow(/network port/i)
  })

  it('keeps going when only some addresses fail and lists warnings', async () => {
    const s = await PhoneUploadServer.start({ addresses: ['203.0.113.9', '127.0.0.1'], onUpload: () => undefined })
    live.push(s)
    expect(s.endpoints).toHaveLength(1)
    expect(s.warnings).toHaveLength(1)
  })

  it('has readable messages for the usual listen failures', () => {
    expect(listenProblem('10.0.0.2', { code: 'EACCES' })).toMatch(/firewall/i)
    expect(listenProblem('10.0.0.2', { code: 'EADDRNOTAVAIL' })).toMatch(/not available/i)
    expect(listenProblem('10.0.0.2', {})).toMatch(/firewall/i)
  })
})
