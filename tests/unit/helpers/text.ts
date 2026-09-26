import { beforeAll } from 'vitest'
import { loadBundledFont, type TextFont } from '../../../src/shared/text/fonts'
import { useNodeResources } from '../../../src/shared/text/node'
import { loadHarfBuzz } from '../../../src/shared/text/hb'

/** Call once at the top of a text test file: configures resource loading and warms HarfBuzz. */
export function setupText(): void {
  beforeAll(async () => {
    useNodeResources()
    await loadHarfBuzz()
  })
}

export const font = (file: string): Promise<TextFont> => loadBundledFont(file)

/** Text of page `n` of a PDF as PDF.js (legacy build, Node) extracts it: items joined, EOL as newline. */
export async function pdfjsLines(bytes: Uint8Array, n = 1): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const page = await doc.getPage(n)
    const tc = await page.getTextContent()
    let out = ''
    for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) out += (it.str ?? '') + (it.hasEOL ? '\n' : '')
    return out.split('\n')
  } finally {
    await task.destroy()
  }
}
