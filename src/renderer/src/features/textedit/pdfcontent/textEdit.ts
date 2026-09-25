import { Encodings } from '@pdf-lib/standard-fonts'
import fontkit from '@pdf-lib/fontkit'
import { PDFDict, PDFDocument, PDFName, StandardFonts, type PDFFont } from 'pdf-lib'
import { analyzePage, addrKey, type PageAnalysis, type RunGlyph, type StreamSlot, type TextRun } from './analyze'
import { buildBlocks, findBlock, type Atom, type TextBlock } from './blocks'
import { arr, mkOp, num, name as nameObj, str, withArgs, type Op, type PdfObj } from './content'
import type { FontStyle } from './fonts'
import { invert, mul, type Matrix } from './matrix'
import { ddict, dget, dname, nameText } from './pdfutil'
import { EditRefusedError, PlanSet, addResource, commitSources, slotOf } from './write'

/**
 * Editing text in the page content. Two strategies, chosen automatically and reported to the caller:
 *
 *  1. in place: rewrite the string operands of the existing Tj/TJ/'/" operations, keeping the document's own
 *     font, kerning and positioning (only possible when every new character can be encoded with that font);
 *  2. replace: remove the block's text-showing operations and draw the new text at the same position, with
 *     the document's font when it can encode the text, otherwise the closest standard font or, for characters
 *     outside WinAnsi, a bundled Unicode font.
 */

export interface FontLoader {
  /** Bytes of a bundled Unicode TrueType font (OFL) for the style. */
  unicodeFont(style: FontStyle): Promise<Uint8Array>
}

export interface TextEditRequest {
  blockId: string
  /** The text the editor was opened with: must still match the document. */
  oldText: string
  newText: string
  /** New font size in points (user space), or undefined to keep. */
  size?: number
  /** New color as `#rrggbb`, or undefined to keep. */
  color?: string
}

export type TextStrategy = 'in-place' | 'document-font' | 'fallback-font'

export interface TextEditResult {
  strategy: TextStrategy
  message: string
  /** Set when nothing needed to change. */
  noop?: boolean
  warnings: string[]
}

