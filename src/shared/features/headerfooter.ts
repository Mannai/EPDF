import { z } from 'zod'

/**
 * Settings of the page-marks feature (headers and footers, Bates numbering, watermarks, backgrounds), shared by the
 * renderer (dialog, PDF writer) and the main process (presets). The same JSON is stored inside the PDF next to the
 * marks, so a later session can show and update what was applied.
 */

export const SETTINGS_VERSION = 1

/** What one application of the feature adds. Header/footer and Bates are separate so both can be on a page. */
export const GROUPS = ['headerfooter', 'bates', 'watermark', 'background'] as const
export type MarkGroup = (typeof GROUPS)[number]

export const NUMBER_STYLES = ['decimal', 'roman-upper', 'roman-lower', 'arabic-indic', 'persian'] as const
export type NumberStyle = (typeof NUMBER_STYLES)[number]

export const DATE_FORMATS = ['d/m/yyyy', 'm/d/yyyy', 'yyyy-mm-dd', 'dd.mm.yyyy', 'd mmmm yyyy', 'mmmm d, yyyy'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const DIGITS = ['latin', 'arabic-indic', 'persian'] as const
export type Digits = (typeof DIGITS)[number]

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const Direction = z.enum(['auto', 'ltr', 'rtl'])

export const FontSchema = z.object({
  family: z.string().min(1).max(80),
  size: z.number().min(1).max(500),
  color: Color,
  bold: z.boolean(),
  italic: z.boolean()
})
export type FontSettings = z.infer<typeof FontSchema>

export const PageSelectionSchema = z.object({
  /** Page ranges as typed ("1-3, 7, 9-"); empty = all pages. */
  range: z.string().max(2000),
  subset: z.enum(['all', 'odd', 'even'])
})
export type PageSelection = z.infer<typeof PageSelectionSchema>

export const SLOTS = ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight'] as const
export type Slot = (typeof SLOTS)[number]

export const HeaderFooterSchema = z.object({
  slots: z.object({
    topLeft: z.string().max(2000),
    topCenter: z.string().max(2000),
    topRight: z.string().max(2000),
    bottomLeft: z.string().max(2000),
    bottomCenter: z.string().max(2000),
    bottomRight: z.string().max(2000)
  }),
  font: FontSchema,
  /** Distances from the edges of the visible page, in points. */
  margins: z.object({ top: z.number().min(0).max(2000), bottom: z.number().min(0).max(2000), left: z.number().min(0).max(2000), right: z.number().min(0).max(2000) }),
  direction: Direction,
  numberStyle: z.enum(NUMBER_STYLES),
  /** The number shown on the first page of the range. */
  startNumber: z.number().int().min(0).max(1_000_000),
  date: z.object({ format: z.enum(DATE_FORMATS), digits: z.enum(DIGITS), months: z.enum(['en', 'ar']) }),
  bates: z.object({
    prefix: z.string().max(100),
    suffix: z.string().max(100),
    digits: z.number().int().min(1).max(15),
    start: z.number().int().min(0).max(999_999_999_999)
  }),
  pages: PageSelectionSchema
})
export type HeaderFooterSettings = z.infer<typeof HeaderFooterSchema>

export const SourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(4000), font: FontSchema, direction: Direction }),
  z.object({ kind: z.literal('image'), name: z.string().max(260) }),
  z.object({ kind: z.literal('pdf'), name: z.string().max(260), page: z.number().int().min(1).max(100000) }),
  z.object({ kind: z.literal('color'), color: Color })
])
export type SourceSettings = z.infer<typeof SourceSchema>

export const OverlaySchema = z.object({
  source: SourceSchema,
  /** Degrees, counter-clockwise, as the reader sees the page. */
  rotation: z.number().min(-360).max(360),
  /** 0..1 */
  opacity: z.number().min(0).max(1),
  /** relative: the (rotated) mark fits into `percent` % of the visible page; absolute: `percent` % of its natural size. */
  scale: z.object({ mode: z.enum(['relative', 'absolute']), percent: z.number().min(1).max(1000) }),
  position: z.object({
    h: z.enum(['left', 'center', 'right']),
    v: z.enum(['top', 'center', 'bottom']),
    /** Offsets in points: + moves right / up. */
    dx: z.number().min(-5000).max(5000),
    dy: z.number().min(-5000).max(5000)
  }),
  layer: z.enum(['behind', 'front']),
  pages: PageSelectionSchema,
  /** Optional-content usage: show when printing / on screen. */
  print: z.boolean(),
  screen: z.boolean()
})
export type OverlaySettings = z.infer<typeof OverlaySchema>

