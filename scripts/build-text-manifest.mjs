/**
 * Developer tool: (re)generates resources/fonts/text-fonts.json (the catalogue the text engine reads at runtime:
 * family, weight, metrics and the exact Unicode coverage of every bundled font) and LICENSE-TextFonts.txt (the
 * copyright notices of the fonts + a pointer to the OFL text). Run it after adding or changing a font:
 *
 *   node scripts/build-text-manifest.mjs
 *
 * Reading the fonts with HarfBuzz means the coverage is what shaping will really find, not what a table claims.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as hb from '../src/shared/text/vendor/harfbuzz/index.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fontsDir = join(root, 'resources', 'fonts')
await hb.initHarfBuzz({ wasmBinary: readFileSync(join(root, 'resources', 'text', 'harfbuzz.wasm')) })

/** Curated facts that are not in the font: ISO 15924 scripts each family is meant for, and its category. */
const FAMILY_INFO = {
  'Noto Sans': { category: 'sans', scripts: ['Latn', 'Grek', 'Cyrl'] },
  'Liberation Sans': { category: 'sans', scripts: ['Latn', 'Grek', 'Cyrl'] },
  'Liberation Serif': { category: 'serif', scripts: ['Latn', 'Grek', 'Cyrl'] },
  'Liberation Mono': { category: 'mono', scripts: ['Latn', 'Grek', 'Cyrl'] },
  Carlito: { category: 'sans', scripts: ['Latn', 'Grek', 'Cyrl'] },
  Caladea: { category: 'serif', scripts: ['Latn', 'Grek', 'Cyrl'] },
  Allura: { category: 'script', scripts: ['Latn'] },
  'Great Vibes': { category: 'script', scripts: ['Latn'] },
  Sacramento: { category: 'script', scripts: ['Latn'] },
  'Homemade Apple': { category: 'script', scripts: ['Latn'] },
  'Noto Sans Arabic': { category: 'sans', scripts: ['Arab'] },
  'Noto Naskh Arabic': { category: 'serif', scripts: ['Arab'] },
  'Noto Nastaliq Urdu': { category: 'serif', scripts: ['Arab'] },
  'Noto Sans Hebrew': { category: 'sans', scripts: ['Hebr'] },
  'Noto Sans Thai': { category: 'sans', scripts: ['Thai'] },
  'Noto Sans Devanagari': { category: 'sans', scripts: ['Deva'] },
  'Noto Sans Bengali': { category: 'sans', scripts: ['Beng'] },
  'Noto Sans Tamil': { category: 'sans', scripts: ['Taml'] },
  'Noto Sans Telugu': { category: 'sans', scripts: ['Telu'] },
  'Noto Sans Gujarati': { category: 'sans', scripts: ['Gujr'] },
  'Noto Sans Gurmukhi': { category: 'sans', scripts: ['Guru'] },
  'Noto Sans Kannada': { category: 'sans', scripts: ['Knda'] },
  'Noto Sans Malayalam': { category: 'sans', scripts: ['Mlym'] },
  'Noto Sans Oriya': { category: 'sans', scripts: ['Orya'] },
  'Noto Sans Sinhala': { category: 'sans', scripts: ['Sinh'] },
  'Noto Sans Thaana': { category: 'sans', scripts: ['Thaa'] },
  'Noto Sans Syriac': { category: 'sans', scripts: ['Syrc'] },
  'Noto Sans Armenian': { category: 'sans', scripts: ['Armn'] },
  'Noto Sans Georgian': { category: 'sans', scripts: ['Geor'] },
  'Noto Sans Lao': { category: 'sans', scripts: ['Laoo'] },
  'Noto Sans Khmer': { category: 'sans', scripts: ['Khmr'] },
  'Noto Sans Myanmar': { category: 'sans', scripts: ['Mymr'] },
  'Noto Sans Ethiopic': { category: 'sans', scripts: ['Ethi'] },
  'Noto Sans Symbols': { category: 'symbol', scripts: [] },
  'Noto Sans Symbols 2': { category: 'symbol', scripts: [] },
  'Noto Sans Math': { category: 'symbol', scripts: [] },
  'Noto Emoji': { category: 'emoji', scripts: [] },
  'Noto Sans SC': { category: 'cjk', scripts: ['Hani', 'Hans', 'Hira', 'Kana', 'Bopo'] },
  'Noto Sans TC': { category: 'cjk', scripts: ['Hani', 'Hant', 'Hira', 'Kana', 'Bopo'] },
  'Noto Sans JP': { category: 'cjk', scripts: ['Hani', 'Jpan', 'Hira', 'Kana'] },
  'Noto Sans KR': { category: 'cjk', scripts: ['Hani', 'Kore', 'Hang'] }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const files = readdirSync(fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f)).sort()
