/**
 * Whole-document encryption and decryption on top of pdf-lib's object model.
 *
 *  - `inspectEncryption(bytes)`  reads the /Encrypt dictionary and /ID without needing a password.
 *  - `decryptDocument(...)`      returns a plain, unencrypted copy of an encrypted document.
 *  - `encryptDocument(...)`      encrypts every string and stream of a (plain) PDFDocument and serialises it.
 *  - a "protection marker" travels inside the in-memory plaintext snapshots so that undo/redo/recovery always
 *    know whether, and how, a snapshot has to be re-encrypted when it is written (see `session.ts`).
 *
 * pdf-lib's parser reads the file sequentially and ignores the xref tables, which suits us: we hook the one method
 * that turns "n g obj ... endobj" into an object, decrypt there, and expand object streams only AFTER decrypting
 * them (pdf-lib itself refuses to look inside an encrypted one).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHeader,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFXRefStreamParser,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'
import { decryptStream, encryptStream } from './bulk'
import { fromHex, toHex, utf8, yieldToEventLoop } from './bytes'
import { buildEncryptDict, parseEncryptDict, readId0 } from './encryptDict'
import { createProtection, decryptBytes, encryptBytes, type Access, type CryptMethod, type EncryptionInfo, type NewProtection, type Protection } from './handler'
import { randomBytes } from './bytes'

const N = (s: string): PDFName => PDFName.of(s)

// ---------------------------------------------------------------------------------------------------------------
// Parsing hook

type ObjectHook = (ref: PDFRef, obj: PDFObject, tick: () => boolean, ctx: PDFContext) => Promise<void>
const ENDOBJ = [0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a]

/**
 * Parses a document like pdf-lib does, but hands every indirect object to `hook` instead of assigning it directly
 * (with no hook, objects are assigned as they are and object streams stay unexpanded: enough to read the trailer).
 */
async function parseWith(bytes: Uint8Array, hook: ObjectHook | null): Promise<PDFContext> {
  const parser = PDFParser.forBytesWithOptions(bytes, 200, false, false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parser as any
  p.parseIndirectObject = async function (this: typeof p): Promise<PDFRef> {
    const ref: PDFRef = this.parseIndirectObjectHeader()
    this.skipWhitespaceAndComments()
    const object: PDFObject = this.parseObject()
    this.skipWhitespaceAndComments()
    this.matchKeyword(ENDOBJ)
    if (object instanceof PDFRawStream && object.dict.lookup(N('Type')) === N('XRef')) {
      PDFXRefStreamParser.forStream(object).parseIntoContext()
    } else if (hook) {
      await hook(ref, object, this.shouldWaitForTick, this.context)
    } else {
      this.context.assign(ref, object)
    }
    return ref
  }
  return parser.parseDocument()
}

export interface EncryptionProbe {
  info: EncryptionInfo
  /** Set when /Encrypt is an indirect object (its strings must not be decrypted). */
  encryptRef?: PDFRef
}

/** Reads the encryption parameters of a document, or null if it is not encrypted. No password needed. */
export async function inspectEncryption(bytes: Uint8Array): Promise<EncryptionProbe | null> {
  const ctx = await parseWith(bytes, null)
  const enc = ctx.trailerInfo.Encrypt
  if (!enc) return null
  const dict = ctx.lookup(enc)
  if (!(dict instanceof PDFDict)) return null
  return { info: parseEncryptDict(ctx, dict, readId0(ctx, ctx.trailerInfo.ID)), encryptRef: enc instanceof PDFRef ? enc : undefined }
}

// ---------------------------------------------------------------------------------------------------------------
// Walking objects

/**
 * Applies `fn` to every string below `obj` (dictionaries, arrays, stream dictionaries), replacing strings with hex strings
 * holding the transformed bytes. The `/Contents` of signature dictionaries is never encrypted, so it is skipped.
 */
function mapStrings(obj: PDFObject, fn: (bytes: Uint8Array) => Uint8Array): PDFObject {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(toHex(fn(obj.asBytes())))
  if (obj instanceof PDFStream) {
    mapStrings(obj.dict, fn)
    return obj
  }
  if (obj instanceof PDFDict) {
    const isSignature = obj.has(N('ByteRange'))
    for (const [k, v] of obj.entries()) {
      if (isSignature && k.decodeText() === 'Contents') continue
      const nv = mapStrings(v, fn)
      if (nv !== v) obj.set(k, nv)
    }
    return obj
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i)
      const nv = mapStrings(v, fn)
      if (nv !== v) obj.set(i, nv)
    }
    return obj
  }
  return obj
}

