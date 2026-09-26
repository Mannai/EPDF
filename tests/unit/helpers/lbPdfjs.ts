/** PDF.js (legacy build, Node) helpers used to check that links and bookmarks are honoured by an independent reader. */

type Pdfjs = typeof import('pdfjs-dist')

async function open(bytes: Uint8Array): Promise<{ doc: import('pdfjs-dist').PDFDocumentProxy; pdfjs: Pdfjs; destroy(): Promise<void> }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as Pdfjs
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  return { doc, pdfjs, destroy: () => task.destroy() }
}

export interface PjsOutlineItem {
  title: string
  bold: boolean
  italic: boolean
  color: number[] | null
  url: string | null
  /** 1-based page the destination resolves to, when it has one. */
  page: number | null
  destType: string | null
  items: PjsOutlineItem[]
}

/** The outline as PDF.js reports it, with destinations resolved to page numbers. */
export async function pdfjsOutline(bytes: Uint8Array): Promise<PjsOutlineItem[] | null> {
  const { doc, destroy } = await open(bytes)
  try {
    const raw = (await doc.getOutline()) as
      | { title: string; bold: boolean; italic: boolean; color: Uint8ClampedArray | number[] | null; url?: string | null; dest?: unknown; items: unknown[] }[]
      | null
    if (!raw) return null
    const conv = async (list: typeof raw): Promise<PjsOutlineItem[]> => {
      const out: PjsOutlineItem[] = []
      for (const it of list) {
        let page: number | null = null
        let destType: string | null = null
        try {
          const explicit = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest
          if (Array.isArray(explicit) && explicit.length) {
            const t = explicit[0]
            page = typeof t === 'number' ? t + 1 : (await doc.getPageIndex(t)) + 1
            destType = (explicit[1] as { name?: string } | undefined)?.name ?? null
          }
        } catch {
          page = null
        }
        out.push({
          title: it.title,
          bold: it.bold,
          italic: it.italic,
          color: it.color ? Array.from(it.color) : null,
          url: it.url ?? null,
          page,
          destType,
          items: await conv(it.items as typeof raw)
        })
      }
      return out
    }
    return await conv(raw)
  } finally {
    await destroy()
  }
}

export interface PjsLink {
  subtype: string
  rect: number[]
  url: string | null
  dest: unknown
  /** 1-based page of an internal destination. */
  page: number | null
  borderWidth: number | null
}

export async function pdfjsLinks(bytes: Uint8Array, pageNo: number): Promise<PjsLink[]> {
  const { doc, destroy } = await open(bytes)
  try {
    const page = await doc.getPage(pageNo)
    const annots = (await page.getAnnotations({ intent: 'display' })) as {
      subtype: string
      rect: number[]
      url?: string
      dest?: unknown
      borderStyle?: { width?: number }
    }[]
    const out: PjsLink[] = []
    for (const a of annots) {
      if (a.subtype !== 'Link') continue
      let target: number | null = null
      try {
        const explicit = typeof a.dest === 'string' ? await doc.getDestination(a.dest) : a.dest
        if (Array.isArray(explicit) && explicit.length) {
          const t = explicit[0]
          target = typeof t === 'number' ? t + 1 : (await doc.getPageIndex(t)) + 1
        }
      } catch {
        target = null
      }
      out.push({ subtype: a.subtype, rect: a.rect, url: a.url ?? null, dest: a.dest ?? null, page: target, borderWidth: a.borderStyle?.width ?? null })
    }
    return out
  } finally {
    await destroy()
  }
}

/** Text content items of a page, as PDF.js extracts them (for heading fixtures). */
export async function pdfjsPageText(bytes: Uint8Array, pageNo: number): Promise<string> {
  const { doc, destroy } = await open(bytes)
  try {
    const page = await doc.getPage(pageNo)
    const tc = await page.getTextContent()
    return (tc.items as { str?: string }[]).map((i) => i.str ?? '').join(' ')
  } finally {
    await destroy()
  }
}
