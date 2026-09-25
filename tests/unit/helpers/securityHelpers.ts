import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { authenticate, type Access, type EncryptionInfo } from '../../../src/renderer/src/features/security/crypto/handler'
import { decryptDocument, inspectEncryption, type EncryptionProbe } from '../../../src/renderer/src/features/security/crypto/document'

export const FIXTURE_DIR = resolve(__dirname, '..', '..', 'fixtures', 'security')
export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURE_DIR, `${name}.pdf`)))

/** pdf-lib writes standard-font text as hex strings; show them as literal strings so tests can match the words. */
const showHex = (s: string): string =>
  s.replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_m, hex: string) => `(${Buffer.from(hex.replace(/\s+/g, ''), 'hex').toString('latin1')}) Tj`)

/** All decoded content of every stream in a (plain) document, as text: enough to check page content survived. */
export async function allStreamText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  let out = ''
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue
    try {
      if (obj instanceof PDFRawStream) out += showHex(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1')) + '\n'
    } catch {
      out += '[undecodable stream]\n'
    }
  }
  return out
}

export interface Opened {
  probe: EncryptionProbe
  info: EncryptionInfo
  access: Access
  plain: Uint8Array
}

/** Inspect + authenticate + decrypt, throwing if the password is wrong. */
export async function openWith(bytes: Uint8Array, password: string): Promise<Opened> {
  const probe = await inspectEncryption(bytes)
  if (!probe) throw new Error('not encrypted')
  const access = await authenticate(probe.info, password)
  if (!access) throw new Error('wrong password')
  return { probe, info: probe.info, access, plain: await decryptDocument(bytes, probe, access) }
}

export async function infoString(bytes: Uint8Array, key: string): Promise<string | undefined> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return undefined
  const v = info.lookup(PDFName.of(key))
  return v && 'decodeText' in v ? (v as unknown as { decodeText(): string }).decodeText() : undefined
}

/** The plaintext content every qpdf fixture was made from (see tests/fixtures/security.mjs). */
export async function expectFixturePlaintext(plain: Uint8Array, opts: { metadata?: boolean } = {}): Promise<string[]> {
  const problems: string[] = []
  const pdf = await PDFDocument.load(plain, { updateMetadata: false })
  if (pdf.getPageCount() !== 3) problems.push(`page count ${pdf.getPageCount()}`)
  const text = await allStreamText(plain)
  for (let i = 1; i <= 3; i++) if (!text.includes(`(Secret page ${i}) Tj`)) problems.push(`page ${i} text missing`)
  if (!text.includes('The quick brown fox jumps over the lazy dog 12345.')) problems.push('body text missing')
  if ((await infoString(plain, 'Title')) !== 'Security Fixture Title') problems.push(`title ${await infoString(plain, 'Title')}`)
  if ((await infoString(plain, 'Author')) !== 'Fixture Author') problems.push('author')
  if (opts.metadata !== false && !text.includes('XMP-MARKER-TITLE')) problems.push('XMP metadata missing')
  const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'))
  const annot = annots && 'lookup' in annots ? (annots as unknown as { lookup(i: number): unknown }).lookup(0) : undefined
  if (!(annot instanceof PDFDict)) problems.push('annotation missing')
  else {
    const c = annot.lookup(PDFName.of('Contents')) as unknown as { decodeText(): string } | undefined
    if (c?.decodeText() !== 'Annotation note') problems.push(`annotation contents ${c?.decodeText()}`)
    const t = annot.lookup(PDFName.of('T')) as unknown as { decodeText(): string } | undefined
    if (t?.decodeText() !== 'Annä Ö') problems.push(`annotation title ${t?.decodeText()}`)
  }
  return problems
}
