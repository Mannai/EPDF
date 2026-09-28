import { PDFArray, PDFDict, PDFStream, type PDFDocument, type PDFRef } from 'pdf-lib'
import { rewriteShow } from '../../redact/logic/textRewrite'
import { hasComplexScript } from '@shared/pagetext'
import {
  embeddedFontsFor,
  ensureTextEngine,
  layoutParagraph,
  loadFontFromBytes,
  renameContentResources,
  shapeText,
  uncoveredChars,
  type FontRef,
  type ParagraphLayout,
  type ParagraphOptions,
  type RenderMode,
  type Span,
  type TextColor,
  type TextFont
} from '@shared/text'
import { emitLayout } from '@shared/text/pdf/emit'
import type { ContentSource, PageAnalysis, TextRun } from './analyze'
import type { TextBlock } from './blocks'
import { latin1ToBytes, mkOp, num, parseContent, type Op } from './content'
import type { LogicalAlign, LogicalInfo } from './logical'
import { invert, mul, translate, type Matrix } from './matrix'
import { ddict, dget, dname, streamBytes } from './pdfutil'
import { EditRefusedError, PlanSet, addResource, slotOf } from './write'

/**
 * Replacing a logical (right-to-left / complex-script) block: its glyphs are removed from the content stream (whole
 * operations, or single glyphs of an operation that also draws other text, which keeps its position) together with
 * any /ActualText that would still hold the old words, and the new text is drawn by the text engine (shaped, bidi,
 * /ToUnicode and /ActualText) at the old baseline, size and colour. Right-to-left lines keep their right edge,
 * left-to-right lines their left edge, paragraphs are re-wrapped in their old width with their old alignment and line
 * spacing.
 *
 * The font is the document's own when its embedded program can shape the new text (it has every character, the
 * shaping tables the script needs and real outlines); subset fonts written by producers usually cannot (they keep
 * only the glyphs the document used and drop the shaping tables), and then a bundled Noto font close to the old one is
 * used (Naskh-style for Naskh-like fonts such as Arial / Times New Roman / Traditional Arabic, Noto Sans Arabic for
 * sans fonts such as Tahoma / Segoe UI).
 */

export interface LogicalEditResult {
  /** 'document-font': the document's own font program; 'fallback-font': a bundled font. */
  strategy: 'document-font' | 'fallback-font'
  /** The font family that draws most of the new text. */
  family: string
  /** Why the document's font could not be used (fallback only). */
  why?: string
}

export interface LogicalEditHooks {
  /** Removes marked-content /ActualText from the given runs (shared with the other strategies). */
  stripActualText(plans: PlanSet, analysis: PageAnalysis, runs: TextRun[]): void
  /** Operations that replace a fully removed text-showing operation (keeps the text position when needed). */
  neutralOps(analysis: PageAnalysis, run: TextRun, op: Op, removed: Set<string>): Op[]
}

const refuse = (m: string): EditRefusedError => new EditRefusedError(m)

// ---------------------------------------------------------------------------------------------------------------
// The document's own font

const docFonts = new WeakMap<PDFDict, Promise<{ font: TextFont } | { why: string }>>()

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1]
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

/** OS/2 fsType of an sfnt (0 when absent), or undefined when the bytes are not an sfnt. */
export function sfntFsType(b: Uint8Array): number | undefined {
  if (b.length < 12) return undefined
  const tag = u32(b, 0)
  if (tag !== 0x00010000 && tag !== 0x74727565 /* true */ && tag !== 0x4f54544f /* OTTO */) return undefined
  const n = u16(b, 4)
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    if (o + 16 > b.length) return undefined
    if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) === 'OS/2') {
      const off = u32(b, o + 8)
      return off + 10 <= b.length ? u16(b, off + 8) : 0
    }
  }
  return 0
}

/**
 * The embedded font program behind a font resource, loaded for shaping, or why it can't be used. Only TrueType /
 * OpenType programs (FontFile2, FontFile3/OpenType) whose licence bits allow editable embedding and subsetting.
 */
