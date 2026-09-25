import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ScanAcquireSchema } from '../../src/shared/features/scan'
import { chooseBackend, createMacBackend, createStubBackend, createWiaBackend, listStubImages, macHelperSpec, readAnnouncedPage, STUB_DEVICE_ID, type AcquiredPage } from '../../src/main/features/scan/backends'
import { ScanError, codeFromHresult, errorFromMessage, hresultInText } from '../../src/main/features/scan/errors'
import { runHelper } from '../../src/main/features/scan/helper'
import { LineParser } from '../../src/main/features/scan/protocol'
import { WIA_SCRIPT, buildWiaSpec, encodeScript, offeredResolutions, powershellPath } from '../../src/main/features/scan/wia'
import { makePng, solid } from '../support/images'

const STUB_HELPER = resolve('tests/fixtures/scan-stub-helper.mjs')

let work: string
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-scan-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

const req = (over: Partial<Parameters<typeof ScanAcquireSchema.parse>[0]> = {}) =>
  ScanAcquireSchema.parse({ sessionId: 'session-12345', deviceId: 'mac-1', dpi: 200, colorMode: 'color', source: 'flatbed', duplex: false, maxPages: 10, ...over })

const ctxFor = (dir: string, pages: AcquiredPage[], signal = new AbortController().signal) => ({ signal, tempDir: dir, progress: () => undefined, onPage: (p: AcquiredPage) => void pages.push(p) })

describe('protocol line parser', () => {
  it('splits partial chunks, validates messages and keeps noise aside', () => {
    const p = new LineParser()
    expect(p.push('\uFEFF{"type":"devices","dev')).toEqual([])
    const first = p.push('ices":[{"id":"a","name":"A"}]}\r\nWARNING: driver chatter\n{"type":"mystery"}\n{"type":"progress","message":"x"')
    expect(first).toEqual([{ type: 'devices', devices: [{ id: 'a', name: 'A' }] }])
    const rest = p.push('}\n{"type":"done"}')
    expect(rest).toEqual([{ type: 'progress', message: 'x' }])
    expect(p.end()).toEqual([{ type: 'done' }])
    expect(p.noise).toContain('WARNING: driver chatter')
    expect(p.noise.some((n) => n.includes('mystery'))).toBe(true)
  })

  it('rejects out-of-range values and drops runaway lines without growing', () => {
    const p = new LineParser()
    expect(p.push('{"type":"page","index":0,"file":"x"}\n')).toEqual([])
    expect(p.push('y'.repeat(2 * 1024 * 1024))).toEqual([])
    expect(p.push('tail\n{"type":"done"}\n')).toEqual([{ type: 'done' }])
  })
})

describe('error mapping', () => {
  it('maps WIA HRESULTs to actionable messages', () => {
    expect(errorFromMessage({ hresult: '0x80210002' }).message).toMatch(/paper jam/i)
    expect(errorFromMessage({ hresult: '0x80210003' }).message).toMatch(/no paper in the document feeder/i)
    expect(errorFromMessage({ hresult: '0x80210005' }).message).toMatch(/offline|switched off/i)
    expect(errorFromMessage({ hresult: '0x80210006' }).message).toMatch(/busy/i)
    expect(errorFromMessage({ hresult: '0x80210016' }).message).toMatch(/cover/i)
    expect(errorFromMessage({ hresult: '0x8021000D' }).message).toMatch(/in use by another program/i)
    expect(errorFromMessage({ message: 'Exception from HRESULT: 0x80210015' }).code).toBe('not_found')
    expect(errorFromMessage({ code: 'unavailable' }).message).toMatch(/not available/i)
  })

  it('unknown errors keep a short detail; helpers', () => {
    const e = errorFromMessage({ hresult: '0x80004005', message: 'Unspecified error\r\nwith   spaces' })
    expect(e.code).toBe('general')
    expect(e.message).toContain('Unspecified error with spaces')
    expect(codeFromHresult('0x80210002')).toBe('paper_jam')
    expect(codeFromHresult('0x1')).toBeNull()
    expect(hresultInText('boom 0x8021000A here')).toBe('0x8021000A')
  })
})

