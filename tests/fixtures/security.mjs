// Generates the encrypted fixtures in tests/fixtures/security/ with qpdf, an INDEPENDENT implementation.
// The results are committed, so the tests never need qpdf: run this only to (re)create them.
//   node tests/fixtures/security.mjs
// Passwords are documented in tests/fixtures/security/README.txt (written by this script) and in
// docs/features/security.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'

const out = resolve('tests/fixtures/security')
mkdirSync(out, { recursive: true })
const QPDF = process.env.QPDF ?? (process.platform === 'win32' ? 'C:\\Program Files\\qpdf 12.4.1\\bin\\qpdf.exe' : '/usr/bin/qpdf')

/** The plaintext source every fixture is derived from. Its content is asserted by the tests. */
export async function buildSource() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Secret page ${i}`, { x: 72, y: 700, size: 28, font, color: rgb(0, 0, 0) })
    p.drawText('The quick brown fox jumps over the lazy dog 12345.', { x: 72, y: 640, size: 14, font })
  }
  doc.setTitle('Security Fixture Title')
  doc.setAuthor('Fixture Author')
  doc.setCreationDate(new Date('2024-01-02T03:04:05Z'))
  doc.setModificationDate(new Date('2024-01-02T03:04:05Z'))
  doc.setProducer('epdf fixtures')
  // A string inside an annotation, and an XMP metadata stream (for EncryptMetadata tests).
  const annot = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50, 50, 70, 70], Contents: PDFString.of('Annotation note'), T: PDFHexString.fromText('Ann\u00e4 \u00d6') })
  )
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]))
  const xmp = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>XMP-MARKER-TITLE</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  const meta = doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta))
  return doc.save({ useObjectStreams: false })
}

export const FIXTURES = [
  // name, [args before --encrypt], encrypt args, extra args after
  ['rc4-40', ['--allow-weak-crypto'], ['user40', 'owner40', '40'], []],
  ['rc4-128', ['--allow-weak-crypto'], ['user128', 'owner128', '128', '--use-aes=n'], []],
  ['aes-128', [], ['userAes', 'ownerAes', '128', '--use-aes=y'], []],
  ['aes-256-r6', [], ['user256', 'owner256', '256'], []],
  ['aes-256-r5', ['--allow-weak-crypto'], ['user5', 'owner5', '256', '--force-R5'], []],
  ['user-only', [], ['onlyuser', 'ownerZZZ', '256'], []], // owner password nobody knows in the tests
  ['owner-only', [], ['', 'onlyowner', '256'], []], // opens with the empty user password
  ['no-permissions-aes128', [], ['u128', 'o128', '128', '--use-aes=y', '--print=none', '--modify=none', '--extract=n', '--annotate=n', '--assemble=n', '--form=n', '--modify-other=n', '--accessibility=n'], []],
  ['no-permissions-aes256', [], ['u256p', 'o256p', '256', '--print=none', '--modify=none', '--extract=n', '--annotate=n', '--assemble=n', '--form=n', '--modify-other=n', '--accessibility=n'], []],
  ['lowres-print-rc4-128', ['--allow-weak-crypto'], ['ulow', 'olow', '128', '--use-aes=n', '--print=low'], []],
  ['cleartext-metadata-aes128', [], ['umeta', 'ometa', '128', '--use-aes=y', '--cleartext-metadata'], []],
  ['cleartext-metadata-aes256', [], ['umeta6', 'ometa6', '256', '--cleartext-metadata'], []],
  ['objstm-aes256', [], ['userObj', 'ownerObj', '256'], ['--object-streams=generate']],
  ['objstm-aes128', [], ['userObj', 'ownerObj', '128', '--use-aes=y'], ['--object-streams=generate']],
  ['objstm-rc4-128', ['--allow-weak-crypto'], ['userObj', 'ownerObj', '128', '--use-aes=n', '--force-V4'], ['--object-streams=generate']],
  ['unicode-password-aes256', [], ['p\u00e4ss\u00f6\u20ac', 'o\u00fcw', '256'], []],
  ['latin1-password-rc4-128', ['--allow-weak-crypto'], ['p\u00e4ss\u00f6', 'o\u00fcw', '128', '--use-aes=n'], []]
]

export const PASSWORDS = `Fixtures in this folder are produced by qpdf (an independent implementation) from one plaintext source
(3 pages: "Secret page N", "The quick brown fox jumps over the lazy dog 12345.", Title "Security Fixture Title").
Regenerate with: node tests/fixtures/security.mjs

file                          user password     owner password    notes
${FIXTURES.map(([n, , e]) => `${n.padEnd(29)} ${JSON.stringify(e[0]).padEnd(17)} ${JSON.stringify(e[1]).padEnd(17)} ${e.slice(2).join(' ')}`).join('\n')}
`

async function main() {
  const src = await buildSource()
  writeFileSync(join(out, 'plain.pdf'), src)
  if (!existsSync(QPDF)) throw new Error(`qpdf not found at ${QPDF} (set QPDF)`)
  for (const [name, pre, enc, post] of FIXTURES) {
    const args = [...pre, '--encrypt', ...enc, '--', ...post, join(out, 'plain.pdf'), join(out, `${name}.pdf`)]
    execFileSync(QPDF, args, { stdio: 'inherit' })
  }
  writeFileSync(join(out, 'README.txt'), PASSWORDS)
  console.log('wrote', FIXTURES.length, 'fixtures to', out)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\//, ''))) await main()
