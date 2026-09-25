/** PDF.js (legacy build, Node) helpers used to check that compressed files open in an independent reader. */

export interface PjsImage {
  width: number
  height: number
  /** RGBA (or RGB) pixels as PDF.js decoded them. */
  data: Uint8ClampedArray
  channels: 3 | 4
}

async function open(bytes: Uint8Array): Promise<{ doc: import('pdfjs-dist').PDFDocumentProxy; destroy(): Promise<void> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy() }
}

export async function pdfjsPageCount(bytes: Uint8Array): Promise<number> {
  const { doc, destroy } = await open(bytes)
  try {
    return doc.numPages
  } finally {
    await destroy()
  }
}

export async function pdfjsText(bytes: Uint8Array, pageNo = 1): Promise<string> {
  const { doc, destroy } = await open(bytes)
  try {
    const page = await doc.getPage(pageNo)
    const tc = await page.getTextContent()
    return (tc.items as { str?: string }[]).map((i) => i.str ?? '').join(' ').replace(/\s+/g, ' ').trim()
  } finally {
    await destroy()
  }
}

export async function pdfjsPageSize(bytes: Uint8Array, pageNo = 1): Promise<[number, number]> {
  const { doc, destroy } = await open(bytes)
  try {
    const page = await doc.getPage(pageNo)
    const v = page.getViewport({ scale: 1 })
    return [v.width, v.height]
  } finally {
    await destroy()
  }
}

/** Decodes every image painted on a page through PDF.js's own image pipeline (JPEG, Flate, masks, colour spaces). */
export async function pdfjsImages(bytes: Uint8Array, pageNo = 1): Promise<PjsImage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { doc, destroy } = await open(bytes)
  try {
    const page = await doc.getPage(pageNo)
    const ops = await page.getOperatorList()
    const out: PjsImage[] = []
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue
      const id = ops.argsArray[i][0] as string
      const img = await new Promise<{ width: number; height: number; data?: Uint8ClampedArray; kind?: number }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('image decode timed out')), 10000)
        const objs = id.startsWith('g_') ? page.commonObjs : page.objs
        objs.get(id, (o: unknown) => {
          clearTimeout(t)
          resolve(o as { width: number; height: number; data?: Uint8ClampedArray; kind?: number })
        })
      })
      if (img.data) {
        const channels = img.data.length === img.width * img.height * 3 ? 3 : 4
        out.push({ width: img.width, height: img.height, data: img.data, channels })
      }
    }
    return out
  } finally {
    await destroy()
  }
}
