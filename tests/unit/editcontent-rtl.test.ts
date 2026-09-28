import fontkit from '@pdf-lib/fontkit'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, PDFName, PDFOperator } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawText, measureText } from '../../src/shared/text'
import { interpretPage } from '../../src/shared/pagetext'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import type { TextBlock } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { paragraphAlign } from '../../src/renderer/src/features/textedit/pdfcontent/logical'
import { fallbackStack, familyOfBaseFont, scriptPieces, sfntFsType } from '../../src/renderer/src/features/textedit/pdfcontent/logicalEdit'
import { applyTextEdit, pageBlocks, type TextEditResult } from '../../src/renderer/src/features/textedit/pdfcontent/textEdit'
import corpus from '../fixtures/pagetext/corpus.json'
import { PRESENTATION_IDS, presentationForms } from '../fixtures/pagetext/engine'
import { norm, pageModel } from '../support/retrofit'
import { SOFFICE } from '../support/tools'

/**
 * Editing EXISTING right-to-left and complex-script text in place (docs/features/edit-content.md, "Right-to-left and
 * complex-script text"): the page text model finds the logical line and the content-stream glyphs that draw it, the
 * editor shows the text as it is read, and a commit removes those glyphs and draws the new text with the text engine.
 * Every result is read back with the page text model (PDF.js cannot read these producers' Arabic in logical order).
 */

const FIX = 'tests/fixtures/pagetext'
const OUT = resolve('test-results/editcontent-rtl')
mkdirSync(OUT, { recursive: true })

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIX, name)))

async function blocksOf(bytes: Uint8Array): Promise<{ lines: TextBlock[]; paragraphs: TextBlock[] }> {
  const pdf = await PDFDocument.load(bytes)
  return pageBlocks(pdf, analyzePage(pdf, 0))
}

interface Edited extends TextEditResult {
  bytes: Uint8Array
  before: TextBlock
}

async function edit(
  bytes: Uint8Array,
  pick: (b: TextBlock) => boolean,
  newText: string | ((old: string) => string),
  opts: { paragraph?: boolean; size?: number; color?: string } = {}
): Promise<Edited> {
  const pdf = await PDFDocument.load(bytes)
  const set = pageBlocks(pdf, analyzePage(pdf, 0))
  const b = (opts.paragraph ? set.paragraphs : set.lines).find((x) => x.logical && pick(x))
  if (!b) throw new Error('block not found')
  expect(b.editable, b.reason).toBe(true)
  const next = typeof newText === 'string' ? newText : newText(b.text)
  const res = await applyTextEdit(pdf, 0, { blockId: b.id, oldText: b.text, newText: next, size: opts.size, color: opts.color })
  return { ...res, bytes: await pdf.save(), before: b }
}

const startsWith = (s: string) => (b: TextBlock): boolean => norm(b.text).startsWith(norm(s))
const linesOf = async (bytes: Uint8Array): Promise<string[]> => (await pageModel(bytes)).text.split('\n').map(norm)

/** Every /ActualText in the page content (what Acrobat, pdfium and poppler would extract instead of the glyphs). */
async function actualTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes)
  return interpretPage(pdf, 0).spans.map((s) => norm(s.text))
}

const corpusLine = (id: string): string => corpus.lines.find((l) => l.id === id)!.text
const COMPLEX_IDS = corpus.lines.filter((l) => !['zh', 'latin'].includes(l.id)).map((l) => l.id)

// ---------------------------------------------------------------------------------------------------------------

