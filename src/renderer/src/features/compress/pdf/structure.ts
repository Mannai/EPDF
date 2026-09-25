import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { zlibSync } from 'fflate'
import { forEachRef, reachable, type Alias, type Reached } from './graph'
import type { CompressOptions } from './options'
import { N, decodeStream, deflateMax, encodedBytes, filterNames, hasImageCodec, inflateCapped, nameOf, refKey, resolve } from './streams'

/** Lossless structural work: removals, re-deflating and de-duplication. */

const dictOf = (o: PDFObject | undefined): PDFDict | undefined => (o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined)

/** Every dictionary (including stream dictionaries) among the indirect objects. */
function allDicts(ctx: PDFContext): PDFDict[] {
  const out: PDFDict[] = []
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d = dictOf(o)
    if (d) out.push(d)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Removals

export interface StripReport {
  metadata: number
  thumbnails: number
  pieceInfo: number
  javascript: number
  destinations: number
  extras: number
  infoRemoved: boolean
}

const INFO_KEEP = new Set(['Title', 'CreationDate', 'ModDate'])

function isJsAction(ctx: PDFContext, o: PDFObject | undefined): boolean {
  const d = dictOf(resolve(ctx, o))
  return !!d && nameOf(ctx, d.get(N('S'))) === 'JavaScript'
}

function deleteKeyEverywhere(dicts: PDFDict[], key: string): number {
  let n = 0
  const k = N(key)
  for (const d of dicts) if (d.has(k)) (d.delete(k), n++)
  return n
}

/** Names / strings used as named-destination references (both byte and UTF-8 spellings, so a match is never missed). */
function nameKeys(ctx: PDFContext, o: PDFObject | undefined): string[] {
  const v = resolve(ctx, o)
  if (v instanceof PDFName) {
    const a = [v.asString().slice(1)]
    try {
      a.push(v.decodeText())
    } catch {
      /* ignore */
    }
    return a
  }
  if (v instanceof PDFString || v instanceof PDFHexString) {
    const b = v.asBytes()
    let latin = ''
    for (const c of b) latin += String.fromCharCode(c)
    const a = [latin]
    try {
      a.push(new TextDecoder('utf-8', { fatal: true }).decode(b))
    } catch {
      /* not UTF-8 */
    }
    return a
  }
  return []
}

interface TreeEntry {
  key: PDFString | PDFHexString
  value: PDFObject
}

function collectNameTree(ctx: PDFContext, node: PDFDict, out: TreeEntry[], depth = 0): void {
  if (depth > 40) return
  const names = resolve(ctx, node.get(N('Names')))
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = resolve(ctx, names.get(i))
      if (k instanceof PDFString || k instanceof PDFHexString) out.push({ key: k, value: names.get(i + 1) })
    }
  }
  const kids = resolve(ctx, node.get(N('Kids')))
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = resolve(ctx, kids.get(i))
      if (kid instanceof PDFDict) collectNameTree(ctx, kid, out, depth + 1)
    }
  }
}

/** Removes named destinations nothing in this document points to. Returns the number removed. */
function removeUnusedDests(ctx: PDFContext, catalog: PDFDict, dicts: PDFDict[]): number {
  // Any script might jump to a named destination by name: then we cannot know what is unused.
  const namesDict = resolve(ctx, catalog.get(N('Names')))
  if (namesDict instanceof PDFDict && namesDict.has(N('JavaScript'))) return 0
  for (const d of dicts) if (isJsAction(ctx, d)) return 0
  const used = new Set<string>()
  const useDest = (o: PDFObject | undefined): void => {
    const v = resolve(ctx, o)
    if (v instanceof PDFName || v instanceof PDFString || v instanceof PDFHexString) for (const k of nameKeys(ctx, v)) used.add(k)
  }
  for (const d of dicts) {
    if (d.has(N('Dest'))) useDest(d.get(N('Dest')))
    const s = nameOf(ctx, d.get(N('S')))
    if ((s === 'GoTo' || s === 'GoToR' || s === 'GoToE') && d.has(N('D'))) useDest(d.get(N('D')))
    if (s === 'Thread' || s === 'Named') return 0 // named actions: play safe
  }
  const openAction = resolve(ctx, catalog.get(N('OpenAction')))
  if (openAction instanceof PDFArray) {
    /* explicit destination, nothing named */
  }
  let removed = 0
  // Legacy /Dests dictionary in the catalog.
  const legacy = resolve(ctx, catalog.get(N('Dests')))
  if (legacy instanceof PDFDict) {
    for (const [k] of legacy.entries()) {
      const keys = [k.asString().slice(1), (() => { try { return k.decodeText() } catch { return '' } })()]
      if (!keys.some((x) => used.has(x))) {
        legacy.delete(k)
        removed++
      }
    }
  }
  // Name tree /Names /Dests: rebuilt as one flat leaf.
  if (namesDict instanceof PDFDict) {
    const root = resolve(ctx, namesDict.get(N('Dests')))
    if (root instanceof PDFDict) {
      const entries: TreeEntry[] = []
      collectNameTree(ctx, root, entries)
      const keep = entries.filter((e) => nameKeys(ctx, e.key).some((x) => used.has(x)))
      if (keep.length !== entries.length) {
        removed += entries.length - keep.length
        if (keep.length === 0) namesDict.delete(N('Dests'))
        else {
          keep.sort((a, b) => {
            const x = a.key.asBytes()
            const y = b.key.asBytes()
            const n = Math.min(x.length, y.length)
            for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]
            return x.length - y.length
          })
          const arr = ctx.obj([]) as PDFArray
          for (const e of keep) (arr.push(e.key), arr.push(e.value))
          const leaf = ctx.obj({}) as PDFDict
          leaf.set(N('Names'), arr)
          const ref = namesDict.get(N('Dests'))
          if (ref instanceof PDFRef) ctx.assign(ref, leaf)
          else namesDict.set(N('Dests'), leaf)
        }
      }
    }
  }
  return removed
}

