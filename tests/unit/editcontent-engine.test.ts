import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { applyTextEdit, type FontLoader } from '../../src/renderer/src/features/textedit/pdfcontent/textEdit'
import { norm, pageModel } from '../support/retrofit'
import { notoBytes, pdfLibDoc } from './helpers/pdfBuilder'

/**
 * Editing text: NEW text in Arabic, Hebrew or another script that needs shaping is drawn by the text engine (the
 * editor's model is unchanged; only the operators its replace strategy inserts come from the engine).
 */

const loader: FontLoader = { unicodeFont: async () => notoBytes('Regular') }

async function simple(text: string): Promise<Uint8Array> {
  return pdfLibDoc(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText(text, { x: 72, y: 700, size: 14, font })
    page.drawText('Untouched neighbour text', { x: 72, y: 640, size: 14, font })
  })
}

async function edit(bytes: Uint8Array, contains: string, newText: string) {
  const doc = await PDFDocument.load(bytes)
  const b = buildBlocks(analyzePage(doc, 0)).lines.find((l) => l.text.includes(contains))!
  const res = await applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText }, loader)
  return { ...res, bytes: await doc.save(), oldRight: Math.max(...b.lines.map((l) => l.x1)) }
}

describe('text editing: new right-to-left and complex-script text', () => {
  it('replacing a Latin line with Arabic: shaped, right edge kept, logical order when read back', async () => {
    const src = await simple('Hello world from Epdf')
    const text = 'مرحبا بالعالم من Epdf'
    const r = await edit(src, 'Hello', text)
    expect(r.strategy).toBe('fallback-font')
    expect(r.message).toMatch(/Noto (Sans|Naskh) Arabic/)
    const m = await pageModel(r.bytes)
    const lines = m.text.split('\n').map(norm)
    expect(lines).toContain(norm(text))
    expect(lines).toContain('Untouched neighbour text')
    const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === norm(text))!
    expect(l.dir).toBe('rtl')
    expect(Math.abs(l.x1 - r.oldRight)).toBeLessThan(3)
    mkdirSync(resolve('test-results/text-retrofit'), { recursive: true })
    writeFileSync(resolve('test-results/text-retrofit/textedit-arabic.pdf'), r.bytes)
  })

  it('inserting an Arabic word into a Latin line is never spliced into the Helvetica run', async () => {
    const src = await simple('Hello world from Epdf')
    const r = await edit(src, 'Hello', 'Hello عالم from Epdf')
    expect(r.strategy).not.toBe('in-place')
    expect(norm((await pageModel(r.bytes)).text)).toContain('Hello عالم from Epdf')
  })

  it('Hebrew and Devanagari replacements; Cyrillic keeps the Noto Sans path', async () => {
    const src = await simple('Hello world from Epdf')
    for (const t of ['שלום עולם 2026', 'नमस्ते दुनिया']) {
      const r = await edit(src, 'Hello', t)
      expect(norm((await pageModel(r.bytes)).text)).toContain(norm(t))
    }
    const cy = await edit(src, 'Hello', 'Привет мир')
    expect(cy.message).toBe('Font not available in this PDF — used Noto Sans')
  })
})