describe('logical blocks: what the editor offers on right-to-left pages', () => {
  const producers: [string, string[]][] = [
    ['lo-lines.pdf', COMPLEX_IDS],
    ['chromium-lines.pdf', COMPLEX_IDS],
    ['engine-lines.pdf', COMPLEX_IDS],
    ['pdflib-presentation.pdf', [...PRESENTATION_IDS, 'he']]
  ]
  for (const [file, ids] of producers) {
    it(`${file}: every line is one editable block holding the text as it is read`, async () => {
      const set = await blocksOf(fixture(file))
      for (const id of ids) {
        const want = norm(corpusLine(id))
        const found = set.lines.filter((b) => b.logical && norm(b.text) === want)
        expect(found, `${file} ${id}`).toHaveLength(1)
        expect(found[0].editable, `${file} ${id}: ${found[0].reason}`).toBe(true)
        expect(found[0].logical!.dir).toBe(corpus.lines.find((l) => l.id === id)?.dir ?? 'rtl')
      }
      // no stray blocks left over from marks, letter pieces or glyphs without Unicode
      // eslint-disable-next-line no-control-regex
      for (const b of set.lines) if (!b.logical) expect(/^[\s\p{M}\u0000-\u001f�]*$/u.test(b.text), JSON.stringify(b.text)).toBe(false)
    })
  }

  it('LibreOffice fresh document (Arial, dir on <html>): dates, amounts, e-mail, phone, tashkeel, Arabic-Indic years', async () => {
    const set = await blocksOf(fixture('lo-fresh.pdf'))
    for (const t of corpus.fresh) {
      const b = set.lines.find((x) => x.logical && norm(x.text) === norm(t))
      expect(b, t).toBeTruthy()
      expect(b!.editable).toBe(true)
    }
  })

  it('paragraph scope: wrapped right-to-left paragraphs from three producers, alignment detected', async () => {
    const para = corpus.paragraphs.find((p) => p.id === 'ar-para')!
    for (const file of ['lo-para.pdf', 'chromium-para.pdf', 'engine-para.pdf']) {
      const set = await blocksOf(fixture(file))
      const p = set.paragraphs.find((b) => b.logical && norm(b.text.replace(/\n/g, ' ')) === norm(para.text))
      expect(p, file).toBeTruthy()
      expect(p!.editable).toBe(true)
      expect(p!.logical!.dir).toBe('rtl')
      expect(p!.logical!.align).toBe('right')
      expect(p!.lines.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('Latin-only pages keep the editor’s own blocks (nothing is read twice)', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    page.drawText('Hello world', { x: 40, y: 200, size: 14 })
    const set = await blocksOf(await pdf.save())
    expect(set.lines.map((b) => b.text)).toEqual(['Hello world'])
    expect(set.lines[0].logical).toBeUndefined()
  })
})

describe('editing existing right-to-left text', () => {
  const edits: [string, string][] = [
    // replace a word
    ['ar-hello', 'مرحبا يا عالم'],
    // numbers, a date, Latin in brackets (bidi)
    ['ar-date', 'رقم الطلب 67890 بتاريخ 2026-10-01 (Epdf 2.0)'],
    // tashkeel: delete a word of a fully vocalised line
    ['ar-vocalised', 'بِسْمِ اللَّهِ الرَّحِيمِ'],
    // Arabic-Indic digits
    ['ar-indic-digits', 'السعر ٤٥٦٫٧٥ دينار بحريني فقط'],
    // lam-alef ligatures and punctuation
    ['ar-punct', 'لا لا، هل تعلم؟ «الإسلام»'],
    // Latin words inside Arabic
    ['ar-latin', 'برنامج Epdf لتحرير ملفات PDF و DOCX بسهولة'],
    // left-to-right paragraph with an Arabic word
    ['ar-in-ltr', 'The word سلام means peace.'],
    ['fa', 'سلام دنیا، این یک متن فارسی جدید است ۱۴۰۶'],
    ['ur', 'یہ اردو زبان میں ایک نیا جملہ ہے'],
    ['he', 'שלום לכולם, זהו טקסט חדש 2027.'],
    ['he-niqqud', 'בְּרֵאשִׁית בָּרָא'],
    ['hi', 'नमस्ते दुनिया, यह नया पाठ है।']
  ]

  for (const file of ['lo-lines.pdf', 'chromium-lines.pdf', 'engine-lines.pdf']) {
    it(`${file}: every kind of edit reads back in logical order, the old words are gone, the rest is untouched`, async () => {
      let bytes = fixture(file)
      const all = corpus.lines.map((l) => norm(l.text))
      const changed = new Map<string, string>()
      for (const [id, next] of edits) {
        const old = corpusLine(id)
        const r = await edit(bytes, (b) => norm(b.text) === norm(old), next)
        expect(r.noop).toBeFalsy()
        bytes = r.bytes
        changed.set(norm(old), norm(next))
        const lines = await linesOf(bytes)
        expect(lines, `${id} -> ${next}`).toContain(norm(next))
        expect(lines, `old ${id}`).not.toContain(norm(old))
        // every other line reads exactly as before (or as its own edit)
        for (const l of all) if (!changed.has(l)) expect(lines, `untouched: ${l}`).toContain(l)
        // no /ActualText keeps the old words for other readers
        expect((await actualTexts(bytes)).some((t) => t === norm(old))).toBe(false)
      }
      writeFileSync(join(OUT, file.replace('.pdf', '-edited.pdf')), bytes)
    })
  }

  it('pdf-lib pre-shaped presentation forms in visual order (legacy producer)', async () => {
    let bytes = fixture('pdflib-presentation.pdf')
    for (const [id, next] of edits.filter(([i]) => ['ar-hello', 'ar-date', 'ar-indic-digits', 'ar-latin', 'he'].includes(i))) {
      const old = corpusLine(id)
      const r = await edit(bytes, (b) => norm(b.text) === norm(old), next)
      bytes = r.bytes
      const lines = await linesOf(bytes)
      expect(lines).toContain(norm(next))
      expect(lines).not.toContain(norm(old))
    }
  })

  it('a right-to-left line keeps its right edge, baseline, size and colour; a left-to-right one its left edge', async () => {
    for (const file of ['lo-lines.pdf', 'chromium-lines.pdf']) {
      const src = fixture(file)
      const before = await pageModel(src)
      for (const [id, next] of [['ar-hello', 'مرحبا يا عالم جميل جدا'], ['ar-in-ltr', 'The word سلام means peace.']]) {
        const old = corpusLine(id)
        const bl = before.lines.find((l) => norm(before.text.slice(l.start, l.end)) === norm(old))!
        const r = await edit(src, (b) => norm(b.text) === norm(old), next)
        const after = await pageModel(r.bytes)
        const al = after.lines.find((l) => norm(after.text.slice(l.start, l.end)) === norm(next))!
        expect(al.dir).toBe(bl.dir)
        if (bl.dir === 'rtl') expect(Math.abs(al.x1 - bl.x1), `${file} right edge`).toBeLessThan(1)
        else expect(Math.abs(al.x0 - bl.x0), `${file} left edge`).toBeLessThan(1)
        expect(Math.abs(al.baseline - bl.baseline), `${file} baseline`).toBeLessThan(0.3)
        expect(Math.abs(al.size - bl.size), `${file} size`).toBeLessThan(0.05)
      }
    }
  })

  it('colour (RGB, CMYK, gray) and size are kept; the ribbon’s size and colour apply', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([500, 400])
    await drawText(page, 'نص أحمر للتجربة', { x: 460, y: 340, size: 18, color: [0.8, 0, 0], direction: 'rtl', anchor: 'right', fontStack: ['Noto Naskh Arabic'] })
    await drawText(page, 'نص بألوان الطباعة', { x: 460, y: 290, size: 18, color: [0, 1, 1, 0], direction: 'rtl', anchor: 'right', fontStack: ['Noto Naskh Arabic'] })
    await drawText(page, 'نص رمادي', { x: 460, y: 240, size: 18, color: 0.5, direction: 'rtl', anchor: 'right', fontStack: ['Noto Naskh Arabic'] })
    await drawText(page, 'نص يتغير حجمه', { x: 460, y: 190, size: 18, direction: 'rtl', anchor: 'right', fontStack: ['Noto Naskh Arabic'] })
    let bytes = await pdf.save()
    bytes = (await edit(bytes, startsWith('نص أحمر'), 'نص أحمر جديد')).bytes
    bytes = (await edit(bytes, startsWith('نص بألوان'), 'نص بألوان الطباعة الجديدة')).bytes
    bytes = (await edit(bytes, startsWith('نص رمادي'), 'نص رمادي آخر')).bytes
    bytes = (await edit(bytes, startsWith('نص يتغير'), 'نص يتغير حجمه ولونه', { size: 24, color: '#0000ff' })).bytes
    const set = await blocksOf(bytes)
    const find = (t: string): TextBlock => set.lines.find((b) => norm(b.text) === norm(t))!
    expect(find('نص أحمر جديد').color.css).toBe('#cc0000')
    const cmyk = find('نص بألوان الطباعة الجديدة')
    expect(cmyk.color.ops[cmyk.color.ops.length - 1].op).toBe('k')
    expect(find('نص رمادي آخر').color.css).toBe('#808080')
    const resized = find('نص يتغير حجمه ولونه')
    expect(Math.abs(resized.size - 24)).toBeLessThan(0.01)
    expect(resized.color.css).toBe('#0000ff')
    for (const t of ['نص أحمر جديد', 'نص بألوان الطباعة الجديدة', 'نص رمادي آخر']) expect(Math.abs(find(t).size - 18)).toBeLessThan(0.01)
    writeFileSync(join(OUT, 'colours.pdf'), bytes)
  })

  it('an edited line can be edited again; text state left set by the page (Tc, Tz) does not leak into the new text', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([500, 300])
    page.pushOperators(PDFOperator.of('3 Tc 50 Tz' as never))
    await drawText(page, 'سطر للتجربة', { x: 460, y: 200, size: 20, direction: 'rtl', anchor: 'right', fontStack: ['Noto Naskh Arabic'] })
    let bytes = await pdf.save()
    for (const next of ['سطر معدل مرة', 'سطر معدل مرتين']) {
      const r = await edit(bytes, (b) => b.text.startsWith('سطر'), next)
      bytes = r.bytes
      const m = await pageModel(bytes)
      const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === norm(next))!
      expect(l, next).toBeTruthy()
      const natural = (await measureText(next, { size: 20, fontStack: ['Noto Naskh Arabic'], direction: 'rtl' })).width
      expect(Math.abs(l.x1 - l.x0 - natural) / natural, 'width as if Tc 0 / Tz 100').toBeLessThan(0.03)
    }
  })

  it('deleting the whole text of a line removes it and nothing else', async () => {
    const r = await edit(fixture('lo-lines.pdf'), (b) => norm(b.text) === norm(corpusLine('ar-sans')), '')
    expect(r.message).toBe('Text deleted')
    const lines = await linesOf(r.bytes)
    expect(lines).not.toContain(norm(corpusLine('ar-sans')))
    expect(lines).toContain(norm(corpusLine('ar-hello')))
    expect(lines).toContain(norm(corpusLine('fa')))
  })

  it('an operation that also draws other text loses only the edited glyphs; the rest keeps its place', async () => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(readFileSync('resources/textfonts/NotoSansHebrew-Regular.ttf'), { subset: false })
    const page = pdf.addPage([500, 300])
    page.node.setFontDictionary(PDFName.of('FH'), font.ref)
    // one TJ draws two cells of a table row: "עולם" on the left, "שלום" 130 pt to the right (fontkit's layout already
    // returns right-to-left glyphs in visual order)
    const left = font.encodeText('עולם').toString()
    const right = font.encodeText('שלום').toString()
    page.pushOperators(PDFOperator.of(`BT /FH 14 Tf 1 0 0 1 250 200 Tm [${left} -9000 ${right}] TJ ET` as never))
    const src = await pdf.save()
    const before = await pageModel(src)
    const keep = before.lines.find((l) => before.text.slice(l.start, l.end) === 'עולם')!
    const set = await blocksOf(src)
    expect(set.lines.filter((b) => b.logical).map((b) => b.text).sort()).toEqual(['עולם', 'שלום'])
    const r = await edit(src, (b) => b.text === 'שלום', 'שלום רב')
    const after = await pageModel(r.bytes)
    const texts = after.lines.map((l) => after.text.slice(l.start, l.end))
    expect(texts).toContain('שלום רב')
    expect(texts).toContain('עולם')
    const kept = after.lines.find((l) => after.text.slice(l.start, l.end) === 'עולם')!
    expect(Math.abs(kept.x0 - keep.x0)).toBeLessThan(0.01)
    expect(Math.abs(kept.x1 - keep.x1)).toBeLessThan(0.01)
  })
})

