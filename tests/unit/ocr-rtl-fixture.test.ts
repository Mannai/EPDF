import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasTessdata, realEngine, recognizeLikeApp, RTL_FIXTURES, wordRecall, RTL_CORPUS } from './helpers/ocrReal'

/**
 * DEV ONLY, skipped unless EPDF_OCR_MAKE_FIXTURES=1 (and EPDF_OCR_TESSDATA, and Microsoft Edge): regenerates
 * tests/fixtures/ocr-rtl/ocr-ara-letter.pdf, the Arabic letter printed WITHOUT noise (generate.mjs --clean) with the
 * text layer that real recognition (ara, tessdata_fast) gives it through the app's steps. The e2e suite opens it to
 * check the viewer, search, selection and copy on a real recognized Arabic layer without needing the language data.
 *   $env:EPDF_OCR_MAKE_FIXTURES = '1'; $env:EPDF_OCR_TESSDATA = "$env:LOCALAPPDATA\epdf-tessdata"
 *   npx vitest run tests/unit/ocr-rtl-fixture.test.ts
 */
describe('recognized Arabic fixture for the e2e suite', () => {
  it.skipIf(process.env['EPDF_OCR_MAKE_FIXTURES'] !== '1' || !hasTessdata(['ara']))(
    'writes ocr-ara-letter.pdf',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'epdf-ocr-clean-'))
      const prev = process.env['EPDF_OCR_RTL_DIR']
      try {
        execFileSync(process.execPath, ['tests/fixtures/ocr-rtl/generate.mjs', dir, '--clean'], { stdio: 'ignore' })
        process.env['EPDF_OCR_RTL_DIR'] = dir
        const { engine, dispose } = await realEngine(['ara'])
        try {
          const r = await recognizeLikeApp(engine, 'scan-ara-letter')
          const page = RTL_CORPUS.pages.find((p) => p.name === 'scan-ara-letter')!
          expect(wordRecall(page.lines.join('\n'), r.model.text)).toBeGreaterThanOrEqual(0.9)
          writeFileSync(join(RTL_FIXTURES, 'ocr-ara-letter.pdf'), r.pdf)
          writeFileSync(join(RTL_FIXTURES, 'ocr-ara-letter.txt'), r.model.text + '\n')
        } finally {
          await dispose()
        }
      } finally {
        if (prev === undefined) delete process.env['EPDF_OCR_RTL_DIR']
        else process.env['EPDF_OCR_RTL_DIR'] = prev
        rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000
  )
})