/** The crypt filter named by a stream's own `/Filter [/Crypt]` (null if it has none), and removal of that entry. */
function streamCryptFilter(ctx: PDFContext, dict: PDFDict): { name: string } | null {
  const filter = ctx.lookup(dict.get(N('Filter')))
  const names = filter instanceof PDFArray ? filter.asArray().map((f) => ctx.lookup(f)) : [filter]
  const idx = names.findIndex((f) => f instanceof PDFName && f.decodeText() === 'Crypt')
  if (idx < 0) return null
  const parms = ctx.lookup(dict.get(N('DecodeParms')) ?? dict.get(N('DP')))
  const mine = parms instanceof PDFArray ? ctx.lookup(parms.get(idx)) : idx === 0 ? parms : undefined
  const name = mine instanceof PDFDict ? ctx.lookup(mine.get(N('Name'))) : undefined
  return { name: name instanceof PDFName ? name.decodeText() : 'Identity' }
}

function dropCryptFilter(ctx: PDFContext, dict: PDFDict): void {
  const filter = ctx.lookup(dict.get(N('Filter')))
  const parmsKey = dict.has(N('DecodeParms')) ? N('DecodeParms') : N('DP')
  const parms = ctx.lookup(dict.get(parmsKey))
  if (filter instanceof PDFName) {
    dict.delete(N('Filter'))
    dict.delete(parmsKey)
    return
  }
  if (!(filter instanceof PDFArray)) return
  const keep: PDFObject[] = []
  const keepParms: PDFObject[] = []
  filter.asArray().forEach((f, i) => {
    if (ctx.lookup(f) instanceof PDFName && (ctx.lookup(f) as PDFName).decodeText() === 'Crypt') return
    keep.push(f)
    if (parms instanceof PDFArray) keepParms.push(parms.get(i))
  })
  if (keep.length === 0) {
    dict.delete(N('Filter'))
    dict.delete(parmsKey)
  } else {
    dict.set(N('Filter'), ctx.obj(keep))
    if (parms instanceof PDFArray) dict.set(parmsKey, ctx.obj(keepParms))
  }
}

const isMetadataStream = (ctx: PDFContext, dict: PDFDict): boolean => ctx.lookup(dict.get(N('Type'))) === N('Metadata')

// ---------------------------------------------------------------------------------------------------------------
// Decrypt

export interface DecryptResult {
  bytes: Uint8Array
}

/**
 * Decrypts every string and stream and returns the bytes of an equivalent, unencrypted document. With `marker`, the
 * result also carries the protection marker (so that saving re-encrypts it with the original parameters).
 */
export async function decryptDocument(
  bytes: Uint8Array,
  probe: EncryptionProbe,
  access: Access,
  marker?: Protection
): Promise<Uint8Array> {
  const { info, encryptRef } = probe
  const skipEncrypt = (ref: PDFRef): boolean => !!encryptRef && ref.objectNumber === encryptRef.objectNumber

  const hook: ObjectHook = async (ref, object, tick, ctx) => {
    if (skipEncrypt(ref)) return void ctx.assign(ref, object)
    const num = ref.objectNumber
    const gen = ref.generationNumber
    const strMethod = info.strMethod
    if (object instanceof PDFRawStream) {
      const dict = object.dict
      mapStrings(dict, (b) => decryptBytes(strMethod, access.key, num, gen, b))
      let method: CryptMethod = info.stmMethod
      const crypt = streamCryptFilter(ctx, dict)
      if (crypt) method = info.cryptFilters[crypt.name] ?? 'None'
      else if (!info.encryptMetadata && info.V >= 4 && isMetadataStream(ctx, dict)) method = 'None'
      const plain = method === 'None' ? object.contents : await decryptStream(method, access.key, num, gen, object.contents)
      if (crypt) dropCryptFilter(ctx, dict)
      const out = PDFRawStream.of(dict, plain)
      dict.set(N('Length'), PDFNumber.of(plain.length))
      if (dict.lookup(N('Type')) === N('ObjStm')) await PDFObjectStreamParser.forStream(out, tick).parseIntoContext()
      else ctx.assign(ref, out)
      return
    }
    ctx.assign(ref, mapStrings(object, (b) => decryptBytes(strMethod, access.key, num, gen, b)))
  }
  const ctx = await parseWith(bytes, hook)

  ctx.trailerInfo.Encrypt = undefined
  if (encryptRef) ctx.delete(encryptRef)
  const doc = new (PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, update: boolean) => PDFDocument)(ctx, true, false)
  if (marker) embedMarker(doc, marker)
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 200 })
}

