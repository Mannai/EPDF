/** Reading and writing the /Encrypt dictionary (and the trailer /ID) through pdf-lib objects. */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, PDFBool, type PDFContext, type PDFObject } from 'pdf-lib'
import { toHex } from './bytes'
import { UnsupportedEncryptionError, type CryptMethod, type EncryptionInfo } from './handler'

const N = (s: string): PDFName => PDFName.of(s)

const num = (ctx: PDFContext, d: PDFDict, key: string): number | undefined => {
  const v = ctx.lookup(d.get(N(key)))
  return v instanceof PDFNumber ? v.asNumber() : undefined
}

const bytesOf = (ctx: PDFContext, d: PDFDict, key: string): Uint8Array | undefined => {
  const v = ctx.lookup(d.get(N(key)))
  return v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : undefined
}

const nameOf = (ctx: PDFContext, d: PDFDict, key: string): string | undefined => {
  const v = ctx.lookup(d.get(N(key)))
  return v instanceof PDFName ? v.decodeText() : undefined
}

const METHODS: Record<string, CryptMethod> = { None: 'None', V2: 'RC4', AESV2: 'AESV2', AESV3: 'AESV3' }

/** The first element of a trailer /ID array (empty if there is none). */
export function readId0(ctx: PDFContext, id: PDFObject | undefined): Uint8Array {
  const arr = id ? ctx.lookup(id) : undefined
  if (arr instanceof PDFArray && arr.size() > 0) {
    const first = ctx.lookup(arr.get(0))
    if (first instanceof PDFString || first instanceof PDFHexString) return first.asBytes()
  }
  return new Uint8Array(0)
}

/** Parses a /Encrypt dictionary. Throws `UnsupportedEncryptionError` for handlers other than the Standard one. */
export function parseEncryptDict(ctx: PDFContext, d: PDFDict, id0: Uint8Array): EncryptionInfo {
  const filter = nameOf(ctx, d, 'Filter')
  if (filter !== 'Standard') {
    throw new UnsupportedEncryptionError(
      `This document uses the “${filter ?? 'unknown'}” security handler (for example certificate encryption), which Epdf does not support.`
    )
  }
  const V = num(ctx, d, 'V') ?? 0
  const R = num(ctx, d, 'R') ?? 2
  if (![1, 2, 3, 4, 5].includes(V) || R < 2 || R > 6) {
    throw new UnsupportedEncryptionError(`Unsupported encryption version (V=${V}, R=${R}).`)
  }
  const O = bytesOf(ctx, d, 'O')
  const U = bytesOf(ctx, d, 'U')
  if (!O || !U) throw new UnsupportedEncryptionError('The encryption dictionary is incomplete (missing /O or /U).')

  const cf = ctx.lookup(d.get(N('CF')))
  const cryptFilters: Record<string, CryptMethod> = { Identity: 'None' }
  if (cf instanceof PDFDict) {
    for (const [k, v] of cf.entries()) {
      const fd = ctx.lookup(v)
      if (fd instanceof PDFDict) cryptFilters[k.decodeText()] = METHODS[nameOf(ctx, fd, 'CFM') ?? 'None'] ?? 'None'
    }
  }
  const stmFilterName = nameOf(ctx, d, 'StmF') ?? 'Identity'
  const strFilterName = nameOf(ctx, d, 'StrF') ?? 'Identity'

  let keyBits = num(ctx, d, 'Length')
  if (V === 1) keyBits = 40
  else if (V <= 3) keyBits ??= 40
  else if (V === 4) {
    if (!keyBits) {
      const fd = cf instanceof PDFDict ? ctx.lookup(cf.get(N(stmFilterName))) : undefined
      keyBits = (fd instanceof PDFDict ? num(ctx, fd, 'Length') : undefined) ?? 128
      if (keyBits < 40) keyBits <<= 3
    }
  } else keyBits = 256
  if (keyBits % 8 !== 0 || keyBits < 40 || keyBits > 256) throw new UnsupportedEncryptionError(`Unsupported encryption key length (${keyBits} bits).`)

  const em = ctx.lookup(d.get(N('EncryptMetadata')))
  const stm: CryptMethod = V >= 4 ? (cryptFilters[stmFilterName] ?? 'None') : 'RC4'
  const str: CryptMethod = V >= 4 ? (cryptFilters[strFilterName] ?? 'None') : 'RC4'
  const modern = R >= 5
  return {
    V,
    R,
    keyBits,
    P: (num(ctx, d, 'P') ?? 0) | 0,
    O: modern ? O.slice(0, 48) : O.slice(0, 32),
    U: modern ? U.slice(0, 48) : U.slice(0, 32),
    OE: modern ? bytesOf(ctx, d, 'OE')?.slice(0, 32) : undefined,
    UE: modern ? bytesOf(ctx, d, 'UE')?.slice(0, 32) : undefined,
    Perms: modern ? bytesOf(ctx, d, 'Perms')?.slice(0, 16) : undefined,
    encryptMetadata: em instanceof PDFBool ? em.asBoolean() : true,
    id0,
    stmMethod: stm,
    strMethod: str,
    cryptFilters,
    stmFilterName,
    strFilterName
  }
}

const hexString = (b: Uint8Array): PDFHexString => PDFHexString.of(toHex(b))

/** Builds the /Encrypt dictionary object for `info` (the entries qpdf and Acrobat write for the same handler). */
export function buildEncryptDict(ctx: PDFContext, info: EncryptionInfo): PDFDict {
  const d = ctx.obj({}) as PDFDict
  d.set(N('Filter'), N('Standard'))
  d.set(N('V'), PDFNumber.of(info.V))
  d.set(N('R'), PDFNumber.of(info.R))
  d.set(N('P'), PDFNumber.of(info.P))
  d.set(N('O'), hexString(info.O))
  d.set(N('U'), hexString(info.U))
  if (info.R >= 5) {
    d.set(N('OE'), hexString(info.OE!))
    d.set(N('UE'), hexString(info.UE!))
    d.set(N('Perms'), hexString(info.Perms!))
  }
  if (info.V >= 2) d.set(N('Length'), PDFNumber.of(info.keyBits))
  if (info.V >= 4) {
    const cf = ctx.obj({}) as PDFDict
    for (const [name, method] of Object.entries(info.cryptFilters)) {
      if (name === 'Identity') continue
      const f = ctx.obj({}) as PDFDict
      f.set(N('Type'), N('CryptFilter'))
      f.set(N('CFM'), N(method === 'RC4' ? 'V2' : method))
      f.set(N('AuthEvent'), N('DocOpen'))
      f.set(N('Length'), PDFNumber.of(info.keyBits >> 3))
      cf.set(N(name), f)
    }
    d.set(N('CF'), cf)
    d.set(N('StmF'), N(info.stmFilterName))
    d.set(N('StrF'), N(info.strFilterName))
  }
  if (!info.encryptMetadata) d.set(N('EncryptMetadata'), ctx.obj(false))
  return d
}