/** Applies every enabled removal. Idempotent, and it only deletes dictionary entries: unreachable objects go when the file is written. */
export function applyStrips(pdf: PDFDocument, opts: CompressOptions): StripReport {
  const ctx = pdf.context
  const report: StripReport = { metadata: 0, thumbnails: 0, pieceInfo: 0, javascript: 0, destinations: 0, extras: 0, infoRemoved: false }
  const dicts = allDicts(ctx)
  const catalog = pdf.catalog
  if (opts.stripMetadata) {
    report.metadata = deleteKeyEverywhere(dicts, 'Metadata')
    const infoRef = ctx.trailerInfo.Info
    const info = dictOf(resolve(ctx, infoRef))
    if (info) {
      for (const k of info.keys()) {
        if (!INFO_KEEP.has(k.decodeText())) (info.delete(k), (report.infoRemoved = true))
      }
    }
  }
  if (opts.stripThumbnails) report.thumbnails = deleteKeyEverywhere(dicts, 'Thumb')
  if (opts.stripPieceInfo) report.pieceInfo = deleteKeyEverywhere(dicts, 'PieceInfo')
  if (opts.stripExtras) {
    for (const key of ['Extensions', 'SpiderInfo', 'PresSteps', 'Alternates', 'OPI']) report.extras += deleteKeyEverywhere(dicts, key)
  }
  if (opts.stripJavaScript) {
    const names = resolve(ctx, catalog.get(N('Names')))
    if (names instanceof PDFDict && names.delete(N('JavaScript'))) report.javascript++
    for (const d of dicts) {
      const a = d.get(N('A'))
      if (a && isJsAction(ctx, a)) (d.delete(N('A')), report.javascript++)
      const oa = d.get(N('OpenAction'))
      if (oa && isJsAction(ctx, oa)) (d.delete(N('OpenAction')), report.javascript++)
      const aa = resolve(ctx, d.get(N('AA')))
      if (aa instanceof PDFDict) {
        for (const [k, v] of aa.entries()) if (isJsAction(ctx, v)) (aa.delete(k), report.javascript++)
        if (aa.keys().length === 0) d.delete(N('AA'))
      }
    }
  }
  if (opts.stripUnusedDests) report.destinations = removeUnusedDests(ctx, catalog, dicts)
  return report
}

// ---------------------------------------------------------------------------------------------------------
// Re-deflate

export interface RedeflateReport {
  streams: number
  savedBytes: number
}

/**
 * The Security feature keeps a stream in the in-memory copy of a password-protected document that starts with this plain-ASCII
 * needle; on every write it finds the stream by a raw byte search and re-encrypts the file. If we compressed it the search would
 * fail and the file would be written UNENCRYPTED, so such streams are never touched.
 */
const MARKER_NEEDLE = 'EPDF-SECURITY-MARKER'
function isProtectionMarker(b: Uint8Array): boolean {
  if (b.length < MARKER_NEEDLE.length) return false
  for (let i = 0; i < MARKER_NEEDLE.length; i++) if (b[i] !== MARKER_NEEDLE.charCodeAt(i)) return false
  return true
}

const LOSSLESS_CHAIN =new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'RunLengthDecode', 'FlateDecode'])
const MAX_DECODED = 256 * 1024 * 1024

