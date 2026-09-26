import { hbSync } from './hb'
import type { TextFont } from './fonts'
import type * as HB from './vendor/harfbuzz/index.mjs'

/**
 * Shaping with HarfBuzz: text -> glyph ids with cluster mapping, advances and GPOS offsets (mark positioning,
 * kerning, cursive attachment), in the visual order of the run (right-to-left runs come out left-to-right).
 * Results are cached per (font, direction, script, language, features, text).
 */

/** OpenType feature toggles: `{ liga: false, smcp: true, ss01: 1 }` or a CSS-like list `'liga=0, smcp'`. */
export type FeatureSettings = Record<string, boolean | number> | string

export interface ShapeParams {
  font: TextFont
  rtl: boolean
  /** ISO 15924 script tag ('Arab', 'Latn', 'Deva', ...). Common/unknown: HarfBuzz guesses. */
  script?: string
  /** BCP 47 language tag ('ar', 'ur', 'fa', 'hi', 'ja', ...). */
  lang?: string
  features?: FeatureSettings
}

export interface ShapedRun {
  length: number
  gid: Uint32Array
  /** UTF-16 index (relative to the shaped text) of the first source character of each glyph's cluster. */
  cluster: Uint32Array
  /** Advance and offset per glyph in font units. */
  ax: Int32Array
  ay: Int32Array
  dx: Int32Array
  dy: Int32Array
}

/** Normalise feature settings into 'tag=value' entries (sorted; stable cache key). */
export function normalizeFeatures(f: FeatureSettings | undefined): string[] {
  if (!f) return []
  const out = new Map<string, number>()
  if (typeof f === 'string') {
    for (const part of f.split(',')) {
      const m = /^\s*"?([A-Za-z0-9 ]{4})"?\s*(?:=\s*(\d+|on|off))?\s*$/.exec(part)
      if (!m) continue
      const v = m[2] === undefined || m[2] === 'on' ? 1 : m[2] === 'off' ? 0 : Number(m[2])
      out.set(m[1]!, v)
    }
  } else {
    for (const [k, v] of Object.entries(f)) if (k.length === 4) out.set(k, v === true ? 1 : v === false ? 0 : v)
  }
  return [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`)
}

const featureObjects = new Map<string, HB.Feature[]>()

function hbFeatures(hb: typeof HB, list: string[]): HB.Feature[] {
  if (list.length === 0) return []
  const key = list.join(',')
  let r = featureObjects.get(key)
  if (!r) {
    r = []
    for (const s of list) {
      const f = hb.Feature.fromString(s)
      if (f) r.push(f)
    }
    featureObjects.set(key, r)
  }
  return r
}

const CACHE_LIMIT = 60_000
const cache = new Map<string, ShapedRun>()
let buffer: HB.Buffer | null = null
const stats = { hits: 0, misses: 0 }

export function shapingCacheStats(): { hits: number; misses: number; size: number } {
  return { ...stats, size: cache.size }
}

export function clearShapingCache(): void {
  cache.clear()
  stats.hits = stats.misses = 0
}

/** Shape `text` (one script, one direction, one font). Never throws for unknown characters: they get glyph 0. */
export function shapeText(p: ShapeParams, text: string): ShapedRun {
  const feats = normalizeFeatures(p.features)
  const key = `${p.font.key}\u0001${p.rtl ? 'r' : 'l'}${p.script ?? ''}\u0001${p.lang ?? ''}\u0001${feats.join(',')}\u0001${text}`
  const hit = cache.get(key)
  if (hit) {
    stats.hits++
    return hit
  }
  stats.misses++
  const hb = hbSync()
  const buf = (buffer ??= new hb.Buffer())
  buf.reset()
  buf.addText(text)
  buf.setDirection(p.rtl ? hb.Direction.RTL : hb.Direction.LTR)
  if (p.script && p.script !== 'Zyyy' && p.script !== 'Zzzz' && p.script !== 'Zinh') buf.setScript(p.script)
  if (p.lang) buf.setLanguage(p.lang)
  // Character-level clusters: a mark keeps its own cluster (its own text), while glyphs that came from ONE character
  // (a letter and its dot components) or a ligature of several share one.
  buf.setClusterLevel(hb.ClusterLevel.CHARACTERS)
  if (!p.script || p.script === 'Zyyy' || p.script === 'Zzzz' || p.script === 'Zinh') {
    // Let HarfBuzz pick the script from the text while keeping our direction/language.
    const dir = p.rtl ? hb.Direction.RTL : hb.Direction.LTR
    buf.guessSegmentProperties()
    buf.setDirection(dir)
  }
  hb.shape(p.font.hbFont, buf, hbFeatures(hb, feats))
  const infos = buf.getGlyphInfos()
  const pos = buf.getGlyphPositions()
  const n = infos.length
  const run: ShapedRun = {
    length: n,
    gid: new Uint32Array(n),
    cluster: new Uint32Array(n),
    ax: new Int32Array(n),
    ay: new Int32Array(n),
    dx: new Int32Array(n),
    dy: new Int32Array(n)
  }
  for (let i = 0; i < n; i++) {
    const g = infos[i]!
    const q = pos[i]!
    run.gid[i] = g.codepoint
    run.cluster[i] = g.cluster
    run.ax[i] = q.xAdvance
    run.ay[i] = q.yAdvance
    run.dx[i] = q.xOffset
    run.dy[i] = q.yOffset
  }
  if (cache.size >= CACHE_LIMIT) {
    let drop = CACHE_LIMIT >> 1
    for (const k of cache.keys()) {
      cache.delete(k)
      if (--drop <= 0) break
    }
  }
  cache.set(key, run)
  return run
}
