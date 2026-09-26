import { randomUUID } from 'node:crypto'
import { MAX_PRESETS, MAX_PRESET_SOURCE_BYTES, PresetSchema, parseGroupSettings, type MarkGroup, type Preset } from '../../../shared/features/headerfooter'

/**
 * Saved presets for headers/footers, Bates numbers, watermarks and backgrounds, and the last settings used per group,
 * kept in the feature's key/value store (`ctx.kv('headerfooter')`). Everything read back is validated again: a
 * damaged or outdated entry is dropped, never handed to the renderer.
 */

export interface KvLike {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

const PRESETS_KEY = 'presets'
const lastKey = (g: MarkGroup): string => `last:${g}`

export class PresetStore {
  constructor(private readonly kv: KvLike) {}

  private all(): Preset[] {
    const raw = this.kv.get<unknown>(PRESETS_KEY, [])
    if (!Array.isArray(raw)) return []
    const out: Preset[] = []
    for (const r of raw) {
      const p = PresetSchema.safeParse(r)
      if (p.success && parseGroupSettings(p.data.group, p.data.settings)) out.push(p.data)
    }
    return out
  }

  list(group?: MarkGroup): Preset[] {
    const all = this.all()
    return (group ? all.filter((p) => p.group === group) : all).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Saves (or, with the same id or the same name in the same group, replaces) a preset. */
  save(input: { id?: string; name: string; group: MarkGroup; settings: unknown; sourceData?: string }): Preset {
    const parsed = parseGroupSettings(input.group, input.settings)
    if (!parsed) throw new Error('These settings cannot be saved as a preset (some values are out of range).')
    if (input.sourceData && (input.sourceData.length * 3) / 4 > MAX_PRESET_SOURCE_BYTES + 3) {
      throw new Error(`The picture or PDF is larger than ${MAX_PRESET_SOURCE_BYTES / (1024 * 1024)} MB and cannot be kept in a preset.`)
    }
    const name = input.name.trim()
    if (!name) throw new Error('Give the preset a name.')
    const all = this.all()
    const existing = all.find((p) => (input.id && p.id === input.id) || (p.group === input.group && p.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
    const preset: Preset = { id: existing?.id ?? input.id ?? randomUUID(), name, group: input.group, settings: parsed.settings, ...(input.sourceData ? { sourceData: input.sourceData } : {}) }
    const next = existing ? all.map((p) => (p.id === existing.id ? preset : p)) : [...all, preset]
    if (next.length > MAX_PRESETS) throw new Error(`You can keep up to ${MAX_PRESETS} presets. Delete one first.`)
    this.kv.set(PRESETS_KEY, next)
    return preset
  }

  delete(id: string): boolean {
    const all = this.all()
    const next = all.filter((p) => p.id !== id)
    if (next.length === all.length) return false
    this.kv.set(PRESETS_KEY, next)
    return true
  }

  getLast(group: MarkGroup): unknown | null {
    const v = this.kv.get<unknown>(lastKey(group), null)
    const parsed = v === null ? null : parseGroupSettings(group, v)
    return parsed ? parsed.settings : null
  }

  setLast(group: MarkGroup, settings: unknown): void {
    const parsed = parseGroupSettings(group, settings)
    if (parsed) this.kv.set(lastKey(group), parsed.settings)
  }
}
