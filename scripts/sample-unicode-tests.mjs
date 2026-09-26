/**
 * Developer tool (needs network): creates the vendored samples of the official Unicode bidi conformance files
 * used by tests/unit/text-bidi.test.ts. The samples keep every Nth test line of Unicode 13.0.0's
 * BidiTest.txt and BidiCharacterTest.txt (the version bidi-js implements), with the original file header, so the
 * repository does not carry 15 MB of test data.
 *
 *   node scripts/sample-unicode-tests.mjs
 *
 * Source: https://www.unicode.org/Public/13.0.0/ucd/ (Unicode Terms of Use / Unicode License: free to use).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'tests', 'fixtures', 'unicode')
mkdirSync(out, { recursive: true })

async function text(name) {
  const r = await fetch(`https://www.unicode.org/Public/13.0.0/ucd/${name}`)
  if (!r.ok) throw new Error(`${r.status} ${name}`)
  return (await r.text()).replace(/\r\n/g, '\n')
}

const note = (name, n) =>
  `# SAMPLE of ${name} (Unicode 13.0.0): every ${n}th test line of the original file, original comments below.\n` +
  '# Source: https://www.unicode.org/Public/13.0.0/ucd/ - (c) Unicode, Inc., see https://www.unicode.org/terms_of_use.html\n#\n'

// BidiCharacterTest: header comments + every 35th data line.
{
  const n = 35
  const lines = (await text('BidiCharacterTest.txt')).split('\n')
  const kept = []
  let k = 0
  for (const l of lines) {
    if (l.startsWith('#') || l.trim() === '') {
      if (k === 0) kept.push(l)
      continue
    }
    if (k++ % n === 0) kept.push(l)
  }
  writeFileSync(join(out, 'BidiCharacterTest.sample.txt'), note('BidiCharacterTest.txt', n) + kept.join('\n') + '\n')
  console.log('BidiCharacterTest sample lines', kept.length)
}

// BidiTest: keep the header block (comments) + every 40th data line, re-emitting @Levels/@Reorder when they change.
{
  const n = 40
  const lines = (await text('BidiTest.txt')).split('\n')
  const kept = []
  let levels = ''
  let reorder = ''
  let emitted = { levels: '', reorder: '' }
  let k = 0
  let inHeader = true
  for (const l of lines) {
    if (inHeader) {
      if (l.startsWith('@')) inHeader = false
      else {
        kept.push(l)
        continue
      }
    }
    if (l.startsWith('@Levels:')) levels = l
    else if (l.startsWith('@Reorder:')) reorder = l
    else if (l.startsWith('#') || l.trim() === '') continue
    else if (k++ % n === 0) {
      if (emitted.levels !== levels) kept.push(levels), (emitted.levels = levels)
      if (emitted.reorder !== reorder) kept.push(reorder), (emitted.reorder = reorder)
      kept.push(l)
    }
  }
  writeFileSync(join(out, 'BidiTest.sample.txt'), note('BidiTest.txt', n) + kept.join('\n') + '\n')
  console.log('BidiTest sample lines', kept.length)
}