describe('WIA command construction (no shell, no interpolation)', () => {
  const evil = 'x"; Start-Process calc; $(calc) `n \' \\ {0}'

  it('uses a fixed encoded script and passes parameters only as JSON in the environment', () => {
    const a = buildWiaSpec({ command: 'caps', deviceId: evil }, { SystemRoot: 'C:\\Windows' })
    const b = buildWiaSpec({ command: 'list' }, { SystemRoot: 'C:\\Windows' })
    expect(a.file.toLowerCase()).toBe('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe')
    expect(a.args).toEqual(b.args) // the code never changes with the parameters
    expect(a.args).toContain('-EncodedCommand')
    expect(a.args).toContain('-NoProfile')
    expect(a.args.join(' ')).not.toContain('calc')
    const encoded = a.args[a.args.indexOf('-EncodedCommand') + 1]
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(WIA_SCRIPT)
    expect(encoded).toBe(encodeScript(WIA_SCRIPT))
    expect(JSON.parse(a.env!['EPDF_SCAN_PARAMS']!)).toEqual({ command: 'caps', deviceId: evil })
  })

  it('the script contains no string interpolation of parameters', () => {
    expect(WIA_SCRIPT).not.toMatch(/Invoke-Expression|iex |Add-Type|Start-Process/i)
    expect(WIA_SCRIPT).toContain('ConvertFrom-Json')
    // stays well below the Windows command line limit once base64-encoded as UTF-16
    expect(encodeScript(WIA_SCRIPT).length).toBeLessThan(28000)
  })

  it('powershell path is absolute and falls back to C:\\Windows', () => {
    expect(powershellPath({})).toMatch(/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  })

  it('offers standard resolutions the device supports, with sane fallbacks', () => {
    expect(offeredResolutions([50, 75, 100, 150, 200, 300, 600, 1200, 2400])).toEqual([75, 100, 150, 200, 300, 600, 1200])
    expect(offeredResolutions([])).toEqual([75, 100, 150, 200, 300, 400, 600])
    expect(offeredResolutions([96, 192])).toEqual([96, 192])
    expect(offeredResolutions(Array.from({ length: 50 }, (_, i) => 100 + i * 20)).length).toBeLessThanOrEqual(6)
  })

  it('parses handwritten sample outputs of the script, including a PowerShell warning and an error', () => {
    const list = ['WARNING: Unable to load something\r', '{"type":"devices","devices":[{"id":"{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\\\0000","name":"EPSON Perfection V600","manufacturer":"EPSON"}]}\r', '{"type":"done"}\r', ''].join('\n')
    const p = new LineParser()
    const msgs = p.push(list)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ type: 'devices', devices: [{ name: 'EPSON Perfection V600' }] })
    const err = new LineParser().push('{"type":"error","hresult":"0x80210003","message":"Exception from HRESULT: 0x80210003"}\n')[0]
    expect(err.type === 'error' && errorFromMessage(err).code).toBe('no_paper')
  })

  const onWindows = process.platform === 'win32'
  it.skipIf(!onWindows)('the real script runs on this Windows: enumeration works (0..n scanners) and ends with done', async () => {
    const r = await runHelper(buildWiaSpec({ command: 'list' }), { idleTimeoutMs: 60_000 })
    const devices = r.messages.find((m) => m.type === 'devices')
    expect(devices).toBeTruthy()
    expect(r.messages.at(-1)).toEqual({ type: 'done' })
  }, 90_000)

  it.skipIf(!onWindows)('the real script reports a missing device as a clear "not found" error (capabilities and scan)', async () => {
    const wia = createWiaBackend()
    await expect(wia.capabilities('{00000000-0000-0000-0000-000000000000}\\0000')).rejects.toMatchObject({ code: 'not_found' })
    const dir = join(work, 'wia-missing')
    mkdirSync(dir)
    await expect(wia.acquire(req({ deviceId: '{00000000-0000-0000-0000-000000000000}\\0000' }), ctxFor(dir, []))).rejects.toThrow(/scanner was not found/i)
  }, 90_000)
})

