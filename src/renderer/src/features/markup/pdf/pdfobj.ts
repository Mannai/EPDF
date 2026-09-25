import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'

/**
 * Small helpers over pdf-lib's low-level object API. Nothing here imports pdf.js, so it runs in Node.
 * Reading helpers never throw on unexpected object types (real-world PDFs are messy): they return
 * `undefined` instead.
 */

/** Rounds to 3 decimals and avoids "-0" / exponent notation in content streams. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

export const num = (n: number): PDFNumber => PDFNumber.of(Math.round(n * 1000) / 1000)

export const text = (s: string): PDFHexString => PDFHexString.fromText(s)

export type Literal = PDFObject | number | boolean | string | null | undefined | Literal[] | { [k: string]: Literal }

/** Like `context.obj` but drops `undefined` entries instead of writing `null`. Strings become names. */
export function build(ctx: PDFContext, literal: Literal): PDFObject {
  if (literal === undefined || literal === null) return ctx.obj(null)
  if (Array.isArray(literal)) return ctx.obj(literal.map((v) => build(ctx, v)))
  if (typeof literal === 'object' && !isPdfObject(literal)) {
    const out: Record<string, PDFObject> = {}
    for (const [k, v] of Object.entries(literal)) if (v !== undefined) out[k] = build(ctx, v)
    return ctx.obj(out)
  }
  if (typeof literal === 'number') return num(literal)
  if (typeof literal === 'string') return ctx.obj(literal)
  if (typeof literal === 'boolean') return ctx.obj(literal)
  return literal as PDFObject
}

const isPdfObject = (v: unknown): v is PDFObject =>
  v instanceof PDFDict ||
  v instanceof PDFArray ||
  v instanceof PDFName ||
  v instanceof PDFNumber ||
  v instanceof PDFRef ||
  v instanceof PDFString ||
  v instanceof PDFHexString ||
  v instanceof PDFBool ||
  v instanceof PDFStream

export function dictOf(ctx: PDFContext, entries: { [k: string]: Literal }): PDFDict {
  return build(ctx, entries) as PDFDict
}

export function numbers(ctx: PDFContext, values: number[]): PDFArray {
  return ctx.obj(values.map((v) => num(v)))
}

/** Creates a form XObject appearance stream. */
export function formStream(
  ctx: PDFContext,
  ops: string,
  bbox: number[],
  resources: { [k: string]: Literal },
  matrix?: number[]
): PDFRawStream {
  const dict = dictOf(ctx, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: bbox.map((v) => num(v)),
    Matrix: matrix ? matrix.map((v) => num(v)) : undefined,
    Resources: build(ctx, resources)
  })
  return PDFRawStream.of(dict, new TextEncoder().encode(ops))
}

// ---------------------------------------------------------------- reading

export const key = (k: string): PDFName => PDFName.of(k)

/** Looks a key up (resolving indirect references); `undefined` when absent. */
export function get(dict: PDFDict, k: string): PDFObject | undefined {
  try {
    return dict.lookup(key(k))
  } catch {
    return undefined
  }
}

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  if (o instanceof PDFRef) return ctx.lookup(o)
  return o
}

export function asString(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) {
    try {
      return o.decodeText()
    } catch {
      return o.asString()
    }
  }
  return undefined
}

export function asNumber(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined
}

export function asName(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined
}

export const getString = (d: PDFDict, k: string): string | undefined => asString(get(d, k))
export const getNumber = (d: PDFDict, k: string): number | undefined => asNumber(get(d, k))
export const getName = (d: PDFDict, k: string): string | undefined => asName(get(d, k))

/** A numeric array (elements resolved); non-numeric entries make the whole read fail (`undefined`). */
export function getNumbers(d: PDFDict, k: string): number[] | undefined {
  const a = get(d, k)
  if (!(a instanceof PDFArray)) return undefined
  const out: number[] = []
  for (let i = 0; i < a.size(); i++) {
    const v = asNumber(a.lookup(i))
    if (v === undefined) return undefined
    out.push(v)
  }
  return out
}

/** Array of numeric arrays (InkList). Malformed sub-arrays are skipped. */
export function getNumberArrays(d: PDFDict, k: string): number[][] | undefined {
  const a = get(d, k)
  if (!(a instanceof PDFArray)) return undefined
  const out: number[][] = []
  for (let i = 0; i < a.size(); i++) {
    const sub = a.lookup(i)
    if (!(sub instanceof PDFArray)) continue
    const row: number[] = []
    let ok = true
    for (let j = 0; j < sub.size(); j++) {
      const v = asNumber(sub.lookup(j))
      if (v === undefined) ok = false
      else row.push(v)
    }
    if (ok) out.push(row)
  }
  return out
}

export function getNames(d: PDFDict, k: string): string[] | undefined {
  const a = get(d, k)
  if (!(a instanceof PDFArray)) return undefined
  const out: string[] = []
  for (let i = 0; i < a.size(); i++) out.push(asName(a.lookup(i)) ?? '')
  return out
}

export function getDict(d: PDFDict, k: string): PDFDict | undefined {
  const v = get(d, k)
  if (v instanceof PDFDict) return v
  if (v instanceof PDFStream) return v.dict
  return undefined
}

export const setNumbers = (ctx: PDFContext, d: PDFDict, k: string, v: number[]): void => d.set(key(k), numbers(ctx, v))