// ---------------------------------------------------------------------------------------------------------------
// Encrypt

const SLICE_OBJECTS = 400

/**
 * Encrypts `pdf` in place with `protection` and returns the serialised file. Strings and streams are encrypted per
 * object; the file is written with a classic cross-reference table (object streams would have to be encrypted as
 * a whole, and their contents not separately, which pdf-lib's writer cannot do for us).
 */
export async function encryptDocument(pdf: PDFDocument, protection: Protection): Promise<Uint8Array> {
  const { info, key } = protection
  const ctx = pdf.context
  const m = /(\d+)\.(\d+)/.exec(ctx.header.toString())
  const version = m ? Number(m[1]) * 10 + Number(m[2]) : 14
  const atLeast = (v: number): void => {
    if (version < v) ctx.header = PDFHeader.forVersion(Math.floor(v / 10), v % 10)
  }
  if (info.R >= 5) {
    // AES-256 revision 6 belongs to PDF 2.0; for 1.x files declare it through the Adobe extension like Acrobat and qpdf do.
    atLeast(17)
    if (version < 20 && !pdf.catalog.has(N('Extensions'))) {
      pdf.catalog.set(N('Extensions'), ctx.obj({ ADBE: { BaseVersion: N('1.7'), ExtensionLevel: info.R === 5 ? 3 : 8 } }))
    }
  } else if (info.V >= 4) atLeast(16)
  else atLeast(14)

  let work = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const num = ref.objectNumber
    const gen = ref.generationNumber
    if (obj instanceof PDFStream) {
      const dict = obj.dict
      mapStrings(dict, (b) => encryptBytes(info.strMethod, key, num, gen, b))
      const skipMetadata = !info.encryptMetadata && isMetadataStream(ctx, dict)
      const contents = obj.getContents()
      const enc = skipMetadata ? contents : await encryptStream(info.stmMethod, key, num, gen, contents)
      const out = PDFRawStream.of(dict, enc)
      dict.set(N('Length'), PDFNumber.of(enc.length))
      ctx.assign(ref, out)
      work += 1 + (contents.length >> 12)
    } else {
      const nv = mapStrings(obj, (b) => encryptBytes(info.strMethod, key, num, gen, b))
      if (nv !== obj) ctx.assign(ref, nv)
      work++
    }
    if (work >= SLICE_OBJECTS) {
      work = 0
      await yieldToEventLoop()
    }
  }
  const encRef = ctx.register(buildEncryptDict(ctx, info))
  ctx.trailerInfo.Encrypt = encRef
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(toHex(info.id0)), PDFHexString.of(toHex(randomBytes(16)))])
  return pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 200 })
}

// ---------------------------------------------------------------------------------------------------------------
// The protection marker

/** Plain-ASCII needle at the start of the marker stream, so "is this snapshot protected?" is a cheap byte search. */
export const MARKER_NEEDLE = 'EPDF-SECURITY-MARKER-1'
const MARKER_KEY = 'EpdfSecurity'

interface MarkerJson {
  V: number
  R: number
  keyBits: number
  P: number
  O: string
  U: string
  OE?: string
  UE?: string
  Perms?: string
  encryptMetadata: boolean
  id0: string
  stmMethod: CryptMethod
  strMethod: CryptMethod
  cryptFilters: Record<string, CryptMethod>
  stmFilterName: string
  strFilterName: string
  key: string
}

const opt = (b?: Uint8Array): string | undefined => (b ? toHex(b) : undefined)