describe('helper runner with the stub helper (macOS protocol double)', () => {
  const backend = createMacBackend(STUB_HELPER)
  const withMode = (mode: string) => createMacBackend(STUB_HELPER, { ...process.env, STUB_MODE: mode })

  it('lists devices and reads capabilities', async () => {
    const devices = await backend.listDevices()
    expect(devices.map((d) => d.id)).toEqual(['mac-1', 'mac-2'])
    const caps = await backend.capabilities('mac-1')
    expect(caps).toEqual({ resolutions: [75, 150, 300, 600], colorModes: ['color', 'gray'], sources: ['flatbed', 'feeder'], duplex: false })
    await expect(backend.capabilities('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('flatbed scan delivers one page; the file is read and removed', async () => {
    const dir = join(work, 'flat')
    const pages: AcquiredPage[] = []
    const n = await backend.acquire(req(), ctxFor(dir, pages))
    expect(n).toBe(1)
    expect(pages).toHaveLength(1)
    expect(pages[0].mime).toBe('image/png')
    expect(pages[0].dpi).toBe(200)
    expect(Array.from(pages[0].bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(readdirSync(dir)).toEqual([])
  })

  it('feeder scan delivers pages in order', async () => {
    const dir = join(work, 'feed')
    const pages: AcquiredPage[] = []
    const n = await backend.acquire(req({ source: 'feeder' }), ctxFor(dir, pages))
    expect(n).toBe(3)
    expect(pages.map((p) => p.index)).toEqual([1, 2, 3])
  })

  it('surfaces a paper jam from the helper as the friendly message', async () => {
    await expect(withMode('jam').acquire(req(), ctxFor(join(work, 'jam'), []))).rejects.toThrow(/paper jam/i)
  })

  it('ignores garbage lines, survives a runaway line, and reports a crash or a missing "done"', async () => {
    expect((await withMode('garbage').listDevices()).map((d) => d.name)).toEqual(['Stub Scanner'])
    expect(await withMode('bigline').listDevices()).toEqual([])
    await expect(withMode('crash').listDevices()).rejects.toThrow(/stopped with an error/i)
    await expect(withMode('nodone').acquire(req(), ctxFor(join(work, 'nodone'), []))).rejects.toThrow(/without finishing/i)
  })

  it('refuses a page file outside the job folder', async () => {
    await expect(withMode('escape').acquire(req(), ctxFor(join(work, 'escape'), []))).rejects.toThrow(/outside its working folder/i)
    await expect(readAnnouncedPage(join(work, 'x'), { type: 'page', index: 1, file: join(work, 'x', '..', 'y.png') }, 100)).rejects.toBeInstanceOf(ScanError)
  })

  it('cancelling kills the helper promptly', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = withMode('slow').acquire(req({ source: 'feeder' }), ctxFor(join(work, 'cancel'), [], ac.signal))
    setTimeout(() => ac.abort(), 150)
    await expect(p).rejects.toThrow('Cancelled')
    expect(Date.now() - started).toBeLessThan(3000)
    await expect(runHelper(macHelperSpec(STUB_HELPER, { command: 'list' }), { signal: ac.signal, idleTimeoutMs: 1000 })).rejects.toThrow('Cancelled')
  })

  it('a helper that goes silent is killed after the idle timeout', async () => {
    const spec = macHelperSpec(STUB_HELPER, { command: 'list' }, { ...process.env, STUB_MODE: 'hang' })
    await expect(runHelper(spec, { idleTimeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('a missing helper program gives a clear message', async () => {
    await expect(runHelper({ file: join(work, 'no-such-helper.exe'), args: [] }, { idleTimeoutMs: 1000 })).rejects.toThrow(/not found/i)
  })
})

describe('test scanner backend (EPDF_SCANNER_STUB)', () => {
  let dir: string
  beforeAll(() => {
    dir = join(work, 'stub-images')
    mkdirSync(dir)
    for (const n of ['page10.png', 'page2.png', 'page1.png']) writeFileSync(join(dir, n), makePng(8, 8, solid(200, 200, 200)))
    writeFileSync(join(dir, 'notes.txt'), 'ignore me')
  })

  it('lists images in natural order', async () => {
    expect(await listStubImages(dir)).toEqual(['page1.png', 'page2.png', 'page10.png'])
    expect(await listStubImages(join(work, 'nope'))).toEqual([])
  })

  it('flatbed hands out one page at a time (cycling), the feeder all of them', async () => {
    const b = createStubBackend(dir)
    expect(await b.listDevices()).toHaveLength(1)
    const caps = await b.capabilities(STUB_DEVICE_ID)
    expect(caps.sources).toEqual(['flatbed', 'feeder'])
    const one: AcquiredPage[] = []
    await b.acquire(req({ deviceId: STUB_DEVICE_ID }), ctxFor(dir, one))
    await b.acquire(req({ deviceId: STUB_DEVICE_ID }), ctxFor(dir, one))
    expect(one).toHaveLength(2)
    const all: AcquiredPage[] = []
    expect(await b.acquire(req({ deviceId: STUB_DEVICE_ID, source: 'feeder' }), ctxFor(dir, all))).toBe(3)
    expect(all.map((p) => p.index)).toEqual([1, 2, 3])
    const capped: AcquiredPage[] = []
    expect(await b.acquire(req({ deviceId: STUB_DEVICE_ID, source: 'feeder', maxPages: 2 }), ctxFor(dir, capped))).toBe(2)
  })

  it('simulated device errors, empty folder, unknown device', async () => {
    await expect(createStubBackend(dir, { EPDF_SCANNER_STUB_ERROR: 'paper_jam' }).acquire(req({ deviceId: STUB_DEVICE_ID }), ctxFor(dir, []))).rejects.toThrow(/paper jam/i)
    const empty = join(work, 'stub-empty')
    mkdirSync(empty)
    await expect(createStubBackend(empty).acquire(req({ deviceId: STUB_DEVICE_ID }), ctxFor(dir, []))).rejects.toThrow(/no pictures/i)
    await expect(createStubBackend(dir).acquire(req({ deviceId: 'other' }), ctxFor(dir, []))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('delay + cancel', async () => {
    const ac = new AbortController()
    const b = createStubBackend(dir, { EPDF_SCANNER_STUB_DELAY_MS: '5000' })
    const p = b.acquire(req({ deviceId: STUB_DEVICE_ID, source: 'feeder' }), ctxFor(dir, [], ac.signal))
    setTimeout(() => ac.abort(), 100)
    await expect(p).rejects.toThrow('Cancelled')
  })
})

describe('backend selection', () => {
  it('picks the right backend or explains why there is none', () => {
    expect(chooseBackend({ platform: 'win32', env: {} })).toMatchObject({ id: 'wia', stub: false })
    expect(chooseBackend({ platform: 'win32', env: { EPDF_SCANNER_STUB: work } })).toMatchObject({ id: 'stub', stub: true })
    const linux = chooseBackend({ platform: 'linux', env: {} })
    expect(linux.backend).toBeNull()
    expect(linux.message).toMatch(/not supported on Linux/i)
    expect(linux.message).toMatch(/webcam or your phone/i)
    expect(chooseBackend({ platform: 'darwin', env: {}, macHelperPath: null }).message).toMatch(/helper/i)
    expect(chooseBackend({ platform: 'darwin', env: {}, macHelperPath: '/x/epdf-mac-scan' })).toMatchObject({ id: 'mac' })
    expect(chooseBackend({ platform: 'win32', env: { EPDF_MAC_SCAN_HELPER: STUB_HELPER, EPDF_SCANNER_STUB: '' } }).id).toBe('wia')
    expect(chooseBackend({ platform: 'linux', env: { EPDF_MAC_SCAN_HELPER: STUB_HELPER } }).id).toBe('mac')
  })

  it('the mac helper runs a script with node and any other file directly', () => {
    expect(macHelperSpec('/a/b.mjs', { command: 'list' }).file).toBe(process.execPath)
    expect(macHelperSpec('/a/epdf-mac-scan', { command: 'list' }).file).toBe('/a/epdf-mac-scan')
    expect(existsSync(STUB_HELPER)).toBe(true)
  })
})