const refuse = (m: string): EditRefusedError => new EditRefusedError(m)
const normalize = (s: string): string => s.replace(/\r\n?/g, '\n')
const hexToRgb = (h: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(h)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

// ---------------------------------------------------------------------------------------------------------
// ActualText

/** Marked-content properties like /ActualText would keep the OLD text extractable: drop them from edited runs. */
function stripActualText(plans: PlanSet, analysis: PageAnalysis, runs: TextRun[]): void {
  const done = new Set<string>()
  for (const run of runs) {
    for (const m of run.marked) {
      const key = addrKey(m.addr)
      if (done.has(key)) continue
      done.add(key)
      const slot = slotOf(analysis, m.addr.source, m.addr.slot)
      const op = slot.ops[m.addr.index]
      const props = op.args[1]
      if (op.op !== 'BDC' || props?.t !== 'dict') continue
      const next = new Map(props.v)
      next.delete('ActualText')
      next.delete('Alt')
      next.delete('E')
      plans.replace(slot, m.addr.index, [withArgs(op, [op.args[0], { t: 'dict', v: next }])])
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Strategy 1: in place

interface InsertCodes {
  bytes: number[]
}

interface RunEdit {
  run: TextRun
  deleted: Set<number>
  before: Map<number, InsertCodes>
  after: Map<number, InsertCodes>
}

function atomBoundaries(atoms: Atom[]): number[] {
  const b = [0]
  for (const a of atoms) b.push(b[b.length - 1] + a.text.length)
  return b
}

function planInPlace(analysis: PageAnalysis, block: TextBlock, newText: string): RunEdit[] | null {
  const old = block.text
  let p = 0
  while (p < old.length && p < newText.length && old[p] === newText[p]) p++
  let s = 0
  while (s < old.length - p && s < newText.length - p && old[old.length - 1 - s] === newText[newText.length - 1 - s]) s++
  const bounds = atomBoundaries(block.atoms)
  const boundarySet = new Set(bounds)
  // Snap the changed region outwards to whole characters of the document (a ligature is one code).
  while (p > 0 && !boundarySet.has(p)) p--
  let suffixStart = old.length - s
  while (suffixStart < old.length && !boundarySet.has(suffixStart)) suffixStart++
  const tail = old.length - suffixStart
  const inserted = newText.slice(p, newText.length - tail)
  if (newText.length - tail < p) return null
  if (inserted.includes('\n')) return null

  const firstAtom = bounds.indexOf(p)
  const endAtom = bounds.indexOf(suffixStart)
  if (firstAtom < 0 || endAtom < 0) return null
  const removedAtoms = block.atoms.slice(firstAtom, endAtom)
  if (removedAtoms.some((a) => a.kind !== 'glyph')) return null

  const edits = new Map<TextRun, RunEdit>()
  const editOf = (run: TextRun): RunEdit => {
    let e = edits.get(run)
    if (!e) edits.set(run, (e = { run, deleted: new Set(), before: new Map(), after: new Map() }))
    return e
  }
  for (const a of removedAtoms) if (a.kind === 'glyph') editOf(a.run).deleted.add(a.glyph)

  if (inserted !== '') {
    let anchor: { run: TextRun; glyph: number; where: 'before' | 'after' } | null = null
    if (removedAtoms.length) {
      const a = removedAtoms[0]
      if (a.kind === 'glyph') anchor = { run: a.run, glyph: a.glyph, where: 'before' }
    } else {
      const left = block.atoms[firstAtom - 1]
      const right = block.atoms[firstAtom]
      if (left?.kind === 'glyph') anchor = { run: left.run, glyph: left.glyph, where: 'after' }
      else if (right?.kind === 'glyph') anchor = { run: right.run, glyph: right.glyph, where: 'before' }
    }
    if (!anchor) return null
    const used = analysis.fontUsage.get(anchor.run.font) ?? new Set<number>()
    const bytes: number[] = []
    for (const ch of inserted) {
      const enc = anchor.run.font.encode(ch, used)
      if (!enc) return null
      bytes.push(...enc)
    }
    const e = editOf(anchor.run)
    ;(anchor.where === 'before' ? e.before : e.after).set(anchor.glyph, { bytes })
  }
  return [...edits.values()]
}

function sliceOf(orig: Uint8Array, g: RunGlyph): number[] {
  return Array.from(orig.subarray(g.off, g.off + g.n))
}

function rewriteRun(plans: PlanSet, analysis: PageAnalysis, edit: RunEdit): void {
  const run = edit.run
  const slot = slotOf(analysis, run.addr.source, run.addr.slot)
  const op = slot.ops[run.addr.index]
  const groups = new Map<number, RunGlyph[]>()
  run.glyphs.forEach((g) => {
    const l = groups.get(g.el)
    if (l) l.push(g)
    else groups.set(g.el, [g])
  })
  const gi = new Map<RunGlyph, number>()
  run.glyphs.forEach((g, i) => gi.set(g, i))

  const rebuilt = (orig: Uint8Array, gl: RunGlyph[]): number[] => {
    const out: number[] = []
    for (const g of gl) {
      const i = gi.get(g)!
      const b = edit.before.get(i)
      if (b) out.push(...b.bytes)
      if (!edit.deleted.has(i)) out.push(...sliceOf(orig, g))
      const a = edit.after.get(i)
      if (a) out.push(...a.bytes)
    }
    return out
  }

  const strArg = run.strArg
  const args: PdfObj[] = [...op.args]
  if (op.op === 'TJ') {
    const array = op.args[0]
    if (array.t !== 'arr') throw refuse('The text operation is not in a shape Epdf can edit.')
    const items: PdfObj[] = []
    array.v.forEach((el, i) => {
      if (el.t !== 'str') return void items.push(el)
      const gl = groups.get(i) ?? []
      const bytes = rebuilt(el.b, gl)
      // Drop strings that became empty; kerning numbers around them stay.
      if (bytes.length || gl.length === 0) items.push({ t: 'str', b: Uint8Array.from(bytes), hex: el.hex })
    })
    args[0] = arr(...items)
  } else {
    const el = op.args[strArg]
    if (el.t !== 'str') throw refuse('The text operation is not in a shape Epdf can edit.')
    args[strArg] = { t: 'str', b: Uint8Array.from(rebuilt(el.b, groups.get(-1) ?? [])), hex: el.hex }
  }
  plans.replace(slot, run.addr.index, [withArgs(op, args)])
}

// ---------------------------------------------------------------------------------------------------------
// Strategy 2: replace

/** Does the next show operation depend on where this one ended (no repositioning in between)? */
function dependsOnAdvance(analysis: PageAnalysis, run: TextRun, removed: Set<string>): boolean {
  const src = analysis.sources.get(run.addr.source)!
  for (let s = run.addr.slot; s < src.slots.length; s++) {
    const ops = src.slots[s].ops
    for (let i = s === run.addr.slot ? run.addr.index + 1 : 0; i < ops.length; i++) {
      switch (ops[i].op) {
        case 'Tj':
        case 'TJ':
          return !removed.has(addrKey({ source: run.addr.source, slot: s, index: i }))
        case "'":
        case '"':
        case 'T*':
        case 'Td':
        case 'TD':
        case 'Tm':
        case 'BT':
        case 'ET':
          return false
      }
    }
  }
  return false
}

function neutralOps(analysis: PageAnalysis, run: TextRun, op: Op, removed: Set<string>): Op[] {
  const out: Op[] = []
  if (op.op === "'") out.push(mkOp('T*'))
  else if (op.op === '"') out.push(mkOp('Tw', op.args[0]), mkOp('Tc', op.args[1]), mkOp('T*'))
  const d = run.size * run.hScale
  if (d !== 0 && run.advance !== 0 && dependsOnAdvance(analysis, run, removed)) {
    out.push(mkOp('TJ', arr(num((-run.advance / d) * 1000))))
  }
  return out
}

interface Measurer {
  width(s: string): number
  /** Bytes of the string operand for one line. */
  encode(s: string): Uint8Array
}

/** Greedy wrap: explicit newlines are kept; words longer than a line are broken by characters. */
export function wrapLines(text: string, measure: (s: string) => number, maxWidth: (lineIndex: number) => number): string[] {
  const out: string[] = []
  const limit = (): number => Math.max(maxWidth(out.length), 0)
  for (const para of text.split('\n')) {
    let cur = ''
    const flush = (): void => {
      out.push(cur.trimEnd())
      cur = ''
    }
    for (let tok of para.match(/\S+\s*|\s+/g) ?? []) {
      if (cur !== '' && measure((cur + tok).trimEnd()) > limit()) flush()
      // A word longer than a whole line is cut into pieces that each fit (at least one character).
      while (cur === '' && Array.from(tok.trimEnd()).length > 1 && measure(tok.trimEnd()) > limit()) {
        const chars = Array.from(tok)
        let n = 1
        while (n < chars.length - 1 && measure(chars.slice(0, n + 1).join('').trimEnd()) <= limit()) n++
        out.push(chars.slice(0, n).join('').trimEnd())
        tok = chars.slice(n).join('')
      }
      cur += tok
    }
    flush()
  }
  return out
}

const STANDARD_BY_STYLE = (s: FontStyle): StandardFonts => {
  if (s.mono) return s.bold ? (s.italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : s.italic ? StandardFonts.CourierOblique : StandardFonts.Courier
  if (s.serif) return s.bold ? (s.italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : s.italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
  return s.bold ? (s.italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : s.italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
}

const winAnsiCan = (text: string): boolean => {
  for (const ch of text.replace(/\n/g, '')) if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0)!)) return false
  return true
}

const hexBytes = (h: { asBytes(): Uint8Array }): Uint8Array => h.asBytes()

/** Reuses a standard font the page already has (same BaseFont, WinAnsi, not embedded) instead of adding another. */
function findExistingStandard(analysis: PageAnalysis, sourceId: string, std: StandardFonts): string | undefined {
  const src = analysis.sources.get(sourceId)
  const fonts = ddict(src?.resources, 'Font')
  if (!fonts) return undefined
  for (const [k] of fonts.entries()) {
    const fd = fonts.lookup(k)
    if (!(fd instanceof PDFDict)) continue
    if (dname(fd, 'Subtype') !== 'Type1' || dname(fd, 'BaseFont') !== std || dget(fd, 'FontDescriptor')) continue
    const enc = dget(fd, 'Encoding')
    const encName = enc instanceof PDFName ? nameText(enc) : enc instanceof PDFDict ? dname(enc, 'BaseEncoding') : undefined
    const hasDiffs = enc instanceof PDFDict && !!dget(enc, 'Differences')
    if (encName === 'WinAnsiEncoding' && !hasDiffs) return nameText(k)
  }
  return undefined
}

interface ReplaceOutcome {
  strategy: TextStrategy
  message: string
}

async function replaceBlock(
  pdf: PDFDocument,
  analysis: PageAnalysis,
  block: TextBlock,
  newText: string,
  req: TextEditRequest,
  loader: FontLoader | undefined
): Promise<ReplaceOutcome> {
  const first = block.lines[0].runs[0]
  const source = analysis.sources.get(block.source)!
  const m = first.matrix

  // Insertion point: after the ET of the last text object involved.
  const withEt = block.runs.filter((r) => r.et)
  if (withEt.length !== block.runs.length) throw refuse('This text is in a text object that is not closed (BT without ET), so it cannot be replaced safely.')
  const last = withEt.reduce((a, b) => (b.et!.addr.slot > a.et!.addr.slot || (b.et!.addr.slot === a.et!.addr.slot && b.et!.addr.index > a.et!.addr.index) ? b : a))
  const etCtm = last.et!.ctm
  const inv = invert(etCtm)
  if (!inv) throw refuse('The text sits in a degenerate coordinate system and cannot be replaced.')
  const tm: Matrix = mul(m, inv)

  const newSize = req.size !== undefined && Math.abs(req.size - block.size) > 0.005 ? req.size / Math.abs(m[3]) : first.size
  const scale = newSize / first.size
  const th = first.hScale
  const leadingUser = (block.leading > 0 ? block.leading : 1.2 * block.size) * scale
  const oldRight = Math.max(...block.lines.map((l) => l.x1))
  const originX0 = m[4]
  const pageW = pdf.getPage(analysis.pageIndex).getWidth()
  const rightLimit = block.level === 'paragraph' ? oldRight : Math.max(oldRight, pageW - Math.min(originX0, 36))
  const lineOffsets = block.lines.map((l) => l.runs[0].matrix[4] - originX0)
  const laterOffset = block.lines.length > 1 ? lineOffsets[1] : 0
  const maxWidth = (i: number): number => Math.max(1, (rightLimit - originX0 - (i === 0 ? 0 : laterOffset)) / Math.abs(m[0]))

  // Choose the font.
  let measure: Measurer | null = null
  let fontOperand: PdfObj
  let strategy: TextStrategy = 'document-font'
  let message = 'Edited using the document’s own font'
  const used = analysis.fontUsage.get(first.font) ?? new Set<number>()
  const ownOk = first.fontName !== '(ExtGState font)' && Array.from(newText.replace(/\n/g, '')).every((ch) => first.font.encode(ch, used))
  if (ownOk) {
    const f = first.font
    const codeOf = (bytes: number[]): number => bytes.reduce((a, b) => a * 256 + b, 0)
    const charW = new Map<string, number>()
    const cw = (ch: string): number => {
      let w = charW.get(ch)
      if (w === undefined) {
        const bytes = f.encode(ch, used)!
        w = (f.widthOf(codeOf(bytes)) / 1000) * newSize * th + first.charSpace * th + (ch === ' ' && bytes.length === 1 && bytes[0] === 32 ? first.wordSpace * th : 0)
        charW.set(ch, w)
      }
      return w
    }
    measure = {
      width: (s) => Array.from(s).reduce((a, ch) => a + cw(ch), 0),
      encode: (s) => Uint8Array.from(Array.from(s).flatMap((ch) => f.encode(ch, used)!))
    }
    fontOperand = nameObj(first.fontName)
  } else {
    const std = STANDARD_BY_STYLE(first.font.style)
    let pdfFont: PDFFont
    let label: string
    let resName: string | undefined
    if (winAnsiCan(newText)) {
      resName = findExistingStandard(analysis, block.source, std)
      label = std.replace('-', ' ')
      if (resName) {
        // The page already has this standard font: reuse it and measure with a scratch copy (nothing added).
        pdfFont = await (await PDFDocument.create()).embedFont(std)
        fontOperand = nameObj(resName)
      } else {
        pdfFont = await pdf.embedFont(std)
        fontOperand = nameObj(addResource(pdf, source, 'Font', 'EpdfF', pdfFont.ref))
      }
    } else {
      if (!loader) throw refuse('The new text uses characters that need a Unicode font, which is not available here.')
      const bytes = await loader.unicodeFont(first.font.style)
      // Check coverage before embedding anything, so a refusal leaves the document exactly as it was.
      const probe = fontkit.create(bytes) as { hasGlyphForCodePoint(cp: number): boolean }
      const missing = Array.from(new Set(Array.from(newText.replace(/\n/g, '')).filter((ch) => !probe.hasGlyphForCodePoint(ch.codePointAt(0)!))))
      if (missing.length) {
        throw refuse(`No font that Epdf can use has the character${missing.length > 1 ? 's' : ''} ${missing.slice(0, 5).map((c) => `“${c}”`).join(' ')}. Nothing was changed.`)
      }
      pdf.registerFontkit(fontkit)
      pdfFont = await pdf.embedFont(bytes, { subset: true })
      label = 'Noto Sans'
      fontOperand = nameObj(addResource(pdf, source, 'Font', 'EpdfF', pdfFont.ref))
    }
    strategy = 'fallback-font'
    message = `Font not available in this PDF — used ${label}`
    const pf = pdfFont
    measure = {
      width: (s) => pf.widthOfTextAtSize(s, newSize) * th,
      encode: (s) => hexBytes(pf.encodeText(s))
    }
  }

  const lines = wrapLines(newText, measure.width, maxWidth)

  // Color: keep the original device color operators; anything fancier is approximated in DeviceRGB.
  let colorOps: Op[]
  const asked = req.color ? hexToRgb(req.color) : null
  if (asked && req.color!.toLowerCase() !== block.color.css.toLowerCase()) colorOps = [mkOp('rg', num(asked[0]), num(asked[1]), num(asked[2]))]
  else if (block.color.ops.length === 0) colorOps = [mkOp('g', num(0))]
  else if (block.color.ops.every((o) => o.op === 'g' || o.op === 'rg' || o.op === 'k')) colorOps = block.color.ops.map((o) => mkOp(o.op, ...o.args))
  else {
    const rgb = hexToRgb(block.color.css) ?? [0, 0, 0]
    colorOps = [mkOp('rg', num(rgb[0]), num(rgb[1]), num(rgb[2]))]
  }

  const mode = first.renderMode >= 0 && first.renderMode <= 2 ? first.renderMode : 0
  const newOps: Op[] = [
    mkOp('q'),
    ...colorOps,
    mkOp('BT'),
    mkOp('Tf', fontOperand, num(newSize)),
    mkOp('Tc', num(strategy === 'document-font' ? first.charSpace : 0)),
    mkOp('Tw', num(strategy === 'document-font' ? first.wordSpace : 0)),
    mkOp('Tz', num(th * 100)),
    mkOp('Ts', num(first.rise)),
    mkOp('Tr', num(mode)),
    mkOp('Tm', ...tm.map(num))
  ]
  const leadT = leadingUser / Math.abs(m[3])
  lines.forEach((line, i) => {
    if (i > 0) {
      const dx = i === 1 ? (lineOffsets[Math.min(1, lineOffsets.length - 1)] ?? 0) / m[0] : 0
      newOps.push(mkOp('Td', num(dx), num(-leadT)))
    }
    if (line !== '') newOps.push(mkOp('Tj', str(measure!.encode(line), true)))
  })
  newOps.push(mkOp('ET'), mkOp('Q'))

  // Remove the old text and insert the new.
  const plans = new PlanSet()
  const removed = new Set(block.runs.map((r) => r.id))
  for (const run of block.runs) {
    const slot = slotOf(analysis, run.addr.source, run.addr.slot)
    plans.replace(slot, run.addr.index, neutralOps(analysis, run, slot.ops[run.addr.index], removed))
  }
  stripActualText(plans, analysis, block.runs)
  const insSlot: StreamSlot = slotOf(analysis, last.et!.addr.source, last.et!.addr.slot)
  plans.insertAfter(insSlot, last.et!.addr.index, newOps)
  plans.apply()
  return { strategy, message }
}

// ---------------------------------------------------------------------------------------------------------

export async function applyTextEdit(
  pdf: PDFDocument,
  pageIndex: number,
  req: TextEditRequest,
  loader?: FontLoader
): Promise<TextEditResult> {
  let analysis: PageAnalysis
  try {
    analysis = analyzePage(pdf, pageIndex)
  } catch (e) {
    throw refuse(`This page's content could not be read safely, so nothing was changed (${e instanceof Error ? e.message : String(e)}).`)
  }
  const block = findBlock(buildBlocks(analysis), req.blockId)
  if (!block) throw refuse('That text is no longer on the page. Select it again.')
  if (block.text !== req.oldText) throw refuse('The text changed since you selected it. Select it again.')
  if (!block.editable) throw refuse(`This text can’t be edited: ${block.reason}.`)
  const newText = normalize(req.newText)
  const restyle =
    (req.size !== undefined && Math.abs(req.size - block.size) > 0.005) ||
    (req.color !== undefined && req.color.toLowerCase() !== block.color.css.toLowerCase())
  if (newText === block.text && !restyle) return { strategy: 'in-place', message: 'No changes were made.', noop: true, warnings: [] }

  const warnings: string[] = []
  let result: TextEditResult | undefined
  if (!restyle) {
    const plan = planInPlace(analysis, block, newText)
    if (plan) {
      const plans = new PlanSet()
      for (const edit of plan) rewriteRun(plans, analysis, edit)
      stripActualText(plans, analysis, plan.map((e) => e.run))
      plans.apply()
      result = { strategy: 'in-place', message: 'Edited using the document’s own font', warnings }
    }
  }
  if (!result) {
    const out = await replaceBlock(pdf, analysis, block, newText, req, loader)
    result = { strategy: out.strategy, message: out.message, warnings }
  }
  commitSources(pdf, analysis)
  return result
}
