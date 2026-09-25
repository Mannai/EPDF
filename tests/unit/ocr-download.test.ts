import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findLanguage, type OcrLanguage } from '../../src/shared/features/ocr'
import { downloadLanguage, DownloadError, urlFor, type DownloadState } from '../../src/main/features/ocr/download'
import { LanguageStore, sha256File } from '../../src/main/features/ocr/languages'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const PACK = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7 + 3) & 0xff))
const PACK_SHA = sha(PACK)
const lang: OcrLanguage = { ...findLanguage('deu')!, size: PACK.length, sha256: PACK_SHA }

let server: Server
let base: string
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'epdf-ocr-dl-'))
  dirs.push(d)
  return d
}

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
afterEach(() => {
  handler = () => undefined
})

const serveOk = (body: Buffer = PACK): void => {
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Length': body.length })
    res.end(body)
  }
}

const opts = (dest: string, extra: Partial<Parameters<typeof downloadLanguage>[0]> = {}): Parameters<typeof downloadLanguage>[0] => ({
  lang,
  sha256: PACK_SHA,
  baseUrl: base,
  destDir: dest,
  allowHttp: true,
  ...extra
})

describe('language download', () => {
  it('builds the URL from the base and the catalogue code only', () => {
    expect(urlFor('https://example.org/x', 'deu')).toBe('https://example.org/x/deu.traineddata')
    expect(urlFor('https://example.org/x/', 'chi_sim')).toBe('https://example.org/x/chi_sim.traineddata')
  })

  it('downloads, verifies and installs; reports states and monotonic progress; leaves no partial file', async () => {
    serveOk()
    const dest = tmp()
    const states: DownloadState[] = []
    const seen: number[] = []
    const path = await downloadLanguage(opts(dest, { onState: (s) => states.push(s), onProgress: (got) => seen.push(got) }))
    expect(path).toBe(join(dest, 'deu.traineddata'))
    expect(await sha256File(path)).toBe(PACK_SHA)
    expect(readdirSync(dest)).toEqual(['deu.traineddata'])
    expect(states).toEqual(['connecting', 'downloading', 'verifying', 'installing', 'done'])
    expect(seen.length).toBeGreaterThan(0)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(seen[seen.length - 1]).toBe(PACK.length)
  })

  it('refuses content whose SHA-256 does not match, and installs nothing', async () => {
    serveOk(Buffer.concat([PACK.subarray(0, PACK.length - 1), Buffer.from([1])])) // same size, one byte different
    const dest = tmp()
    const states: DownloadState[] = []
    await expect(downloadLanguage(opts(dest, { onState: (s) => states.push(s) }))).rejects.toMatchObject({ kind: 'integrity' })
    expect(readdirSync(dest)).toEqual([])
    expect(states[states.length - 1]).toBe('failed')
  })

  it('a failed download does not damage a pack that is already installed', async () => {
    const dest = tmp()
    serveOk()
    await downloadLanguage(opts(dest))
    serveOk(Buffer.from('tampered'))
    await expect(downloadLanguage(opts(dest))).rejects.toBeInstanceOf(DownloadError)
    expect(readFileSync(join(dest, 'deu.traineddata')).equals(PACK)).toBe(true)
    expect(readdirSync(dest)).toEqual(['deu.traineddata'])
  })

  it('follows a few redirects but not too many', async () => {
    let hops = 0
    handler = (req, res) => {
      const m = /^\/hop(\d+)\//.exec(req.url ?? '')
      const n = m ? Number(m[1]) : 0
      if (n < hops) {
        res.writeHead(302, { Location: `/hop${n + 1}/deu.traineddata` })
        return void res.end()
      }
      res.writeHead(200, { 'Content-Length': PACK.length })
      res.end(PACK)
    }
    hops = 3
    await expect(downloadLanguage(opts(tmp()))).resolves.toMatch(/deu\.traineddata$/)
    hops = 4
    const dest = tmp()
    await expect(downloadLanguage(opts(dest))).rejects.toMatchObject({ kind: 'protocol', message: /too many/ })
    expect(readdirSync(dest)).toEqual([])
    hops = 2
    await expect(downloadLanguage(opts(tmp(), { maxRedirects: 1 }))).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('refuses a redirect to another protocol and a redirect without a target', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'ftp://example.org/deu.traineddata' })
      res.end()
    }
    await expect(downloadLanguage(opts(tmp()))).rejects.toMatchObject({ kind: 'protocol' })
    handler = (_req, res) => {
      res.writeHead(302)
      res.end()
    }
    await expect(downloadLanguage(opts(tmp()))).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('is HTTPS-only unless plain HTTP is explicitly allowed (tests only)', async () => {
    serveOk()
    const dest = tmp()
    await expect(downloadLanguage(opts(dest, { allowHttp: false }))).rejects.toMatchObject({ kind: 'protocol', message: /HTTPS/ })
    expect(readdirSync(dest)).toEqual([])
    // and a redirect from an allowed http server to http is still fine only when allowed
    handler = (_req, res) => {
      res.writeHead(301, { Location: `${base}elsewhere` })
      res.end()
    }
    await expect(downloadLanguage(opts(tmp(), { allowHttp: false }))).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('stops when the server announces more than the size limit', async () => {
    serveOk()
    const dest = tmp()
    await expect(downloadLanguage(opts(dest, { maxBytes: 1000 }))).rejects.toMatchObject({ kind: 'size' })
    expect(readdirSync(dest)).toEqual([])
  })

  it('stops a body that grows past the limit even when it does not announce its size', async () => {
    handler = (_req, res) => {
      res.writeHead(200) // chunked, no Content-Length
      const chunk = Buffer.alloc(64 * 1024, 1)
      let sent = 0
      const timer = setInterval(() => {
        if (res.destroyed || sent > 40) return clearInterval(timer)
        res.write(chunk)
        sent++
      }, 2)
    }
    const dest = tmp()
    await expect(downloadLanguage(opts(dest, { maxBytes: 300 * 1024 }))).rejects.toMatchObject({ kind: 'size' })
    expect(readdirSync(dest)).toEqual([])
  })

  it('rejects an incomplete transfer', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Length': PACK.length })
      res.write(PACK.subarray(0, 1000))
      setTimeout(() => req.socket.destroy(), 20)
    }
    const dest = tmp()
    await expect(downloadLanguage(opts(dest))).rejects.toMatchObject({ kind: 'network' })
    expect(readdirSync(dest)).toEqual([])
  })

  it('reports HTTP errors and unreachable servers clearly', async () => {
    handler = (_req, res) => {
      res.writeHead(404)
      res.end('nope')
    }
    await expect(downloadLanguage(opts(tmp()))).rejects.toMatchObject({ kind: 'network', message: /status 404/ })
    await expect(downloadLanguage(opts(tmp(), { baseUrl: 'http://127.0.0.1:1/' }))).rejects.toMatchObject({ kind: 'network', message: /Could not reach/ })
  })

  it('gives up on a server that stops sending', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': PACK.length })
      res.write(PACK.subarray(0, 10))
    }
    const dest = tmp()
    await expect(downloadLanguage(opts(dest, { idleTimeoutMs: 150 }))).rejects.toMatchObject({ kind: 'network' })
    expect(readdirSync(dest)).toEqual([])
  })

  it('can be cancelled mid-transfer (and before it starts) and cleans up', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': PACK.length })
      res.write(PACK.subarray(0, 5000))
    }
    const dest = tmp()
    const ac = new AbortController()
    const states: DownloadState[] = []
    const p = downloadLanguage(
      opts(dest, {
        signal: ac.signal,
        onState: (s) => states.push(s),
        onProgress: () => ac.abort()
      })
    )
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    expect(readdirSync(dest)).toEqual([])
    expect(states[states.length - 1]).toBe('cancelled')

    const done = new AbortController()
    done.abort()
    await expect(downloadLanguage(opts(dest, { signal: done.signal }))).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

