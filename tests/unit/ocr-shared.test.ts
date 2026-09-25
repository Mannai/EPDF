import { describe, expect, it } from 'vitest'
import {
  AddPageRequestSchema,
  BeginRequestSchema,
  DEFAULT_PREFS,
  DownloadJobSchema,
  findLanguage,
  formatBytes,
  MAX_LANGUAGES_PER_RUN,
  OCR_LANGUAGES,
  sanitizeLanguages,
  sanitizePrefs,
  selectPages,
  TESSDATA_BASE_URL
} from '../../src/shared/features/ocr'

describe('language catalogue', () => {
  it('offers the required languages, English first and bundled, everything else downloadable', () => {
    const codes = OCR_LANGUAGES.map((l) => l.code)
    for (const c of ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'rus', 'ara', 'chi_sim', 'jpn', 'kor', 'hin']) expect(codes).toContain(c)
    expect(OCR_LANGUAGES[0].code).toBe('eng')
    expect(OCR_LANGUAGES.filter((l) => l.bundled).map((l) => l.code)).toEqual(['eng'])
  })

  it('pins a SHA-256 and a size for every language, with unique codes', () => {
    expect(new Set(OCR_LANGUAGES.map((l) => l.code)).size).toBe(OCR_LANGUAGES.length)
    for (const l of OCR_LANGUAGES) {
      expect(l.sha256, l.code).toMatch(/^[0-9a-f]{64}$/)
      expect(l.size, l.code).toBeGreaterThan(100_000)
      expect(l.name.length).toBeGreaterThan(0)
    }
  })

  it('downloads only from the official tessdata_fast repository over HTTPS, pinned to a commit', () => {
    expect(TESSDATA_BASE_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/[0-9a-f]{40}\/$/)
  })

  it('findLanguage and the payload schemas reject anything outside the catalogue', () => {
    expect(findLanguage('deu')?.name).toBe('German')
    expect(findLanguage('../../etc/passwd')).toBeUndefined()
    expect(DownloadJobSchema.safeParse({ language: 'deu' }).success).toBe(true)
    expect(DownloadJobSchema.safeParse({ language: 'xx' }).success).toBe(false)
    expect(DownloadJobSchema.safeParse({ language: 'https://evil.example/x' }).success).toBe(false)
    expect(BeginRequestSchema.safeParse({ languages: ['eng', 'deu'], total: 3 }).success).toBe(true)
    expect(BeginRequestSchema.safeParse({ languages: [], total: 3 }).success).toBe(false)
    expect(BeginRequestSchema.safeParse({ languages: ['eng', 'deu', 'fra', 'spa', 'ita'], total: 3 }).success).toBe(false)
    expect(BeginRequestSchema.safeParse({ languages: ['eng'], total: 0 }).success).toBe(false)
    expect(AddPageRequestSchema.safeParse({ sessionId: 'abcdefgh', index: 0, image: new Uint8Array(3) }).success).toBe(true)
    expect(AddPageRequestSchema.safeParse({ sessionId: 'abcdefgh', index: 0, image: 'not bytes' }).success).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1525436)).toBe('1.5 MB')
  })
})

describe('preferences', () => {
  it('sanitizes stored languages: unknown codes and repeats dropped, capped, English when empty', () => {
    expect(sanitizeLanguages(['deu', 'deu', 'zzz', 5, 'fra'])).toEqual(['deu', 'fra'])
    expect(sanitizeLanguages([])).toEqual(['eng'])
    expect(sanitizeLanguages('deu')).toEqual(['eng'])
    expect(sanitizeLanguages(OCR_LANGUAGES.map((l) => l.code))).toHaveLength(MAX_LANGUAGES_PER_RUN)
  })

  it('falls back to defaults for anything malformed', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs({ dpi: 123, contrast: 'yes', deskew: false, force: true, languages: ['deu'] })).toEqual({
      languages: ['deu'],
      dpi: 300,
      contrast: true,
      deskew: false,
      force: true
    })
    expect(sanitizePrefs({ dpi: 200 }).dpi).toBe(200)
  })
})

describe('page selection', () => {
  it('all pages', () => {
    expect(selectPages({ mode: 'all' }, 4)).toEqual({ ok: true, pages: [0, 1, 2, 3] })
  })

  it('current page (1-based in, 0-based out) and its bounds', () => {
    expect(selectPages({ mode: 'current', page: 3 }, 5)).toEqual({ ok: true, pages: [2] })
    expect(selectPages({ mode: 'current', page: 6 }, 5)).toMatchObject({ ok: false })
    expect(selectPages({ mode: 'current', page: 0 }, 5)).toMatchObject({ ok: false })
  })

  it('ranges: lists, open ends, repeats and order', () => {
    expect(selectPages({ mode: 'range', text: '1-3, 7, 9-' }, 10)).toEqual({ ok: true, pages: [0, 1, 2, 6, 8, 9] })
    expect(selectPages({ mode: 'range', text: '5, 2-3, 3' }, 6)).toEqual({ ok: true, pages: [1, 2, 4] })
    expect(selectPages({ mode: 'range', text: '-2' }, 6)).toEqual({ ok: true, pages: [0, 1] })
  })

  it('reports readable errors for bad ranges and empty documents', () => {
    const bad = selectPages({ mode: 'range', text: '9' }, 5)
    expect(bad).toMatchObject({ ok: false })
    expect(bad.ok ? '' : bad.error).toMatch(/out of range/)
    expect(selectPages({ mode: 'range', text: 'abc' }, 5)).toMatchObject({ ok: false })
    expect(selectPages({ mode: 'range', text: '' }, 5)).toMatchObject({ ok: false })
    expect(selectPages({ mode: 'range', text: '3-1' }, 5)).toMatchObject({ ok: false })
    expect(selectPages({ mode: 'all' }, 0)).toMatchObject({ ok: false })
  })
})