describe('paragraphs', () => {
  const NEW =
    'هذه فقرة جديدة كتبت لتحل محل الفقرة القديمة، وهي أطول قليلا منها حتى نرى كيف يلتف النص داخل عرض الفقرة الأصلي، وفيها رقم 2026 وكلمة Epdf أيضا، ثم تنتهي هنا.'

  for (const file of ['lo-para.pdf', 'chromium-para.pdf', 'engine-para.pdf']) {
    it(`${file}: a rewritten paragraph re-wraps inside the old width, right-aligned, at the old line spacing`, async () => {
      const old = corpus.paragraphs.find((p) => p.id === 'ar-para')!.text
      const r = await edit(fixture(file), (b) => norm(b.text.replace(/\n/g, ' ')) === norm(old), NEW, { paragraph: true })
      const m = await pageModel(r.bytes)
      const para = r.before
      const right = Math.max(...para.logical!.lines.map((l) => l.right))
      const left = Math.min(...para.logical!.lines.map((l) => l.left))
      const top = para.logical!.lines[0].baseline
      // the new lines: those between the paragraph's first baseline and the Hebrew paragraph below it
      const he = corpus.paragraphs.find((p) => p.id === 'he-para')!.text
      const newLines = m.lines.filter((l) => /[\u0600-\u06ff]/.test(m.text.slice(l.start, l.end)))
      expect(norm(newLines.map((l) => m.text.slice(l.start, l.end)).join(' '))).toBe(norm(NEW))
      const toUser = (y: number): number => m.transform[5] - y // pages without /Rotate: y_user = height - y_display
      expect(Math.abs(toUser(newLines[0].baseline) - top)).toBeLessThan(0.5)
      const lead = para.leading
      for (let i = 0; i < newLines.length; i++) {
        const l = newLines[i]
        expect(Math.abs(l.x1 - right), `line ${i} right edge`).toBeLessThan(1)
        expect(l.x0, `line ${i} left edge`).toBeGreaterThan(left - 1)
        if (i) expect(Math.abs(l.baseline - newLines[i - 1].baseline - lead)).toBeLessThan(0.5)
      }
      expect(norm(m.text)).toContain(norm(he).slice(0, 20)) // the Hebrew paragraph is still there
      writeFileSync(join(OUT, file.replace('.pdf', '-paragraph.pdf')), r.bytes)
    })
  }

  it('two right-to-left columns: editing a paragraph of the right column leaves the left one alone', async () => {
    const r = await edit(fixture('engine-columns.pdf'), startsWith('العمود الأول'), 'العمود الأول تغير نصه بالكامل، وهذا هو النص الجديد في العمود الأيمن.', { paragraph: true })
    const text = norm((await pageModel(r.bytes)).text)
    expect(text).toContain(norm('العمود الأول تغير نصه'))
    expect(text).toContain(norm(corpus.columns.second.split(' ').slice(0, 5).join(' ')))
    expect(text).not.toContain(norm('يقرأ أولا لأنه على اليمين'))
  })
})