/**
 * Re-compresses streams at maximum Flate level. Uncompressed streams are deflated; ASCII85 / hex / LZW / run-length chains
 * are converted to Flate; Flate streams (with their predictor parameters untouched) are inflated and deflated again.
 * A stream is replaced only if the result is smaller.
 */
export async function redeflateStreams(
  ctx: PDFContext,
  list: Reached[],
  skip: Set<string>,
  progress?: (done: number, total: number) => void,
  yieldNow?: () => Promise<void>
): Promise<RedeflateReport> {
  const rep: RedeflateReport = { streams: 0, savedBytes: 0 }
  let i = 0
  for (const { ref, obj } of list) {
    i++
    if (i % 64 === 0) {
      progress?.(i, list.length)
      await yieldNow?.()
    }
    if (!(obj instanceof PDFStream) || skip.has(refKey(ref))) continue
    const d = obj.dict
    const type = nameOf(ctx, d.get(N('Type')))
    if (type === 'Metadata' || type === 'XRef' || type === 'ObjStm') continue
    if (d.has(N('F')) && !d.has(N('Filter'))) continue // external file stream
    const filters = filterNames(ctx, d)
    if (hasImageCodec(filters)) continue
    if (filters.some((f) => !LOSSLESS_CHAIN.has(f))) continue
    const enc = encodedBytes(obj)
    if (isProtectionMarker(enc)) continue
    if (filters.length === 0) {
      if (enc.length < 64) continue
      const z = zlibSync(enc, { level: enc.length > 32 << 20 ? 6 : 9, mem: 12 })
      if (z.length >= enc.length * 0.95) continue
      replace(ctx, ref, obj, z, ['FlateDecode'], false)
      rep.savedBytes += enc.length - z.length
      rep.streams++
      continue
    }
    if (filters.length === 1 && filters[0] === 'FlateDecode') {
      const raw = inflateCapped(enc, MAX_DECODED)
      if (!raw) continue // damaged, or larger than we are willing to hold: leave the stream as it is
      const z = zlibSync(raw, { level: raw.length > 32 << 20 ? 6 : 9, mem: 12 })
      if (z.length >= enc.length) continue
      replace(ctx, ref, obj, z, ['FlateDecode'], true)
      rep.savedBytes += enc.length - z.length
      rep.streams++
      continue
    }
    // Other chains: decode completely, store as plain Flate.
    const raw = decodeStream(ctx, obj)
    if (!raw || raw.length > MAX_DECODED) continue
    const z = deflateMax(raw)
    if (z.length >= enc.length) continue
    replace(ctx, ref, obj, z, ['FlateDecode'], false)
    rep.savedBytes += enc.length - z.length
    rep.streams++
  }
  progress?.(list.length, list.length)
  return rep
}

function replace(ctx: PDFContext, ref: PDFRef, old: PDFStream, bytes: Uint8Array, filters: string[], keepParms: boolean): void {
  const dict = ctx.obj({}) as PDFDict
  for (const [k, v] of old.dict.entries()) {
    const key = k.decodeText()
    if (key === 'Length' || key === 'Filter' || key === 'F' || (!keepParms && (key === 'DecodeParms' || key === 'DP'))) continue
    dict.set(k, v)
  }
  dict.set(N('Filter'), filters.length === 1 ? N(filters[0]) : ctx.obj(filters))
  dict.set(N('Length'), ctx.obj(bytes.length))
  ctx.assign(ref, PDFRawStream.of(dict, bytes))
}

// ---------------------------------------------------------------------------------------------------------
// De-duplication

export interface DedupeReport {
  merged: number
  savedBytes: number
}

const DICT_TYPES = new Set(['Font', 'FontDescriptor', 'ExtGState', 'Encoding', 'CMap', 'ColorSpace', 'Pattern', 'XObject'])