export function serializeProtection(p: Protection): Uint8Array {
  const i = p.info
  const json: MarkerJson = {
    V: i.V,
    R: i.R,
    keyBits: i.keyBits,
    P: i.P,
    O: toHex(i.O),
    U: toHex(i.U),
    OE: opt(i.OE),
    UE: opt(i.UE),
    Perms: opt(i.Perms),
    encryptMetadata: i.encryptMetadata,
    id0: toHex(i.id0),
    stmMethod: i.stmMethod,
    strMethod: i.strMethod,
    cryptFilters: i.cryptFilters,
    stmFilterName: i.stmFilterName,
    strFilterName: i.strFilterName,
    key: toHex(p.key)
  }
  return utf8(`${MARKER_NEEDLE}\n${JSON.stringify(json)}`)
}

export function parseProtection(bytes: Uint8Array): Protection | null {
  try {
    const text = new TextDecoder().decode(bytes)
    if (!text.startsWith(MARKER_NEEDLE)) return null
    const j = JSON.parse(text.slice(MARKER_NEEDLE.length)) as MarkerJson
    const h = (s?: string): Uint8Array | undefined => (s ? fromHex(s) : undefined)
    return {
      key: fromHex(j.key),
      info: {
        V: j.V,
        R: j.R,
        keyBits: j.keyBits,
        P: j.P,
        O: fromHex(j.O),
        U: fromHex(j.U),
        OE: h(j.OE),
        UE: h(j.UE),
        Perms: h(j.Perms),
        encryptMetadata: j.encryptMetadata,
        id0: fromHex(j.id0),
        stmMethod: j.stmMethod,
        strMethod: j.strMethod,
        cryptFilters: j.cryptFilters,
        stmFilterName: j.stmFilterName,
        strFilterName: j.strFilterName
      }
    }
  } catch {
    return null
  }
}

/** Puts (or replaces) the marker in a document. The marker is a raw stream, which pdf-lib never packs into an object stream. */
export function embedMarker(pdf: PDFDocument, p: Protection): void {
  removeMarker(pdf)
  const ref = pdf.context.register(pdf.context.stream(serializeProtection(p), { Type: 'EpdfSecurity' }))
  pdf.catalog.set(N(MARKER_KEY), ref)
}

export function readMarker(pdf: PDFDocument): Protection | null {
  const s = pdf.context.lookup(pdf.catalog.get(N(MARKER_KEY)))
  return s instanceof PDFStream ? parseProtection(s.getContents()) : null
}

/** Removes the marker; returns whether there was one. */
export function removeMarker(pdf: PDFDocument): boolean {
  const entry = pdf.catalog.get(N(MARKER_KEY))
  if (!entry) return false
  pdf.catalog.delete(N(MARKER_KEY))
  if (entry instanceof PDFRef) pdf.context.delete(entry)
  return true
}

/** Cheap check on serialised bytes: does this snapshot carry a protection marker? */
export function hasMarker(bytes: Uint8Array): boolean {
  const first = MARKER_NEEDLE.charCodeAt(0)
  let at = bytes.indexOf(first)
  while (at >= 0) {
    let ok = true
    for (let i = 1; i < MARKER_NEEDLE.length; i++) {
      if (bytes[at + i] !== MARKER_NEEDLE.charCodeAt(i)) {
        ok = false
        break
      }
    }
    if (ok) return true
    at = bytes.indexOf(first, at + 1)
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Convenience wrappers

/**
 * If `plain` carries a protection marker, returns the encrypted file bytes; otherwise the same bytes.
 * This is what "write to disk" runs through.
 */
export async function applyMarkerProtection(plain: Uint8Array): Promise<Uint8Array> {
  if (!hasMarker(plain)) return plain
  const pdf = await PDFDocument.load(plain, { updateMetadata: false })
  const protection = readMarker(pdf)
  if (!protection) return plain
  removeMarker(pdf)
  return encryptDocument(pdf, protection)
}

/** Creates fresh protection for a document (keeps its trailer /ID if it has one, so re-protecting is stable). */
export async function makeProtection(pdf: PDFDocument, opts: Omit<NewProtection, 'id0'>): Promise<Protection> {
  const existing = readId0(pdf.context, pdf.context.trailerInfo.ID)
  return createProtection({ ...opts, id0: existing.length === 16 ? existing : randomBytes(16) })
}

/** One-shot: protect plain PDF bytes with the given settings and return the encrypted file (used by tests and tooling). */
export async function protectBytes(plain: Uint8Array, opts: Omit<NewProtection, 'id0'>): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(plain, { updateMetadata: false })
  removeMarker(pdf)
  return encryptDocument(pdf, await makeProtection(pdf, opts))
}