export type GroupSettings = { group: 'headerfooter' | 'bates'; settings: HeaderFooterSettings } | { group: 'watermark' | 'background'; settings: OverlaySettings }

// ------------------------------------------------------------------------------------------------ defaults

const SANS: FontSettings = { family: 'Noto Sans', size: 10, color: '#000000', bold: false, italic: false }

export function defaultHeaderFooter(): HeaderFooterSettings {
  return {
    slots: { topLeft: '', topCenter: '', topRight: '', bottomLeft: '', bottomCenter: 'Page {page} of {pages}', bottomRight: '' },
    font: { ...SANS },
    margins: { top: 36, bottom: 36, left: 72, right: 72 },
    direction: 'auto',
    numberStyle: 'decimal',
    startNumber: 1,
    date: { format: 'd/m/yyyy', digits: 'latin', months: 'en' },
    bates: { prefix: '', suffix: '', digits: 6, start: 1 },
    pages: { range: '', subset: 'all' }
  }
}

export function defaultBates(): HeaderFooterSettings {
  const s = defaultHeaderFooter()
  s.slots.bottomCenter = ''
  s.slots.bottomRight = '{bates}'
  s.margins = { top: 36, bottom: 24, left: 36, right: 36 }
  return s
}

export function defaultWatermark(): OverlaySettings {
  return {
    source: { kind: 'text', text: 'CONFIDENTIAL', font: { family: 'Noto Sans', size: 72, color: '#c00000', bold: true, italic: false }, direction: 'auto' },
    rotation: 45,
    opacity: 0.3,
    scale: { mode: 'relative', percent: 60 },
    position: { h: 'center', v: 'center', dx: 0, dy: 0 },
    layer: 'front',
    pages: { range: '', subset: 'all' },
    print: true,
    screen: true
  }
}

export function defaultBackground(): OverlaySettings {
  return {
    source: { kind: 'color', color: '#fff4cc' },
    rotation: 0,
    opacity: 1,
    scale: { mode: 'relative', percent: 100 },
    position: { h: 'center', v: 'center', dx: 0, dy: 0 },
    layer: 'behind',
    pages: { range: '', subset: 'all' },
    print: true,
    screen: true
  }
}

export function defaultsFor(group: MarkGroup): GroupSettings {
  switch (group) {
    case 'headerfooter':
      return { group, settings: defaultHeaderFooter() }
    case 'bates':
      return { group, settings: defaultBates() }
    case 'watermark':
      return { group, settings: defaultWatermark() }
    case 'background':
      return { group, settings: defaultBackground() }
  }
}

/** Validates settings of a group (from a preset, the PDF, or the dialog); null if they do not fit. */
export function parseGroupSettings(group: MarkGroup, value: unknown): GroupSettings | null {
  if (group === 'headerfooter' || group === 'bates') {
    const r = HeaderFooterSchema.safeParse(value)
    return r.success ? { group, settings: r.data } : null
  }
  const r = OverlaySchema.safeParse(value)
  return r.success ? { group, settings: r.data } : null
}

// ------------------------------------------------------------------------------------------------ presets

/** Largest image/PDF kept inside a preset (base64 of the bytes). */
export const MAX_PRESET_SOURCE_BYTES = 4 * 1024 * 1024

export const PresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  group: z.enum(GROUPS),
  settings: z.unknown(),
  /** Image or PDF used by an image/PDF watermark or background, base64. */
  sourceData: z.string().max(Math.ceil((MAX_PRESET_SOURCE_BYTES * 4) / 3) + 8).optional()
})
export type Preset = z.infer<typeof PresetSchema>

export const MAX_PRESETS = 100

export const SavePresetSchema = PresetSchema.omit({ id: true }).extend({ id: z.string().min(1).max(64).optional() })
export const DeletePresetSchema = z.object({ id: z.string().min(1).max(64) })
export const ListPresetsSchema = z.object({ group: z.enum(GROUPS).optional() })
export const PickSourceSchema = z.object({ kind: z.enum(['image', 'pdf']) })
export const GetLastSchema = z.object({ group: z.enum(GROUPS) })
export const SetLastSchema = z.object({ group: z.enum(GROUPS), settings: z.unknown() })

export interface PickedSource {
  name: string
  kind: 'png' | 'jpeg' | 'pdf'
  bytes: Uint8Array
}

/** Largest image or PDF accepted as a watermark/background source. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024

export const HF_CHANNELS = {
  listPresets: 'headerfooter:listPresets',
  savePreset: 'headerfooter:savePreset',
  deletePreset: 'headerfooter:deletePreset',
  pickSource: 'headerfooter:pickSource',
  getLast: 'headerfooter:getLast',
  setLast: 'headerfooter:setLast'
} as const
