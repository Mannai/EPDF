import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPageText } from '../../src/shared/pagetext'
import { PRESENTATION_IDS, engineColumns, engineLines, enginePara, engineRotatedText, presentationForms, withRotation } from '../fixtures/pagetext/engine'
import { corpus, fixtureBytes, lineTexts, linesOf, modelsOf, norm, pdfjsText } from './helpers/pagetext'
import { setupText } from './helpers/text'

/**
 * The page text model against ground truth (the logical source strings of tests/fixtures/pagetext/corpus.json) for
 * every producer: LibreOffice, Chromium's Skia PDF backend, Epdf's text engine and legacy-style pdf-lib output
 * (visual-order presentation forms, with and without /ToUnicode). Comparison: exact after NFC + whitespace collapsing.
 * What PDF.js extracts from the same files is printed alongside (the reason this model exists).
 */
setupText()

const byId = (id: string): string => corpus.lines.find((l) => l.id === id)!.text
const paragraphs = corpus.paragraphs.map((p) => p.text)
const columns = [corpus.columns.first, corpus.columns.second]

const report: string[] = []
async function compareWithPdfjs(name: string, bytes: Uint8Array, expected: string[]): Promise<void> {
  const pj = norm(await pdfjsText(bytes))
  const got = expected.filter((l) => pj.includes(norm(l))).length
  report.push(`${name.padEnd(34)} PDF.js finds ${got}/${expected.length} source lines verbatim`)
}

async function expectLines(bytes: Uint8Array, expected: string[], name: string): Promise<void> {
  const [m] = await modelsOf(bytes)
  expect(linesOf(m).map(norm), name).toEqual(expected.map(norm))
  expect(m.stats.unknown, `${name}: undecoded glyphs`).toBe(0)
  expect(m.lines.every((l) => l.exact), `${name}: every line inverted exactly`).toBe(true)
  await compareWithPdfjs(name, bytes, expected)
}

async function expectText(bytes: Uint8Array, expected: string[], name: string): Promise<void> {
  const [m] = await modelsOf(bytes)
  expect(norm(m.text), name).toBe(norm(expected.join(' ')))
  await compareWithPdfjs(name, bytes, expected)
}

describe('LibreOffice (writer_web_pdf_Export)', () => {
  it('one line per corpus item: Arabic plain/vocalised/dates/Arabic-Indic digits/punctuation, Persian, Urdu, Hebrew, Hindi, Chinese, Latin', async () => {
    await expectLines(fixtureBytes('lo-lines.pdf'), lineTexts, 'lo-lines')
  })
  it('wrapped right-to-left paragraphs read top to bottom, each line right to left', async () => {
    await expectText(fixtureBytes('lo-para.pdf'), paragraphs, 'lo-para')
  })
  it('two right-to-left columns: the right column first', async () => {
    await expectText(fixtureBytes('lo-columns.pdf'), columns, 'lo-columns')
  })
  it('an independent check document (Arial): date, time, (BHD 45.500), e-mail, phone, tashkeel, Arabic-Indic years', async () => {
    await expectLines(fixtureBytes('lo-fresh.pdf'), corpus.fresh, 'lo-fresh')
  })
  it('the same page shown with /Rotate 270', async () => {
    await expectLines(fixtureBytes('lo-rotated-page.pdf'), lineTexts, 'lo-rotated-page')
  })
})

describe('Chromium printToPDF (Skia)', () => {
  it('one line per corpus item', async () => {
    await expectLines(fixtureBytes('chromium-lines.pdf'), lineTexts, 'chromium-lines')
  })
  it('wrapped paragraphs', async () => {
    await expectText(fixtureBytes('chromium-para.pdf'), paragraphs, 'chromium-para')
  })
  it('two columns (right first)', async () => {
    await expectText(fixtureBytes('chromium-columns.pdf'), columns, 'chromium-columns')
  })
  it('rotated text (CSS transforms: -90 and +30 degrees)', async () => {
    const [m] = await modelsOf(fixtureBytes('chromium-rotated.pdf'))
    const lines = linesOf(m).map(norm)
    expect(lines).toContain(norm(byId('ar-date')))
    expect(lines).toContain(norm(byId('ar-hello')))
    const angles = m.lines.map((l) => l.angle).sort((a, b) => a - b)
    expect(angles).toEqual([-90, 30])
  })
})

