import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMacBackend, macHelperSpec } from '../../src/main/features/scan/backends'
import { ScanError } from '../../src/main/features/scan/errors'
import { runHelper } from '../../src/main/features/scan/helper'

/**
 * The real macOS scanner helper (resources/native/mac-scan, built by its build.sh into resources/bin/darwin-<arch>/).
 * Runs only on a Mac where it has been built. Needs no scanner: it checks discovery, arguments and error paths.
 */

const HELPER = resolve('resources/bin', `darwin-${process.arch}`, 'epdf-mac-scan')
const available = process.platform === 'darwin' && existsSync(HELPER)

const run = (args: string[], params?: object) =>
  spawnSync(HELPER, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, EPDF_SCAN_PARAMS: params ? JSON.stringify(params) : '' } })
const lines = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe.skipIf(!available)('macOS scanner helper (real binary)', () => {
  const work = available ? mkdtempSync(join(tmpdir(), 'epdf-macscan-')) : ''
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('lists scanners (none attached here) and exits 0 within a few seconds', async () => {
    const started = Date.now()
    const r = await runHelper(macHelperSpec(HELPER, { command: 'list' }), { idleTimeoutMs: 15_000 })
    expect(Date.now() - started).toBeLessThan(12_000)
    const devices = r.messages.find((m) => m.type === 'devices')
    expect(devices).toBeDefined()
    expect(r.messages.at(-1)).toEqual({ type: 'done' })
    expect(r.noise).toEqual([])
    // the backend turns that into the scanner list the dialog shows
    const list = await createMacBackend(HELPER).listDevices()
    for (const d of list) expect(d.id.length).toBeGreaterThan(0)
  }, 30_000)

  it('refuses an unknown command and a scan without an output folder (error line, exit status 2)', () => {
    const bad = run(['bogus'])
    expect(bad.status).toBe(2)
    expect(lines(bad.stdout)).toEqual([{ type: 'error', message: 'Unknown command' }])
    const noArgs = run([])
    expect(noArgs.status).toBe(2)
    const noDir = run(['scan'], { deviceId: 'x', dpi: 300 })
    expect(noDir.status).toBe(2)
    expect(lines(noDir.stdout)).toEqual([{ type: 'error', message: 'No output folder given.' }])
    // the command may also come from the parameters
    const fromParams = run([], { command: 'list' })
    expect(fromParams.status).toBe(0)
    expect(lines(fromParams.stdout).map((m) => m.type)).toEqual(['devices', 'done'])
  }, 60_000)

  it('reports a scanner that is not there as "not found" (capabilities and scan)', async () => {
    const caps = createMacBackend(HELPER).capabilities('no-such-scanner')
    await expect(caps).rejects.toBeInstanceOf(ScanError)
    await expect(caps).rejects.toMatchObject({ code: 'not_found' })
    const scan = createMacBackend(HELPER).acquire(
      { sessionId: 'session-12345', deviceId: 'no-such-scanner', dpi: 300, colorMode: 'color', source: 'flatbed', duplex: false, maxPages: 1 },
      { signal: new AbortController().signal, tempDir: work, progress: () => undefined, onPage: () => undefined }
    )
    await expect(scan).rejects.toMatchObject({ code: 'not_found' })
  }, 60_000)

  it('stops at once when Epdf cancels (the process is terminated)', async () => {
    const ac = new AbortController()
    const p = runHelper(macHelperSpec(HELPER, { command: 'scan', deviceId: 'no-such-scanner', dir: work, dpi: 300, colorMode: 'color', source: 'flatbed', duplex: false, maxPages: 1 }), { signal: ac.signal, idleTimeoutMs: 60_000 })
    setTimeout(() => ac.abort(), 500)
    await expect(p).rejects.toThrow('Cancelled')
  }, 30_000)
})