describe('fonts', () => {
  it('reuses the document’s own font when its embedded program can shape the new text (full font with GSUB)', async () => {
    const full = await presentationForms({ toUnicode: true, fontsDir: resolve('resources'), subset: false })
    const r = await edit(full, (b) => norm(b.text) === norm(corpusLine('ar-hello')), 'مرحبا بكم جميعا')
    expect(r.strategy).toBe('document-font')
    expect(r.message).toBe('Edited using the document’s own font')
    expect(await linesOf(r.bytes)).toContain(norm('مرحبا بكم جميعا'))
    writeFileSync(join(OUT, 'own-font.pdf'), r.bytes)
  })

  it('falls back to a bundled Noto font and says why when the embedded font is a subset without shaping tables', async () => {
    for (const file of ['lo-lines.pdf', 'chromium-lines.pdf', 'pdflib-presentation.pdf']) {
      const r = await edit(fixture(file), (b) => norm(b.text) === norm(corpusLine('ar-hello')), 'مرحبا بكم جميعا')
      expect(r.strategy).toBe('fallback-font')
      expect(r.family).toMatch(/^Noto (Naskh|Sans) Arabic$/)
      expect(r.message).toBe(`Font not available in this PDF — used ${r.family}`)
      expect(r.why).toMatch(/document’s font/)
    }
  })

  it('bundled fallback: Naskh for Naskh-like fonts, Noto Sans Arabic for sans fonts, the document’s Latin family for the rest', () => {
    const sans = { serif: false, mono: false }
    expect(fallbackStack('ABCDEF+Tahoma', sans).arabic).toBe('Noto Sans Arabic')
    expect(fallbackStack('SegoeUI-Bold', sans).arabic).toBe('Noto Sans Arabic')
    expect(fallbackStack('ArialMT', sans).arabic).toBe('Noto Naskh Arabic')
    expect(fallbackStack('TimesNewRomanPSMT', { serif: true, mono: false }).arabic).toBe('Noto Naskh Arabic')
    expect(fallbackStack('TraditionalArabic', sans).arabic).toBe('Noto Naskh Arabic')
    expect(fallbackStack('JameelNooriNastaleeq', sans).arabic).toBe('Noto Nastaliq Urdu')
    const s = fallbackStack('CAAAAA+ArialMT', sans, 'BAAAAA+TimesNewRomanPSMT')
    expect(s.script[0]).toBe('Arial')
    expect(s.other[0]).toBe('Times New Roman')
    expect(familyOfBaseFont('ABCDEF+NotoNaskhArabic-Regular')).toBe('Noto Naskh Arabic')
    expect(familyOfBaseFont('TimesNewRomanPS-BoldMT')).toBe('Times New Roman')
  })

  it('script pieces keep marks, joiners and tatweel with their letters', () => {
    expect(scriptPieces('رقم 12 (Epdf) مُحَمَّد‍ـ')).toEqual([
      { text: 'رقم', script: true },
      { text: ' 12 (Epdf) ', script: false },
      { text: 'مُحَمَّد‍ـ', script: true }
    ])
  })

  it('reads the embedding licence bits of a font program', () => {
    const noto = new Uint8Array(readFileSync('resources/textfonts/NotoNaskhArabic-Regular.ttf'))
    expect(sfntFsType(noto)).toBe(0)
    expect(sfntFsType(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('alignment of paragraphs', () => {
    const L = (left: number, right: number, dir: 'rtl' | 'ltr' = 'rtl') => ({ left, right, size: 12, dir })
    expect(paragraphAlign([L(100, 500), L(180, 500), L(300, 500)])).toBe('right')
    expect(paragraphAlign([L(100, 500), L(100, 500), L(300, 500)])).toBe('justify')
    expect(paragraphAlign([L(100, 500), L(200, 400), L(250, 350)])).toBe('center')
    expect(paragraphAlign([L(100, 480, 'ltr'), L(100, 500, 'ltr'), L(100, 420, 'ltr')])).toBe('left')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Live producers on this machine (skipped without them): headless Edge (Chromium/Skia with Windows fonts) and LibreOffice.

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const LIVE_LINES: { font: string; text: string; next: string; color?: string }[] = [
  { font: 'Segoe UI', text: 'مرحبا بالعالم، هذا سطر للتجربة', next: 'مرحبا بالعالم، هذا سطر معدل' },
  { font: 'Tahoma', text: 'رقم الفاتورة 2026/117 بتاريخ 28-09-2026', next: 'رقم الفاتورة 2026/118 بتاريخ 29-09-2026 (مدفوعة)' },
  { font: 'Arial', text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', next: 'بِسْمِ اللَّهِ' },
  { font: 'Times New Roman', text: 'لا إله إلا الله، والسلام عليكم', next: 'السلام عليكم ورحمة الله' },
  { font: 'Arial', text: 'نص ملون باللون الأحمر', next: 'نص ملون باللون الأحمر الداكن', color: '#b00020' },
  { font: 'Segoe UI', text: 'The file تقرير.pdf was sent on 2026-09-28.', next: 'The file تقرير-نهائي.pdf was sent on 2026-09-29.' }
]

function liveHtml(): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const ps = LIVE_LINES.map((l) => `<p dir="${/^[A-Za-z]/.test(l.text) ? 'ltr' : 'rtl'}" style="font-family:'${l.font}'; font-size:16pt;${l.color ? ` color:${l.color};` : ''} text-align:${/^[A-Za-z]/.test(l.text) ? 'left' : 'right'}">${esc(l.text)}</p>`)
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>t</title><style>body{margin:40px} p{margin:0 0 14pt 0}</style></head><body>${ps.join('\n')}</body></html>`
}

async function checkLive(bytes: Uint8Array, name: string): Promise<void> {
  const set = await blocksOf(bytes)
  for (const l of LIVE_LINES) {
    const b = set.lines.find((x) => x.logical && norm(x.text) === norm(l.text))
    expect(b, `${name}: ${l.text}`).toBeTruthy()
    expect(b!.editable, b!.reason).toBe(true)
  }
  let cur = bytes
  const before = await pageModel(bytes)
  for (const l of LIVE_LINES) {
    const r = await edit(cur, (b) => norm(b.text) === norm(l.text), l.next)
    cur = r.bytes
    const m = await pageModel(cur)
    const lines = m.text.split('\n').map(norm)
    expect(lines, `${name}: ${l.next}`).toContain(norm(l.next))
    expect(lines).not.toContain(norm(l.text))
    const bl = before.lines.find((x) => norm(before.text.slice(x.start, x.end)) === norm(l.text))!
    const al = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === norm(l.next))!
    if (bl.dir === 'rtl') expect(Math.abs(al.x1 - bl.x1), `${name} right edge of ${l.next}`).toBeLessThan(1)
    else expect(Math.abs(al.x0 - bl.x0)).toBeLessThan(1)
    expect(Math.abs(al.baseline - bl.baseline)).toBeLessThan(0.3)
  }
  const red = (await blocksOf(cur)).lines.find((b) => norm(b.text) === norm(LIVE_LINES[4].next))!
  expect(red.color.css).toBe('#b00020')
  writeFileSync(join(OUT, `${name}-edited.pdf`), cur)
}

describe('live producers (development machine only)', () => {
  it.skipIf(!existsSync(EDGE))('Microsoft Edge (headless print to PDF, Windows fonts): lines found, edited, read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-rtl-edge-'))
    try {
      writeFileSync(join(dir, 'in.html'), liveHtml())
      // (headless Edge occasionally stalls when the machine is busy with a full parallel test run: one retry)
      const print = (profile: string): void =>
        void execFileSync(EDGE, ['--headless=new', '--no-pdf-header-footer', `--user-data-dir=${join(dir, profile)}`, `--print-to-pdf=${join(dir, 'out.pdf')}`, pathToFileURL(join(dir, 'in.html')).href], { stdio: 'ignore', timeout: 120_000 })
      try {
        print('profile')
      } catch {
        print('profile2')
      }
      const bytes = new Uint8Array(readFileSync(join(dir, 'out.pdf')))
      writeFileSync(join(OUT, 'edge.pdf'), bytes)
      await checkLive(bytes, 'edge')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  }, 300_000)

  it.skipIf(!existsSync(SOFFICE))('LibreOffice Writer (HTML -> writer_pdf_Export): lines found, edited, read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-rtl-lo-'))
    try {
      writeFileSync(join(dir, 'in.html'), liveHtml())
      execFileSync(SOFFICE, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', join(dir, 'out'), join(dir, 'in.html')], { stdio: 'ignore', timeout: 180_000 })
      const bytes = new Uint8Array(readFileSync(join(dir, 'out', 'in.pdf')))
      writeFileSync(join(OUT, 'libreoffice.pdf'), bytes)
      await checkLive(bytes, 'libreoffice')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  }, 200_000)
})
