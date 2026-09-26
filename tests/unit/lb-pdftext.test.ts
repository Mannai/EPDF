import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { asciiLiteral, decodePdfText, encodePdfText, pdfTextString, readPdfText, replaceLoneSurrogates, sanitizeTitle } from '../../src/shared/features/pdftext'

const SAMPLES: Record<string, string> = {
  english: 'Chapter 1: Introduction',
  latin1: 'Café – naïve “quoted” € 5 ™',
  arabic: 'الفصل الأول: المقدمة',
  arabicTashkeel: 'اَلْفَصْلُ الْأَوَّلُ',
  hebrew: 'פרק ראשון',
  hebrewNiqqud: 'שָׁלוֹם עוֹלָם',
  chinese: '第一章 概述',
  japanese: 'はじめに ＆ 概要',
  emoji: 'Launch 🚀 plan 👩‍👩‍👧‍👦',
  combining: `e${String.fromCharCode(0x301)} a${String.fromCharCode(0x308)} n${String.fromCharCode(0x303)} (decomposed)`,
  mixedBidi: 'Section ٣: الأمن (Security) 2024',
  mixedBidi2: 'תוכן – Contents – 목차',
  parens: 'f(x) = (a \\ b) )(',
  bidiControls: `${String.fromCharCode(0x202b)}עברית${String.fromCharCode(0x202c)} and ${String.fromCharCode(0x2067)}عربى${String.fromCharCode(0x2069)}`
}

describe('PDF text strings', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`round trips ${name} through bytes and through a saved file`, async () => {
      const { bytes } = encodePdfText(text)
      expect(decodePdfText(bytes)).toBe(text)

      // Through a real document: write a hex string, save, re-load, read the /Title back.
      const doc = await PDFDocument.create()
      doc.catalog.set(PDFName.of('Probe'), doc.context.register(doc.context.obj({ Title: pdfTextString(text) })))
      const again = await PDFDocument.load(await doc.save())
      const probe = again.catalog.lookup(PDFName.of('Probe'), PDFDict)
      expect(readPdfText(probe.lookup(PDFName.of('Title')))).toBe(text)
    })
  }

  it('uses PDFDocEncoding for text it can represent, and UTF-16BE with a BOM otherwise', () => {
    expect(encodePdfText('Chapter 1').encoding).toBe('pdfdoc')
    expect([...encodePdfText('Chapter 1').bytes]).toEqual([...Buffer.from('Chapter 1', 'latin1')])
    const latin = encodePdfText('Café – “x” €')
    expect(latin.encoding).toBe('pdfdoc')
    // é = 0xE9, en dash = 0x85, curly quotes 0x8D/0x8E, euro = 0xA0
    expect([...latin.bytes]).toEqual([0x43, 0x61, 0x66, 0xe9, 0x20, 0x85, 0x20, 0x8d, 0x78, 0x8e, 0x20, 0xa0])
    const ar = encodePdfText('مرحبا')
    expect(ar.encoding).toBe('utf16be')
    expect([ar.bytes[0], ar.bytes[1]]).toEqual([0xfe, 0xff])
    expect(ar.bytes.length).toBe(2 + 5 * 2)
    // Characters outside PDFDocEncoding (even though Latin-1) force UTF-16.
    expect(encodePdfText('a­b').encoding).toBe('utf16be')
    expect(encodePdfText('ł').encoding).toBe('pdfdoc') // Polish l with stroke IS in PDFDocEncoding (0x9B)
    expect(encodePdfText('ő').encoding).toBe('utf16be')
  })

  it('writes emoji as surrogate pairs', () => {
    const { bytes } = encodePdfText('🚀')
    expect([...bytes]).toEqual([0xfe, 0xff, 0xd8, 0x3d, 0xde, 0x80])
  })

  it('reads UTF-16LE, UTF-8 with a BOM, and strips PDF 1.7 language escapes', () => {
    expect(decodePdfText(Uint8Array.from([0xff, 0xfe, 0x45, 0x06, 0x41, 0x00]))).toBe('مA') // little-endian: U+0645 U+0041
    expect(decodePdfText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe('AB')
    expect(decodePdfText(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('日本語', 'utf8')]))).toBe('日本語')
    // FE FF, ESC "en" ESC, "Hi"
    expect(decodePdfText(Uint8Array.from([0xfe, 0xff, 0x00, 0x1b, 0x00, 0x65, 0x00, 0x6e, 0x00, 0x1b, 0x00, 0x48, 0x00, 0x69]))).toBe('Hi')
    // Undefined PDFDocEncoding bytes become U+FFFD rather than throwing.
    expect(decodePdfText(Uint8Array.from([0x41, 0x7f, 0x42]))).toBe('A�B')
  })

  it('reads literal and hex strings alike, including escapes', () => {
    expect(readPdfText(PDFString.of('a\\(b\\)\\\\c\\101'))).toBe('a(b)\\cA')
    expect(readPdfText(PDFHexString.of('FEFF0645'))).toBe('م')
    expect(readPdfText(undefined)).toBeUndefined()
  })

  it('handles lone surrogates: replaced, never written raw', () => {
    expect(replaceLoneSurrogates('a\uD83Db')).toBe('a�b')
    expect(replaceLoneSurrogates('a\uDE80b')).toBe('a�b')
    expect(replaceLoneSurrogates('ok 🚀')).toBe('ok 🚀')
    const { bytes } = encodePdfText('x\uD83Dy')
    expect(decodePdfText(bytes)).toBe('x�y')
    // Decoding damaged UTF-16 also cannot produce lone surrogates.
    expect(decodePdfText(Uint8Array.from([0xfe, 0xff, 0xd8, 0x3d, 0x00, 0x41]))).toBe('�A')
  })

  it('sanitizes titles: single line, no control characters, bounded length, bidi marks kept', () => {
    expect(sanitizeTitle('a\r\nb\tc')).toBe('a b c')
    expect(sanitizeTitle('a\u0000b\u0007c\u009Fd')).toBe('abcd')
    expect(sanitizeTitle(SAMPLES.bidiControls)).toBe(SAMPLES.bidiControls)
    expect(sanitizeTitle('x'.repeat(5000)).length).toBe(1000)
    const cut = sanitizeTitle('a' + '🚀'.repeat(600), 4)
    expect(cut).toBe('a🚀') // never splits a surrogate pair
  })

  it('escapes ASCII literals', () => {
    const s = asciiLiteral('http://x.test/a(b)\\c')
    expect(s.asString()).toBe('http://x.test/a\\(b\\)\\\\c')
    expect(readPdfText(s)).toBe('http://x.test/a(b)\\c')
  })
})