const families = new Map()
const notices = new Map()
const u16 = (b, o) => (b[o] << 8) | b[o + 1]

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(join(fontsDir, file)))
  const face = new hb.Face(new hb.Blob(bytes))
  const font = new hb.Font(face)
  const tag = (t) => face.referenceTable(t)
  const head = tag('head')
  const upem = u16(head, 18)
  const macStyle = u16(head, 44)
  const os2 = tag('OS/2')
  const weight = os2 ? u16(os2, 4) : macStyle & 1 ? 700 : 400
  const fsSelection = os2 ? u16(os2, 62) : 0
  const italic = !!(fsSelection & 1) || !!(macStyle & 2)
  const maxp = tag('maxp')
  const numGlyphs = u16(maxp, 4)
  const outline = tag('CFF ') || tag('CFF2') ? 'cff' : 'glyf'
  font.setScale(upem, upem)
  const ext = font.hExtents()
  const family = face.getName(16, 'en') || face.getName(1, 'en')
  const style = face.getName(17, 'en') || face.getName(2, 'en') || ''
  const copyright = face.getName(0, 'en')
  const uni = Array.from(face.collectUnicodes()).sort((a, b) => a - b)
  const ranges = []
  for (const cp of uni) {
    const last = ranges[ranges.length - 1]
    if (last && cp === last[1] + 1) last[1] = cp
    else ranges.push([cp, cp])
  }
  const info = FAMILY_INFO[family]
  if (!info) console.warn('!! no FAMILY_INFO for', JSON.stringify(family), file)
  const id = slug(family)
  if (!families.has(id)) families.set(id, { id, name: family, category: info?.category ?? 'sans', scripts: info?.scripts ?? [], faces: [] })
  families.get(id).faces.push({
    file,
    style,
    weight,
    italic,
    upem,
    ascent: ext.ascender,
    descent: ext.descender,
    lineGap: ext.lineGap,
    numGlyphs,
    outline,
    bytes: statSync(join(fontsDir, file)).size,
    license: /HomemadeApple/.test(file) ? 'Apache-2.0' : 'OFL-1.1',
    ranges: ranges.flat()
  })
  if (copyright) notices.set(family, copyright.replace(/\s+/g, ' ').trim())
  console.log(file.padEnd(38), family.padEnd(22), String(weight).padEnd(4), italic ? 'italic' : '      ', outline, String(numGlyphs).padStart(6), 'glyphs', String(uni.length).padStart(6), 'cps')
}

const manifest = { version: 1, families: [...families.values()] }
writeFileSync(join(fontsDir, 'text-fonts.json'), JSON.stringify(manifest))
const kb = Math.round(JSON.stringify(manifest).length / 1024)
console.log(`wrote text-fonts.json (${kb} KB, ${families.size} families, ${files.length} faces)`)

const lines = [
  'Fonts bundled for the Epdf text engine (src/shared/text)',
  '',
  'All fonts are licensed under the SIL Open Font License 1.1 (full text: OFL-1.1.txt, and the license files next to the',
  'older fonts) except Homemade Apple (Apache License 2.0, see LICENSE-Apache-2.0-HomemadeApple.txt).',
  'Fonts are embedded in PDFs only as subsets of the glyphs used, which the OFL permits; the subset keeps the',
  'font name and copyright notice. The fonts are not sold on their own.',
  '',
  'Copyright notices (from the fonts’ name tables):',
  ''
]
for (const [family, c] of [...notices].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`* ${family}: ${c}`)
lines.push('')
writeFileSync(join(fontsDir, 'LICENSE-TextFonts.txt'), lines.join('\n'), 'utf8')