describe('Epdf text engine (ToUnicode + ActualText)', () => {
  it('one line per corpus item', async () => {
    await expectLines(await engineLines(), lineTexts, 'engine-lines')
  })
  it('wrapped paragraphs', async () => {
    await expectText(await enginePara(), paragraphs, 'engine-para')
  })
  it('two columns', async () => {
    await expectText(await engineColumns(), columns, 'engine-columns')
  })
  it('rotated text: 90, -30 and 180 degrees', async () => {
    const [m] = await modelsOf(await engineRotatedText())
    const lines = linesOf(m).map(norm)
    expect(lines).toContain(norm(byId('ar-hello')))
    expect(lines).toContain(norm(byId('ar-date')))
    expect(lines).toContain('Rotated Latin text')
  })
  it('a page with /Rotate 90', async () => {
    await expectLines(await withRotation(await engineLines(), 90), lineTexts, 'engine-rotated-page')
  })
})

describe('legacy producer style: pdf-lib drawing pre-shaped presentation forms in visual order', () => {
  const expected = [...PRESENTATION_IDS.map(byId), byId('he')]
  it('with /ToUnicode (presentation forms -> base letters, visual -> logical, spaces from gaps)', async () => {
    await expectLines(fixtureBytes('pdflib-presentation.pdf'), expected, 'pdflib-presentation')
  })
  // A full (not subset) font with one glyph per presentation form, like the fonts legacy producers used (Arial has
  // them; the bundled Noto fonts decompose letters into dotless shapes plus dots, which no cmap can map back).
  const ARIAL = 'C:/Windows/Fonts/arial.ttf'
  it.skipIf(!existsSync(ARIAL))('without /ToUnicode: text from the embedded font program (its cmap)', async () => {
    const bytes = await presentationForms({ toUnicode: false, fontsDir: 'resources', subset: false, fontFile: ARIAL })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.context.enumerateIndirectObjects().some(([, o]) => String(o).includes('/ToUnicode'))).toBe(false)
    await expectLines(bytes, expected, 'pdflib-presentation (no ToUnicode)')
  })
  it('a subset font with neither /ToUnicode nor cmap nor glyph names is reported as unreadable, not guessed', async () => {
    const bytes = await presentationForms({ toUnicode: false, fontsDir: 'resources', subset: true })
    const [m] = await modelsOf(bytes)
    expect(m.stats.unknown).toBeGreaterThan(50)
    expect(m.text.replace(/\s/g, '')).toBe('')
  })
})

describe('Latin control', () => {
  it('standard-14 fonts (no embedded program): the model reads what PDF.js reads', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 400])
    const lines = ['The quick brown fox jumps over the lazy dog.', 'Second line, with numbers 1,234.50 and (brackets).', 'Kerning: AVA WAVE Toy']
    lines.forEach((t, i) => page.drawText(t, { x: 30, y: 350 - i * 20, size: 12, font }))
    const bytes = await pdf.save()
    const [m] = await modelsOf(bytes)
    expect(linesOf(m)).toEqual(lines)
    expect(norm(m.text)).toBe(norm(await pdfjsText(bytes)))
  })
})

describe('the evidence files from the bug report (optional: present only in a developer checkout)', () => {
  const lo = 'lo-arabic-evidence.pdf'
  const engine = 'engine-arabic-evidence.pdf'
  it.skipIf(!existsSync(lo))('LibreOffice evidence', async () => {
    const [m] = await modelsOf(new Uint8Array(readFileSync(lo)))
    expect(linesOf(m).map(norm)).toEqual(['ar-hello', 'ar-vocalised', 'ar-date', 'ar-indic-digits'].map(byId).map(norm))
  })
  it.skipIf(!existsSync(engine))('text engine evidence', async () => {
    const [m] = await modelsOf(new Uint8Array(readFileSync(engine)))
    const lines = linesOf(m).map(norm)
    for (const id of ['ar-hello', 'ar-vocalised', 'ar-date', 'ar-indic-digits']) expect(lines).toContain(norm(byId(id)))
  })
})

describe('summary', () => {
  it('prints what PDF.js makes of the same files', () => {
    console.log(`\nPDF.js getTextContent on the same fixtures (the page text model reads all of them exactly):\n  ${report.join('\n  ')}`)
    expect(report.every((r) => /finds \d+\/\d+/.test(r))).toBe(true)
  })
})

// keep the import used even when every optional case is skipped
void buildPageText