function documentFont(fontDict: PDFDict): Promise<{ font: TextFont } | { why: string }> {
  let p = docFonts.get(fontDict)
  if (!p) {
    p = (async () => {
      let d: PDFDict | undefined = fontDict
      if (dname(fontDict, 'Subtype') === 'Type0') {
        const desc = dget(fontDict, 'DescendantFonts')
        const first = desc instanceof PDFArray ? desc.lookup(0) : undefined
        d = first instanceof PDFDict ? first : undefined
      }
      const fd = ddict(d, 'FontDescriptor')
      const ff2 = dget(fd, 'FontFile2')
      const ff3 = dget(fd, 'FontFile3')
      const stream = ff2 instanceof PDFStream ? ff2 : ff3 instanceof PDFStream && dname(ff3.dict, 'Subtype') === 'OpenType' ? ff3 : undefined
      if (!stream) return { why: 'the document’s font is not embedded as a TrueType/OpenType program' }
      let bytes: Uint8Array
      try {
        bytes = streamBytes(stream)
      } catch {
        return { why: 'the document’s font program could not be read' }
      }
      const fsType = sfntFsType(bytes)
      if (fsType === undefined) return { why: 'the document’s font program could not be read' }
      // restricted licence, preview & print only, no subsetting, bitmap only
      if (fsType & 0x0002 || fsType & 0x0004 || fsType & 0x0100 || fsType & 0x0200) return { why: 'the document’s font does not allow editing' }
      try {
        const name = (dname(fontDict, 'BaseFont') ?? 'Font').replace(/^[A-Z]{6}\+/, '')
        return { font: await loadFontFromBytes(bytes, { name }) }
      } catch {
        return { why: 'the document’s font program could not be read' }
      }
    })()
    docFonts.set(fontDict, p)
  }
  return p
}

/** Scripts HarfBuzz must substitute glyphs for (joining, conjuncts, reordering). */
const NEEDS_GSUB = /[؀-ࣿﭐ-﷿ﹰ-﻿܀-ݏ߀-߿ऀ-෿ༀ-࿿က-႟ក-៿]/u
const JOINING = /[؀-ࣿ܀-ݏ߀-߿]/u

/**
 * Can this font draw `text` by itself with correct shaping? Every character needs a glyph with an outline; scripts
 * that need glyph substitution (Arabic joining, Indic conjuncts) need the font's GSUB table with the script in it, and
 * a joining letter must really take its joined form (subset fonts often keep only the forms the document used).
 */