function fnv(b: Uint8Array, seed: number): number {
  let h = seed
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function isCandidate(ctx: PDFContext, o: PDFObject, pageContents: Set<string>, key: string): boolean {
  if (o instanceof PDFStream) {
    if (pageContents.has(key)) return false
    const t = nameOf(ctx, o.dict.get(N('Type')))
    return t !== 'XRef' && t !== 'ObjStm'
  }
  if (o instanceof PDFArray) return true
  if (o instanceof PDFDict) {
    const t = nameOf(ctx, o.get(N('Type')))
    if (t && DICT_TYPES.has(t)) return true
    return o.has(N('FunctionType')) || o.has(N('ShadingType')) || o.has(N('PatternType'))
  }
  return false
}

/** Text form of an object where references are replaced by their current equivalence class; keys sorted so order is irrelevant. */
function signature(o: PDFObject, cls: Map<string, string>): string {
  const parts: string[] = []
  const rec = (v: PDFObject): void => {
    if (v instanceof PDFRef) parts.push('R' + (cls.get(refKey(v)) ?? refKey(v)))
    else if (v instanceof PDFDict) {
      parts.push('<<')
      const es = v.entries().map(([k, x]) => [k.toString(), x] as const)
      es.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      for (const [k, x] of es) {
        if (k === '/Length') continue
        parts.push(k)
        rec(x)
      }
      parts.push('>>')
    } else if (v instanceof PDFArray) {
      parts.push('[')
      for (const x of v.asArray()) rec(x)
      parts.push(']')
    } else parts.push(v.toString())
  }
  rec(o instanceof PDFStream ? o.dict : o)
  return parts.join(' ')
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Finds objects that are byte-for-byte equivalent (same dictionary, same data, equal references) and maps each duplicate to
 * its first occurrence. Runs to a fixed point so containers of duplicates (e.g. two font dictionaries pointing at two identical
 * font programs) collapse as well. Page content streams, pages, annotations and form fields are never merged.
 */
export function computeAliases(ctx: PDFContext, list: Reached[], pageContents: Set<string>): { alias: Alias; report: DedupeReport } {
  const cand = list.filter((r) => isCandidate(ctx, r.obj, pageContents, refKey(r.ref)))
  const dataHash = new Map<string, string>()
  for (const r of cand) {
    if (r.obj instanceof PDFStream) {
      const b = encodedBytes(r.obj)
      dataHash.set(refKey(r.ref), `${b.length}:${fnv(b, 2166136261)}:${fnv(b, 0x811c9dc5 ^ 0x1234567)}`)
    }
  }
  let cls = new Map<string, string>()
  for (let round = 0; round < 6; round++) {
    const groups = new Map<string, Reached[]>()
    const next = new Map<string, string>()
    for (const r of cand) {
      const k = refKey(r.ref)
      const sig = signature(r.obj, cls) + (r.obj instanceof PDFStream ? '|S' + dataHash.get(k) : '')
      const g = groups.get(sig)
      if (!g) {
        groups.set(sig, [r])
        next.set(k, k)
        continue
      }
      // verify (hash collisions must never merge different data)
      const rep = g.find((x) => !(r.obj instanceof PDFStream) || (x.obj instanceof PDFStream && sameBytes(encodedBytes(x.obj), encodedBytes(r.obj))))
      if (rep) next.set(k, refKey(rep.ref))
      else {
        g.push(r)
        next.set(k, k)
      }
    }
    let changed = next.size !== cls.size
    if (!changed) for (const [k, v] of next) if (cls.get(k) !== v) (changed = true)
    cls = next
    if (!changed) break
  }
  const alias: Alias = new Map()
  const byKey = new Map(cand.map((r) => [refKey(r.ref), r.ref] as const))
  let saved = 0
  for (const r of cand) {
    const k = refKey(r.ref)
    const c = cls.get(k)
    if (c && c !== k) {
      alias.set(k, byKey.get(c)!)
      if (r.obj instanceof PDFStream) saved += encodedBytes(r.obj).length
    }
  }
  return { alias, report: { merged: alias.size, savedBytes: saved } }
}

/**
 * Refs of streams that must stay unshared: page /Contents and annotation appearance streams (/AP). Sharing them is valid PDF,
 * but a later edit that changes one page's content or one field's look in place must not change another's.
 */
export function pageContentRefs(ctx: PDFContext, pdf: PDFDocument): Set<string> {
  const out = new Set<string>()
  try {
    for (const page of pdf.getPages()) {
      const c = page.node.get(N('Contents'))
      if (c instanceof PDFRef) {
        const v = ctx.lookup(c)
        if (v instanceof PDFArray) forEachRef(v, (r) => out.add(refKey(r)))
        else out.add(refKey(c))
      } else if (c instanceof PDFArray) forEachRef(c, (r) => out.add(refKey(r)))
      const annots = resolve(ctx, page.node.get(N('Annots')))
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const a = resolve(ctx, annots.get(i))
          if (a instanceof PDFDict) forEachRef(a.get(N('AP')), (r) => out.add(refKey(r)))
        }
      }
    }
  } catch {
    /* ignore: worst case more streams are considered for merging */
  }
  return out
}

/** Bytes of objects that exist in the file but cannot be reached from the trailer. */
export function unreachableBytes(ctx: PDFContext, roots: (PDFRef | undefined)[]): { count: number; bytes: number } {
  const seen = new Set(reachable(ctx, roots).map((r) => refKey(r.ref)))
  let count = 0
  let bytes = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (seen.has(refKey(ref))) continue
    count++
    if (obj instanceof PDFStream) bytes += encodedBytes(obj).length
    else bytes += 24
  }
  return { count, bytes }
}