describe('language store', () => {
  const bundled = join('resources', 'ocr')

  it('lists English as installed (bundled) and the rest as not installed until downloaded', async () => {
    const store = new LanguageStore({ bundledDir: bundled, userDir: tmp() })
    const list = await store.list()
    expect(list.find((l) => l.code === 'eng')!.installed).toBe(true)
    expect(list.find((l) => l.code === 'deu')!.installed).toBe(false)
  })

  it('verifies the bundled English data against its pinned hash', async () => {
    const store = new LanguageStore({ bundledDir: bundled, userDir: tmp() })
    await expect(store.verify('eng')).resolves.toMatch(/eng\.traineddata$/)
  })

  it('refuses a missing, tampered or unknown pack with a clear message', async () => {
    const user = tmp()
    const store = new LanguageStore({ bundledDir: bundled, userDir: user })
    await expect(store.verify('deu')).rejects.toThrow(/not installed/)
    writeFileSync(join(user, 'deu.traineddata'), 'not a real pack')
    await expect(store.verify('deu')).rejects.toThrow(/damaged or has been modified/)
    await expect(store.verify('klingon')).rejects.toThrow(/Unsupported/)
    expect(() => store.pathOf('../evil')).toThrow(/Unsupported/)
  })

  it('accepts a pack whose hash matches (test override) and stages verified copies', async () => {
    const user = tmp()
    writeFileSync(join(user, 'deu.traineddata'), PACK)
    const store = new LanguageStore({ bundledDir: bundled, userDir: user, hashOverrides: { deu: PACK_SHA } })
    const stage = join(tmp(), 'stage')
    await store.stageInto(stage, ['eng', 'deu'])
    expect(readdirSync(stage).sort()).toEqual(['deu.traineddata', 'eng.traineddata'])
    expect(readFileSync(join(stage, 'deu.traineddata')).equals(PACK)).toBe(true)
  })

  it('does not stage anything unverified', async () => {
    const user = tmp()
    writeFileSync(join(user, 'deu.traineddata'), 'bad')
    const store = new LanguageStore({ bundledDir: bundled, userDir: user })
    await expect(store.stageInto(join(tmp(), 'stage'), ['eng', 'deu'])).rejects.toThrow(/damaged/)
  })

  it('removes downloaded packs but never the bundled English', async () => {
    const user = tmp()
    writeFileSync(join(user, 'deu.traineddata'), PACK)
    const store = new LanguageStore({ bundledDir: bundled, userDir: user })
    await store.remove('deu')
    expect(existsSync(join(user, 'deu.traineddata'))).toBe(false)
    await expect(store.remove('eng')).rejects.toThrow(/cannot be removed/)
    await expect(store.remove('nope')).rejects.toThrow(/Unsupported/)
  })

  it('sweeps leftovers of interrupted downloads', async () => {
    const user = tmp()
    writeFileSync(join(user, 'deu.traineddata.part'), 'x')
    writeFileSync(join(user, 'fra.traineddata'), 'keep')
    await new LanguageStore({ bundledDir: bundled, userDir: user }).sweepPartials()
    expect(readdirSync(user)).toEqual(['fra.traineddata'])
  })
})
