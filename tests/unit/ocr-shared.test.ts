import { describe, expect, it } from 'vitest'
import {
  AddPageRequestSchema,
  BeginRequestSchema,
  DEFAULT_PREFS,
  DownloadJobSchema,
  findLanguage,
  findPack,
  formatBytes,
  MAX_LANGUAGES_PER_RUN,
  OCR_LANGUAGES,
  OSD_PACK,
  packData,
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
    expect(AddPageRequestSchema.safeParse({ sessionId: 'abcdefgh', index: 0, image: { length: 3 } }).success).toBe(false)
    expect(AddPageRequestSchema.safeParse({ sessionId: 'short', index: 0, image: new Uint8Array(3) }).success).toBe(false)
    expect(AddPageRequestSchema.safeParse({ sessionId: 'abcdefgh', index: -1, image: new Uint8Array(3) }).success).toBe(false)
  })

  it('right-to-left languages: Arabic, Persian, Urdu and Hebrew, marked rtl, with the hashes of the real files', () => {
    // verified against the files downloaded from the pinned commit (2026-09-28): size and SHA-256
    const want: Record<string, [number, string]> = {
      ara: [1432056, 'e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729'],
      fas: [431500, 'db1c0a91208aff00d3cf1ed2c1d23f76419afd5f024688b4f71adc3f2ce4a505'],
      urd: [1398718, '62e8250ce2a994106e313a82e26a516a39e2cf159d0ce3c5b5008387fd0d555f'],
      heb: [961404, '11f9e43ab227f786352a50f75c94c2e9906f1baba86d93276da19da7ce0904db']
    }
    for (const [code, [size, sha]] of Object.entries(want)) {
      expect(findLanguage(code), code).toMatchObject({ size, sha256: sha, rtl: true, bundled: false })
    }
    expect(OCR_LANGUAGES.filter((l) => l.rtl).map((l) => l.code).sort()).toEqual(['ara', 'fas', 'heb', 'urd'])
  })

  it('the orientation data is a downloadable pack, never a recognition language', () => {
    expect(OSD_PACK).toMatchObject({ code: 'osd', size: 10562727, sha256: '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff', bundled: false })
    expect(findLanguage('osd')).toBeUndefined()
    expect(findPack('osd')).toBe(OSD_PACK)
    expect(findPack('ara')?.name).toBe('Arabic')
    expect(DownloadJobSchema.safeParse({ language: 'osd' }).success).toBe(true)
    expect(BeginRequestSchema.safeParse({ languages: ['osd'], total: 1 }).success).toBe(false)
    expect(BeginRequestSchema.safeParse({ languages: ['eng'], total: 1, orient: true, mayRetry: true }).success).toBe(true)
    expect(packData(OSD_PACK)).toBe('page orientation data')
    expect(packData(findLanguage('heb')!)).toBe('Hebrew language data')
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
      force: true,
      orient: false
    })
    expect(sanitizePrefs({ dpi: 200 }).dpi).toBe(200)
    // orientation detection is off unless the user turned it on (older saved preferences have no such field)
    expect(sanitizePrefs({ orient: true }).orient).toBe(true)
    expect(sanitizePrefs({ orient: 'yes' }).orient).toBe(false)
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
