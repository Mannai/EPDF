import { arr, mkOp, num, type Op, type PdfObj } from '../../textedit/pdfcontent/content'

/**
 * Rewrites a text-showing operation so that the covered glyphs are gone from the content stream while every
 * surviving glyph keeps its position: the space of each removed glyph is replaced by a TJ adjustment.
 * Pure: no fonts, no PDF objects, only codes/byte offsets and their advance widths.
 */

export interface GlyphSpan {
  /** -1 = the string operand itself, otherwise the index of the string inside the TJ array. */
  el: number
  /** Byte offset of the code inside that string. */
  off: number
  /** Length of the code in bytes. */
  n: number
  /** Text-space displacement of the glyph: (w*size + Tc + Tw?) * Th, exactly as the text state advances. */
  disp: number
}

export interface RewriteInput {
  op: Op
  /** Operand index of the string (0 for Tj/TJ/', 2 for "). */
  strArg: number
  glyphs: readonly GlyphSpan[]
  covered: readonly boolean[]
  size: number
  hScale: number
  /** When set, ALL glyphs are dropped and the position advances by exactly this amount (fail-closed removal). */
  wholeAdvance?: number
}

const EPS = 1e-9

/** Text-space displacement -> TJ number (thousandths of text space, sign inverted). */
const tjNumber = (disp: number, size: number, hScale: number): number => (-disp * 1000) / (size * hScale)

/** Operations that replace `op` (may be several: `'` and `"` are expanded into their parts). */
export function rewriteShow(inp: RewriteInput): Op[] {
  const { op, strArg, glyphs, covered, size, hScale } = inp
  if (!(Math.abs(size * hScale) > EPS)) {
    // Zero-size text is invisible and its advance is zero: nothing to keep in place.
    return prefixOps(op, [])
  }
  const whole = inp.wholeAdvance !== undefined
  const src = op.args[strArg]
  const elements: PdfObj[] = src.t === 'arr' ? src.v : [src]
  const elIndex = (i: number): number => (src.t === 'arr' ? i : -1)

  const out: PdfObj[] = []
  const pushNum = (n: number): void => {
    if (Math.abs(n) < EPS) return
    const last = out[out.length - 1]
    if (last?.t === 'num') out[out.length - 1] = num(last.v + n)
    else out.push(num(n))
  }
  let pending = 0
  let chunk: number[] = []
  let chunkHex = false
  const flushChunk = (): void => {
    if (chunk.length) out.push({ t: 'str', b: Uint8Array.from(chunk), hex: chunkHex })
    chunk = []
  }
  const flushPending = (): void => {
    if (pending !== 0) {
      flushChunk()
      pushNum(tjNumber(pending, size, hScale))
      pending = 0
    }
  }

  if (whole) {
    pending = inp.wholeAdvance!
    flushPending()
  } else {
    let gi = 0
    elements.forEach((el, i) => {
      if (el.t === 'num') {
        flushChunk()
        pushNum(el.v)
        return
      }
      if (el.t !== 'str') return
      chunkHex = el.hex
      // Glyphs are listed in operand order, so the ones of this element form a contiguous run.
      while (gi < glyphs.length && glyphs[gi].el === elIndex(i)) {
        const g = glyphs[gi]
        if (covered[gi]) pending += g.disp
        else {
          if (pending !== 0) flushPending()
          for (let k = 0; k < g.n; k++) chunk.push(el.b[g.off + k])
        }
        gi++
      }
      flushChunk()
    })
    flushPending()
  }

  const body: Op[] = []
  if (out.length) body.push({ op: 'TJ', args: [arr(...out)], pre: NEWLINE, raw: null })
  return prefixOps(op, body)
}

const NEWLINE = new Uint8Array([10])

/** `'` and `"` do more than show text: they move to the next line (and `"` sets spacing) first. */
function prefixOps(op: Op, body: Op[]): Op[] {
  const parts: Op[] = []
  if (op.op === "'") parts.push(mkOp('T*'))
  else if (op.op === '"') parts.push(mkOp('Tw', op.args[0] ?? num(0)), mkOp('Tc', op.args[1] ?? num(0)), mkOp('T*'))
  parts.push(...body)
  if (parts.length) parts[0] = { ...parts[0], pre: op.pre }
  return parts
}
