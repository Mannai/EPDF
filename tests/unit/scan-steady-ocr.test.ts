import { beforeEach, describe, expect, it } from 'vitest'
import { OCR_COMMAND, isOcrAvailable, requestOcr, type OcrDeps } from '../../src/renderer/src/features/scan/ocr'
import { SteadyTracker } from '../../src/renderer/src/features/scan/steady'
import { PhoneStartSchema, SCAN_SESSION_ID, ScanAcquireSchema, ScanSaveSchema } from '../../src/shared/features/scan'
import type { Quad } from '../../src/shared/features/scan/geometry'

const quad = (dx = 0, dy = 0): Quad => [
  { x: 0.2 + dx, y: 0.1 + dy },
  { x: 0.8 + dx, y: 0.12 + dy },
  { x: 0.78 + dx, y: 0.9 + dy },
  { x: 0.22 + dx, y: 0.88 + dy }
]

describe('steady tracker (auto-capture)', () => {
  it('fires once when the page has been still for enough frames, and never twice for the same page', () => {
    const t = new SteadyTracker({ frames: 4, cooldownMs: 1000 })
    let now = 0
    const fired: number[] = []
    for (let i = 0; i < 30; i++) {
      now += 250
      const r = t.update(quad(Math.sin(i) * 0.002), now) // a little jitter
      if (r.fire) fired.push(i)
    }
    expect(fired).toEqual([3])
  })

  it('does not fire while the page is moving, and reports steady only when still', () => {
    const t = new SteadyTracker({ frames: 4 })
    let now = 0
    for (let i = 0; i < 20; i++) {
      now += 250
      const r = t.update(quad(i * 0.03), now)
      expect(r.fire).toBe(false)
      expect(r.steady).toBe(false)
    }
  })

  it('re-arms when the page leaves the view (next sheet) and captures it too', () => {
    const t = new SteadyTracker({ frames: 3, cooldownMs: 500 })
    let now = 0
    const fired: number[] = []
    const seq: (Quad | null)[] = [...Array(6).fill(quad()), null, null, ...Array(6).fill(quad(0.01, 0.01))]
    seq.forEach((q, i) => {
      now += 300
      if (t.update(q, now).fire) fired.push(i)
    })
    expect(fired).toEqual([2, 10])
  })

  it('re-arms when a clearly different page is shown without a gap; respects the cooldown', () => {
    const t = new SteadyTracker({ frames: 2, cooldownMs: 2000, moveAway: 0.05 })
    const fired: number[] = []
    let now = 0
    for (let i = 0; i < 24; i++) {
      now += 250
      const q = i < 8 ? quad() : quad(0.12, 0.08)
      if (t.update(q, now).fire) fired.push(i)
    }
    expect(fired).toHaveLength(2)
    expect(fired[1] - fired[0]).toBeGreaterThanOrEqual(8)
  })

  it('a lost detection resets the run', () => {
    const t = new SteadyTracker({ frames: 3 })
    expect(t.update(quad(), 0).steady).toBe(false)
    expect(t.update(quad(), 250).steady).toBe(false)
    t.update(null, 500)
    expect(t.update(quad(), 750).steady).toBe(false)
    expect(t.update(quad(), 1000).steady).toBe(false)
    expect(t.update(quad(), 1250).steady).toBe(true)
  })
})

/** The same semantics as features/api.ts (unknown or disabled commands are ignored), without importing the renderer registry. */
function fakeRegistry(): { deps: () => OcrDeps; registerCommand(c: { id: string; label: string; run: (a?: unknown) => void; enabled?: () => boolean }): void } {
  const commands = new Map<string, { run: (a?: unknown) => void; enabled?: () => boolean }>()
  return {
    registerCommand: (c) => void commands.set(c.id, c),
    deps: () => ({
      hasCommand: (id) => commands.has(id),
      runCommand: async (id, args) => {
        const c = commands.get(id)
        if (!c || (c.enabled && !c.enabled())) return
        await c.run(args)
      }
    })
  }
}

describe('Recognize text: soft dependency on the OCR command', () => {
  let reg = fakeRegistry()
  beforeEach(() => (reg = fakeRegistry()))
  const real = (): OcrDeps => reg.deps()
  const registerCommand = (c: Parameters<typeof reg.registerCommand>[0]): void => reg.registerCommand(c)

  it('does nothing (and says it is unavailable) when no ocr.run command exists', async () => {
    expect(isOcrAvailable(real())).toBe(false)
    expect(await requestOcr('doc-1', real())).toBe(false)
  })

  it('runs ocr.run with the new document id when it exists, after the tab is ready', async () => {
    const calls: string[] = []
    registerCommand({ id: OCR_COMMAND, label: 'Recognize text', run: (args) => void calls.push(`run:${JSON.stringify(args)}`) })
    expect(isOcrAvailable(real())).toBe(true)
    const deps: OcrDeps = { ...real(), waitReady: async (id) => void calls.push(`ready:${id}`) }
    expect(await requestOcr('doc-42', deps)).toBe(true)
    expect(calls).toEqual(['ready:doc-42', 'run:{"docId":"doc-42"}'])
  })

  it('a failing OCR command never throws into the save flow', async () => {
    registerCommand({
      id: OCR_COMMAND,
      label: 'Recognize text',
      run: () => {
        throw new Error('OCR exploded')
      }
    })
    expect(await requestOcr('doc-1', real())).toBe(false)
  })

  it('a disabled command is ignored by runCommand (nothing happens)', async () => {
    const calls: string[] = []
    registerCommand({ id: OCR_COMMAND, label: 'Recognize text', run: () => void calls.push('ran'), enabled: () => false })
    expect(await requestOcr('doc-1', real())).toBe(true) // asked politely
    expect(calls).toEqual([]) // but the command declined
  })
})

describe('channel payload schemas', () => {
  it('session ids are short URL-safe tokens', () => {
    expect(SCAN_SESSION_ID.safeParse('abcDEF123_-xyz').success).toBe(true)
    for (const bad of ['', 'short', 'has space here', '../../etc', 'x'.repeat(65)]) expect(SCAN_SESSION_ID.safeParse(bad).success).toBe(false)
    expect(PhoneStartSchema.safeParse({ sessionId: 'abcdefgh1234' }).success).toBe(true)
  })

  it('scan requests are validated: ranges, enums and no extra trust', () => {
    const ok = { sessionId: 'abcdefgh1234', deviceId: 'dev', dpi: 300, colorMode: 'gray', source: 'feeder', duplex: true, maxPages: 20 }
    expect(ScanAcquireSchema.safeParse(ok).success).toBe(true)
    for (const bad of [{ ...ok, dpi: 10 }, { ...ok, dpi: 99999 }, { ...ok, colorMode: 'rainbow' }, { ...ok, source: 'tray9' }, { ...ok, maxPages: 0 }, { ...ok, maxPages: 5000 }, { ...ok, deviceId: '' }, { ...ok, dpi: 300.5 }]) {
      expect(ScanAcquireSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('the save payload needs real bytes', () => {
    expect(ScanSaveSchema.safeParse({ bytes: new Uint8Array([1, 2, 3]), suggestedName: 'x.pdf' }).success).toBe(true)
    expect(ScanSaveSchema.safeParse({ bytes: new Uint8Array(0) }).success).toBe(false)
    expect(ScanSaveSchema.safeParse({ bytes: 'not bytes' }).success).toBe(false)
    expect(ScanSaveSchema.parse({ bytes: new Uint8Array([1]) }).suggestedName).toBe('Scan.pdf')
  })
})
