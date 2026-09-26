import { describe, expect, it } from 'vitest'
import { MAX_PRESETS, SavePresetSchema, defaultBates, defaultHeaderFooter, defaultWatermark, parseGroupSettings } from '../../src/shared/features/headerfooter'
import { PresetStore, type KvLike } from '../../src/main/features/headerfooter/presets'
import { sniffSource } from '../../src/main/features/headerfooter/sniff'

/** Presets and last-used settings (main process, feature key/value store). */

class MemKv implements KvLike {
  data = new Map<string, string>()
  get<T>(key: string, fallback: T): T {
    const v = this.data.get(key)
    if (v === undefined) return fallback
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  }
  set(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value))
  }
}

describe('presets', () => {
  it('save, list per group (sorted), replace by name, delete', () => {
    const store = new PresetStore(new MemKv())
    const a = store.save({ name: 'Footer: page X of N', group: 'headerfooter', settings: defaultHeaderFooter() })
    store.save({ name: 'Arabic header', group: 'headerfooter', settings: { ...defaultHeaderFooter(), direction: 'rtl' } })
    store.save({ name: 'Draft', group: 'watermark', settings: defaultWatermark() })
    expect(store.list('headerfooter').map((p) => p.name)).toEqual(['Arabic header', 'Footer: page X of N'])
    expect(store.list('watermark').map((p) => p.name)).toEqual(['Draft'])
    expect(store.list().length).toBe(3)
    // same name (any case) in the same group replaces, keeping the id
    const again = store.save({ name: 'footer: PAGE x of n', group: 'headerfooter', settings: { ...defaultHeaderFooter(), startNumber: 5 } })
    expect(again.id).toBe(a.id)
    expect(store.list('headerfooter').length).toBe(2)
    expect((store.list('headerfooter').find((p) => p.id === a.id)!.settings as { startNumber: number }).startNumber).toBe(5)
    expect(store.delete(a.id)).toBe(true)
    expect(store.delete(a.id)).toBe(false)
    expect(store.list('headerfooter').map((p) => p.name)).toEqual(['Arabic header'])
  })

  it('keeps a picture with the preset, within the size limit', () => {
    const store = new PresetStore(new MemKv())
    const w = defaultWatermark()
    w.source = { kind: 'image', name: 'logo.png' }
    const p = store.save({ name: 'Logo', group: 'watermark', settings: w, sourceData: Buffer.from('fake png').toString('base64') })
    expect(store.list('watermark')[0]!.sourceData).toBe(p.sourceData)
    expect(() => store.save({ name: 'Huge', group: 'watermark', settings: w, sourceData: 'A'.repeat(6 * 1024 * 1024) })).toThrow(/larger than/)
  })

  it('refuses invalid settings and empty names; drops damaged stored entries', () => {
    const kv = new MemKv()
    const store = new PresetStore(kv)
    expect(() => store.save({ name: 'Bad', group: 'headerfooter', settings: { slots: 1 } })).toThrow(/cannot be saved/)
    expect(() => store.save({ name: 'Bad', group: 'watermark', settings: defaultHeaderFooter() })).toThrow(/cannot be saved/)
    expect(() => store.save({ name: '   ', group: 'bates', settings: defaultBates() })).toThrow(/name/)
    kv.set('presets', [{ id: 'x', name: 'broken', group: 'headerfooter', settings: { nope: true } }, { id: 'y', name: 'ok', group: 'bates', settings: defaultBates() }, 'garbage'])
    expect(store.list().map((p) => p.name)).toEqual(['ok'])
    kv.data.set('presets', '{not json')
    expect(store.list()).toEqual([])
  })

  it(`at most ${MAX_PRESETS} presets`, () => {
    const store = new PresetStore(new MemKv())
    for (let i = 0; i < MAX_PRESETS; i++) store.save({ name: `p${i}`, group: 'bates', settings: defaultBates() })
    expect(() => store.save({ name: 'one more', group: 'bates', settings: defaultBates() })).toThrow(/up to/)
  })

  it('remembers the last settings per group (validated)', () => {
    const store = new PresetStore(new MemKv())
    expect(store.getLast('watermark')).toBeNull()
    const w = { ...defaultWatermark(), opacity: 0.7 }
    store.setLast('watermark', w)
    expect(store.getLast('watermark')).toEqual(w)
    store.setLast('watermark', { garbage: true })
    expect(store.getLast('watermark')).toEqual(w)
  })

  it('the channel schema validates payloads', () => {
    expect(SavePresetSchema.safeParse({ name: 'x', group: 'headerfooter', settings: {} }).success).toBe(true)
    expect(SavePresetSchema.safeParse({ name: '', group: 'headerfooter', settings: {} }).success).toBe(false)
    expect(SavePresetSchema.safeParse({ name: 'x', group: 'other', settings: {} }).success).toBe(false)
    expect(parseGroupSettings('bates', defaultBates())?.group).toBe('bates')
  })
})

describe('picked files are identified by content, not by extension', () => {
  it('PNG, JPEG, PDF and garbage', () => {
    expect(sniffSource(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('png')
    expect(sniffSource(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffSource(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf')
    expect(sniffSource(new TextEncoder().encode('not a picture'))).toBeNull()
  })
})
