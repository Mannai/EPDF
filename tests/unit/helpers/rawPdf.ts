import { concat, fromLatin1, latin1, toHex, utf8 } from '../../../src/renderer/src/features/security/crypto/bytes'
import { createProtection, encryptBytes, type CryptMethod, type NewProtection, type Protection } from '../../../src/renderer/src/features/security/crypto/handler'

/**
 * A tiny hand-rolled PDF assembler for edge cases pdf-lib cannot produce: streams with `Identity` crypt filters, strings
 * left unencrypted (`/StrF /Identity`), a direct /Encrypt dictionary, incremental updates that repeat /Encrypt.
 * It encrypts with the SAME primitives the product uses, so tests using it also cross-check against qpdf / PDF.js.
 */

export interface RawEnc {
  protection: Protection
  /** Encrypt a string for object `num`; returns the PDF hex string, e.g. `<0011..>`. */
  str(num: number, text: string, gen?: number): string
  /** Encrypt stream bytes for object `num` with the document's stream method (or `method`). */
  stream(num: number, data: Uint8Array, gen?: number, method?: CryptMethod): Uint8Array
}

export async function rawEncryption(opts: Omit<NewProtection, 'id0'> & { id0?: Uint8Array }): Promise<RawEnc> {
  const protection = await createProtection({ ...opts, id0: opts.id0 ?? Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 3) })
  const { info, key } = protection
  return {
    protection,
    str: (num, text, gen = 0) => `<${toHex(encryptBytes(info.strMethod, key, num, gen, fromLatin1(text)))}>`,
    stream: (num, data, gen = 0, method = info.stmMethod) => encryptBytes(method, key, num, gen, data)
  }
}

export const encryptDictText = (p: Protection, opts: { direct?: boolean } = {}): string => {
  const i = p.info
  const hex = (b?: Uint8Array): string => `<${toHex(b ?? new Uint8Array(0))}>`
  const parts = [`/Filter /Standard /V ${i.V} /R ${i.R} /P ${i.P} /O ${hex(i.O)} /U ${hex(i.U)}`]
  if (i.V >= 2) parts.push(`/Length ${i.keyBits}`)
  if (i.R >= 5) parts.push(`/OE ${hex(i.OE)} /UE ${hex(i.UE)} /Perms ${hex(i.Perms)}`)
  if (i.V >= 4) {
    const cf = Object.entries(i.cryptFilters)
      .filter(([n]) => n !== 'Identity')
      .map(([n, m]) => `/${n} << /Type /CryptFilter /CFM /${m === 'RC4' ? 'V2' : m} /AuthEvent /DocOpen /Length ${i.keyBits >> 3} >>`)
    parts.push(`/CF << ${cf.join(' ')} >> /StmF /${i.stmFilterName} /StrF /${i.strFilterName}`)
  }
  if (!i.encryptMetadata) parts.push('/EncryptMetadata false')
  void opts
  return `<< ${parts.join(' ')} >>`
}

export interface RawObject {
  num: number
  gen?: number
  /** Everything between `n g obj` and `endobj`. */
  body: Uint8Array | string
}

const bytes = (b: Uint8Array | string): Uint8Array => (typeof b === 'string' ? fromLatin1(b) : b)

/** Assembles objects into a classic-xref file. Returns the bytes and the offset of each object. */
export function assemble(objects: RawObject[], trailerExtra: string, opts: { header?: string; size?: number; prev?: { bytes: Uint8Array; xrefOffset: number } } = {}): { bytes: Uint8Array; offsets: Map<number, number>; xrefOffset: number } {
  const base = opts.prev?.bytes ?? fromLatin1(`${opts.header ?? '%PDF-1.7'}\n%\xe2\xe3\xcf\xd3\n`)
  const chunks: Uint8Array[] = [base]
  let pos = base.length
  const offsets = new Map<number, number>()
  for (const o of objects) {
    offsets.set(o.num, pos)
    const c = concat(fromLatin1(`${o.num} ${o.gen ?? 0} obj\n`), bytes(o.body), fromLatin1('\nendobj\n'))
    chunks.push(c)
    pos += c.length
  }
  const xrefOffset = pos
  const sorted = [...objects].sort((a, b) => a.num - b.num)
  let xref = 'xref\n'
  if (!opts.prev) xref += `0 1\n0000000000 65535 f \n`
  // One subsection per run of consecutive numbers.
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].num === sorted[j].num + 1) j++
    xref += `${sorted[i].num} ${j - i + 1}\n`
    for (let k = i; k <= j; k++) xref += `${String(offsets.get(sorted[k].num)!).padStart(10, '0')} ${String(sorted[k].gen ?? 0).padStart(5, '0')} n \n`
    i = j + 1
  }
  const maxNum = Math.max(...sorted.map((o) => o.num))
  const prev = opts.prev ? ` /Prev ${opts.prev.xrefOffset}` : ''
  const tail = fromLatin1(`${xref}trailer\n<< /Size ${Math.max(maxNum + 1, opts.size ?? 0)}${prev} ${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  chunks.push(tail)
  return { bytes: concat(...chunks), offsets, xrefOffset }
}

export const streamObject = (dictExtra: string, data: Uint8Array): Uint8Array =>
  concat(fromLatin1(`<< ${dictExtra} /Length ${data.length} >>\nstream\n`), data, fromLatin1('\nendstream'))

/** A minimal one-page document skeleton; `content` is the page's content stream object body. */
export function pageObjects(content: Uint8Array | string, extra: RawObject[] = []): RawObject[] {
  return [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 4, body: content },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ...extra
  ]
}

export const showText = (s: string): Uint8Array => utf8(`BT /F1 24 Tf 72 700 Td (${s}) Tj ET`)
export { latin1 }
