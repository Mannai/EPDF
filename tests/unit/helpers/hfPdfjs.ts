/**
 * Reads PDFs back with PDF.js (legacy build, Node) for the page-marks tests: text items in VIEWPORT space (what the
 * reader sees: rotation and crop box applied, origin top-left, y down, 1 unit = 1 pt), and optional content visibility.
 */

export interface SeenText {
  str: string
  /** Baseline start in viewport space. */
  x: number
  y: number
  /** Advance width in points. */
  width: number
  /** Unit direction of the text in viewport space ((1, 0) = upright, left to right). */
  dir: [number, number]
  size: number
}

export interface SeenPage {
  width: number
  height: number
  items: SeenText[]
  /** Text in stream order, items joined. */
  text: string
}

type Pdfjs = typeof import('pdfjs-dist')
let lib: Promise<Pdfjs> | null = null
const pdfjs = (): Promise<Pdfjs> => (lib ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<Pdfjs>)

export async function seePages(bytes: Uint8Array): Promise<SeenPage[]> {
  const lib = await pdfjs()
  const task = lib.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  const out: SeenPage[] = []
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      const items: SeenText[] = []
      let text = ''
      for (const it of tc.items as { str?: string; transform?: number[]; width?: number; hasEOL?: boolean }[]) {
        if (!it.transform || it.str === undefined) continue
        text += it.str + (it.hasEOL ? '\n' : '')
        if (!it.str.trim()) continue
        const m = lib.Util.transform(vp.transform, it.transform) as number[]
        const len = Math.hypot(m[0]!, m[1]!)
        items.push({ str: it.str, x: m[4]!, y: m[5]!, width: it.width ?? 0, dir: [m[0]! / len, m[1]! / len], size: len })
      }
      out.push({ width: vp.width, height: vp.height, items, text })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return out
}

/** Name and visibility of every optional content group, as PDF.js decides it for the display or the print intent. */
export async function ocVisibility(bytes: Uint8Array, intent: 'display' | 'print'): Promise<{ name: string; visible: boolean }[]> {
  const lib = await pdfjs()
  const task = lib.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const cfg = await doc.getOptionalContentConfig({ intent })
    const out: { name: string; visible: boolean }[] = []
    for (const [id, group] of cfg) {
      out.push({ name: String(group.name), visible: cfg.isVisible({ type: 'OCG', id } as never) })
    }
    return out
  } finally {
    await task.destroy()
  }
}