export function fontCanShape(font: TextFont, text: string): { ok: true } | { ok: false; why: string } {
  const chars = [...new Set(Array.from(text.replace(/\s/g, '')))]
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!
    if (/\p{M}/u.test(ch) || cp === 0x200c || cp === 0x200d || (cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue
    if (!font.hasGlyph(cp)) return { ok: false, why: 'the document’s font only contains the letters the document used' }
    const gid = font.glyphFor(cp)
    const ext = font.hbFont.glyphExtents(gid)
    if (!ext || (ext.width === 0 && ext.height === 0)) return { ok: false, why: 'the document’s font only contains the letters the document used' }
  }
  if (NEEDS_GSUB.test(text)) {
    let scripts: string[] = []
    try {
      scripts = font.hbFace.getTableScriptTags('GSUB')
    } catch {
      scripts = []
    }
    if (!scripts.length) return { ok: false, why: 'the document’s font has no shaping tables (it was reduced to the glyphs the document used)' }
  }
  if (JOINING.test(text)) {
    // A dual-joining letter of the text must change shape between letters (ZWJ on both sides forces the medial form).
    const probe = Array.from(text).find((c) => /[ب-غف-هيپچکگی]/u.test(c))
    if (probe) {
      const iso = shapeText({ font, rtl: true, script: 'Arab' }, probe)
      const med = shapeText({ font, rtl: true, script: 'Arab' }, `‍${probe}‍`)
      const medGid = Array.from(med.gid).find((_, i) => med.cluster[i] === 1)
      if (medGid === undefined || medGid === iso.gid[0] || medGid === 0) return { ok: false, why: 'the document’s font has no joined letter forms for the new text' }
      const ext = font.hbFont.glyphExtents(medGid)
      if (!ext || (ext.width === 0 && ext.height === 0)) return { ok: false, why: 'the document’s font only contains the letters the document used' }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------------------
// Bundled fallback fonts

const NASKH_LIKE = /times|arial|traditional|simplified|naskh|amiri|scheherazade|majalla|typesetting|lateef|lotus|mitra|nazanin|badr|zar|yagut|traffic|koodak|droidarabicnaskh|kfgqpc|uthman|me.?quran|andalus|aldhabi|urdutypesetting|mudir|decotype|georgia|garamond|cambria/i
const SANS_LIKE = /tahoma|segoe|dubai|notosans|kufi|cairo|tajawal|almarai|helvetica|verdana|sakkal|frutiger|droidsans|vazir|sahel|shabnam|iransans|yekan|opensans|roboto|dejavusans|liberationsans|microsoftsans|mssans|calibri|ibmplex|rubik|harmattan|changa|mada|lalezar|el.?messiri/i
const NASTALIQ = /nasta.?l[ie]+q|nastaleeq|nastaliq/i

export interface FallbackChoice {
  /** For right-to-left and complex-script letters (and their marks). */
  script: FontRef[]
  /** For everything else: Latin letters, digits, spaces, punctuation. */
  other: FontRef[]
  /** The Arabic-script family chosen (for messages / tests). */
  arabic: string
}

const KEEP_WITH_SCRIPT = /[\p{M}‌‍ـ]/u

/**
 * Splits text into pieces of right-to-left / complex-script letters (with their marks, joiners and tatweel) and pieces
 * of everything else, so each can get the fonts closest to what the document used for it.
 */
export function scriptPieces(text: string): { text: string; script: boolean }[] {
  const out: { text: string; script: boolean }[] = []
  for (const ch of text) {
    const prev = out[out.length - 1]
    const script = hasComplexScript(ch) || (KEEP_WITH_SCRIPT.test(ch) && prev?.script === true)
    if (prev && prev.script === script) prev.text += ch
    else out.push({ text: ch, script })
  }
  return out
}

/** Family name from a BaseFont: `ABCDEF+TimesNewRomanPS-BoldMT` -> `Times New Roman`. */
export function familyOfBaseFont(baseFont: string): string {
  return baseFont
    .replace(/^[A-Z]{6}\+/, '')
    .split(/[-,]/)[0]
    .replace(/(PSMT|MT|PS)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

/**
 * The bundled fonts closest to the document's fonts: the Latin family of the line when Epdf has it (Noto Sans,
 * Liberation, Carlito for Calibri, Caladea for Cambria, Liberation Sans for Arial, Liberation Serif for Times New Roman)
 * or else one of the same style, then an Arabic-script family chosen by the name of the font the letters used.
 */
export function fallbackStack(fontName: string, style: { serif: boolean; mono: boolean }, latinFont?: string, programFamily?: string): FallbackChoice {
  const n = (programFamily || fontName).replace(/^[A-Z]{6}\+/, '').replace(/[\s_-]/g, '')
  const generic = style.mono ? 'Courier' : style.serif || /times|georgia|garamond|cambria|traditional|simplified|naskh/i.test(n) ? 'Times' : 'Helvetica'
  let arabic: string
  if (NASTALIQ.test(n)) arabic = 'Noto Nastaliq Urdu'
  else if (SANS_LIKE.test(n) && !/naskh/i.test(n)) arabic = 'Noto Sans Arabic'
  else if (NASKH_LIKE.test(n) || style.serif) arabic = 'Noto Naskh Arabic'
  else arabic = 'Noto Sans Arabic'
  // (names Epdf has no font for, e.g. Segoe UI or Tahoma, are skipped by the engine's font resolution)
  const own = familyOfBaseFont(programFamily || fontName)
  const lat = latinFont ? familyOfBaseFont(latinFont) : ''
  const script: FontRef[] = [...(own ? [own] : []), arabic, generic]
  const other: FontRef[] = [...(lat && !/arab|naskh|kufi|nasta|hebrew|urdu/i.test(lat) ? [lat] : []), generic, arabic]
  return { script, other, arabic }
}

// ---------------------------------------------------------------------------------------------------------------

function engineColor(block: TextBlock, asked: [number, number, number] | null): TextColor {
  if (asked) return asked
  const ops = block.color.ops
  const last = ops[ops.length - 1]
  const nums = (last?.args ?? []).filter((a) => a.t === 'num').map((a) => (a.t === 'num' ? a.v : 0))
  if (last?.op === 'g' && nums.length === 1) return nums[0]
  if (last?.op === 'rg' && nums.length === 3) return [nums[0], nums[1], nums[2]]
  if (last?.op === 'k' && nums.length === 4) return [nums[0], nums[1], nums[2], nums[3]]
  const m = /^#([0-9a-f]{6})$/i.exec(block.color.css)
  if (!m) return 0
  const v = parseInt(m[1], 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

const engineAlign = (a: LogicalAlign): 'left' | 'right' | 'center' | 'justify' => a

/** Text-state operators that undo whatever the page set before (the engine's operators assume the defaults). */
export const TEXT_STATE_RESET = (): Op[] => [mkOp('Tc', num(0)), mkOp('Tw', num(0)), mkOp('Tz', num(100)), mkOp('Ts', num(0)), mkOp('Tr', num(0))]

/**
 * The engine's operators for `content` with the baselines exactly `pitch` apart (the engine's own line boxes follow
 * CSS: a line mixing fonts with different ascents grows, which would move the lines of an edited paragraph away from
 * where the document had them). Origin: the first baseline, at the start of the layout box.
 */
async function fixedPitchContent(
  pdf: PDFDocument,
  content: Span[],
  options: ParagraphOptions,
  pitch: number,
  renderMode: RenderMode
): Promise<{ content: string; fonts: { name: string; ref: PDFRef }[]; states: { name: string; ref: PDFRef }[]; width: number; layout: ParagraphLayout }> {
  const layout = await layoutParagraph(content, options)
  const first = layout.lines[0]
  if (first) layout.lines.forEach((l, i) => (l.y = first.y + first.baseline + i * pitch - l.baseline))
  const emitted = emitLayout({ docText: embeddedFontsFor(pdf), layout, originBaseline: true, renderMode, extraction: 'auto' })
  return {
    content: emitted.content,
    fonts: [...emitted.fonts].map((ef) => ({ name: ef.resourceName, ref: ef.ref })),
    states: [...emitted.states.values()].map((s) => ({ name: s.name, ref: s.ref })),
    width: layout.boxWidth ?? layout.width,
    layout
  }
}

/**
 * Removes the block's glyphs: operations that draw only the block are replaced by what keeps the text position for
 * the operations after them; operations that also draw other text lose just the block's glyphs (the others keep
 * their places). /ActualText around the removed glyphs goes too, so no reader can extract the old words.
 */
function removalPlans(analysis: PageAnalysis, block: TextBlock, hooks: LogicalEditHooks): PlanSet {
  const info = block.logical!
  const plans = new PlanSet()
  const runs = block.runs
  const whole = new Set(runs.filter((r) => info.cover.get(r)?.every(Boolean)).map((r) => r.id))
  for (const run of runs) {
    const flags = info.cover.get(run)
    if (!flags) continue
    const slot = slotOf(analysis, run.addr.source, run.addr.slot)
    const op = slot.ops[run.addr.index]
    if (whole.has(run.id)) plans.replace(slot, run.addr.index, hooks.neutralOps(analysis, run, op, whole))
    else {
      plans.replace(
        slot,
        run.addr.index,
        rewriteShow({ op, strArg: run.strArg, glyphs: run.glyphs.map((g) => ({ el: g.el, off: g.off, n: g.n, disp: g.adv })), covered: flags, size: run.size, hScale: run.hScale })
      )
    }
  }
  hooks.stripActualText(plans, analysis, runs)
  return plans
}

export async function replaceLogicalBlock(
  pdf: PDFDocument,
  analysis: PageAnalysis,
  block: TextBlock,
  newText: string,
  opts: { size?: number; color?: [number, number, number] | null },
  hooks: LogicalEditHooks
): Promise<LogicalEditResult> {
  const info: LogicalInfo = block.logical!
  const source: ContentSource | undefined = analysis.sources.get(block.source)
  if (!source) throw refuse('The page content changed; select the text again.')
  try {
    ensureTextEngine()
  } catch {
    throw refuse('Editing this text needs the text engine, which is not available here. Nothing was changed.')
  }

  if (newText.trim() === '') {
    // Deleting the text: only the removal.
    const plans = removalPlans(analysis, block, hooks)
    plans.apply()
    return { strategy: 'fallback-font', family: '' }
  }

  const size = opts.size !== undefined && Math.abs(opts.size - block.size) > 0.005 ? opts.size : block.size
  const scale = size / block.size
  const leading = (block.leading > 0 ? block.leading : 1.2 * block.size) * scale
  const color = engineColor(block, opts.color ?? null)
  const renderMode = info.renderMode === 1 ? ('stroke' as const) : info.renderMode === 2 ? ('fillStroke' as const) : ('fill' as const)
  const style = { weight: info.bold ? ('bold' as const) : ('normal' as const), italic: info.italic }

  // The document's own font when it can shape the new text, else the closest bundled one.
  let strategy: LogicalEditResult['strategy'] = 'fallback-font'
  let why: string | undefined
  let content: Span[]
  const fontDict = info.mainFontName !== '(ExtGState font)' ? dget(ddict(source.resources, 'Font'), info.mainFontName) : undefined
  const own = fontDict instanceof PDFDict ? await documentFont(fontDict) : { why: 'the document’s font could not be found' }
  // (the family in the embedded program's name table is more telling than a BaseFont like EPDFTX+EpdfText)
  const programFamily = 'font' in own && own.font.family !== 'Font' ? own.font.family : undefined
  const fb = fallbackStack(info.mainFont.baseFont || info.mainFont.displayName, info.mainFont.style, info.latinFont, programFamily)
  const pieces = scriptPieces(newText)
  const fallbackSpans = (): Span[] => pieces.map((p) => ({ text: p.text, fontStack: p.script ? fb.script : fb.other }))
  if ('font' in own) {
    const can = fontCanShape(own.font, newText)
    if (can.ok) {
      content = [{ text: newText, fontStack: [own.font] }]
      strategy = 'document-font'
    } else {
      why = can.why
      content = fallbackSpans()
    }
  } else {
    why = own.why
    content = fallbackSpans()
  }

  const base = { size, lineHeight: leading, ...style, direction: info.dir }
  const missing: string[] = []
  for (const sp of content) for (const c of await uncoveredChars(sp.text, { ...base, fontStack: sp.fontStack })) if (!missing.includes(c)) missing.push(c)
  if (missing.length) {
    throw refuse(`No font that Epdf can use has the character${missing.length > 1 ? 's' : ''} ${missing.slice(0, 5).map((c) => `“${c}”`).join(' ')}. Nothing was changed.`)
  }

  const first = info.lines[0]
  const left = Math.min(...info.lines.map((l) => l.left))
  const right = Math.max(...info.lines.map((l) => l.right))
  const paragraph = block.level === 'paragraph'
  const tc = await fixedPitchContent(
    pdf,
    content,
    { ...base, ...(paragraph ? { width: Math.max(1, right - left), align: engineAlign(info.align) } : { align: 'start' as const }), color },
    leading,
    renderMode
  )
  // Lines: right-to-left text keeps its right edge, left-to-right text its left edge.
  const x = paragraph ? left : info.dir === 'rtl' ? right - tc.width : left
  const y = first.baseline

  // Where the new text goes: after the ET of the last text object involved (the text state there is irrelevant; the
  // engine's operators set everything they need inside q ... Q).
  const runs = block.runs
  let last: TextRun | undefined
  for (const r of runs) {
    if (!r.et) throw refuse('This text is in a text object that is not closed (BT without ET), so it cannot be replaced safely.')
    if (!last || r.et.addr.slot > last.et!.addr.slot || (r.et.addr.slot === last.et!.addr.slot && r.et.addr.index > last.et!.addr.index)) last = r
  }
  if (!last?.et) throw refuse('That text is no longer on the page. Select it again.')
  const inv = invert(last.et.ctm)
  if (!inv) throw refuse('The text sits in a degenerate coordinate system and cannot be replaced.')
  const cm: Matrix = mul(translate(x, y), inv)

  const names = new Map<string, string>()
  for (const f of tc.fonts) names.set(f.name, addResource(pdf, source, 'Font', 'EpdfF', f.ref))
  for (const s of tc.states) names.set(s.name, addResource(pdf, source, 'ExtGState', 'EpdfGS', s.ref))
  const parsed = parseContent(latin1ToBytes(renameContentResources(tc.content, names)))
  // Text state survives BT/ET: reset what the document may have left set (spacing, scaling, rise, render mode).
  const drawn: Op[] = [mkOp('q'), mkOp('cm', ...cm.map(num)), ...TEXT_STATE_RESET(), ...parsed.ops.map((o) => mkOp(o.op, ...o.args)), mkOp('Q')]

  const plans = removalPlans(analysis, block, hooks)
  plans.insertAfter(slotOf(analysis, last.et.addr.source, last.et.addr.slot), last.et.addr.index, drawn)
  plans.apply()

  // The family named to the user: the one drawing most of the right-to-left / complex-script letters (else most glyphs).
  const count = new Map<string, number>()
  const weight = new Map<string, number>()
  for (const line of tc.layout.lines) {
    for (const run of line.runs) {
      count.set(run.font.family, (count.get(run.font.family) ?? 0) + run.glyphs.length)
      const n = run.glyphs.filter((g) => g.chars > 0 && hasComplexScript(newText.slice(g.cluster, g.cluster + g.chars))).length
      if (n) weight.set(run.font.family, (weight.get(run.font.family) ?? 0) + n)
    }
  }
  const pick = (m: Map<string, number>): string | undefined => [...m].sort((a, b) => b[1] - a[1])[0]?.[0]
  const family = pick(weight) ?? pick(count) ?? fb.arabic
  return { strategy, family: strategy === 'document-font' ? info.mainFont.displayName.replace(/^[A-Z]{6}\+/, '') : family, ...(why ? { why } : {}) }
}
