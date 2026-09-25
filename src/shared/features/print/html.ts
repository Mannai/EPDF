import { MAX_PERCENT, MIN_PERCENT, type ScalingMode } from './options'

/**
 * The document handed to Chromium's print pipeline: one full-sheet block per page image, in order, repeated
 * (collated) for each copy. It contains no script and can only load the page images from the job's own host.
 */

export interface HtmlPage {
  /** The page's size in PDF points (rotation applied), i.e. its size at "actual size". */
  widthPt: number
  heightPt: number
}

export interface HtmlOptions {
  /** Origin the page images are served from, e.g. `epdf-app://print-3f2a`. */
  origin: string
  scaling: ScalingMode
  percent: number
  copies: number
  /** `file` = printing to a PDF with fixed margins of zero; `native` = margins come from the print dialog. */
  target: 'native' | 'file'
  /** The document title (the job name in the print dialog and spooler), already HTML-escaped. */
  title?: string
}

const num = (n: number): string => String(Math.round(n * 100) / 100)

/** The CSP of the print document: no scripts, no network, images only from the job origin. */
export const printCsp = (origin: string): string => `default-src 'none'; img-src ${origin}; style-src 'unsafe-inline'`

export function buildPrintHtml(pages: HtmlPage[], opts: HtmlOptions): string {
  const pct = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, opts.percent)) / 100
  const sheets: string[] = []
  const copies = Math.max(1, Math.floor(opts.copies))
  for (let c = 0; c < copies; c++) {
    pages.forEach((p, i) => {
      const src = `${opts.origin}/${i}.jpg`
      let img: string
      if (opts.scaling === 'fit') img = `<img class="fit" src="${src}" alt="">`
      else {
        const k = opts.scaling === 'actual' ? 1 : pct
        img = `<img class="abs" src="${src}" alt="" style="width:${num(p.widthPt * k)}pt;height:${num(p.heightPt * k)}pt">`
      }
      sheets.push(`<div class="sheet">${img}</div>`)
    })
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${printCsp(opts.origin)}">
<title>${opts.title ?? 'Epdf'}</title>
<style>
${opts.target === 'file' ? '@page { margin: 0 }\n' : ''}html, body { margin: 0; padding: 0; background: #fff; }
.sheet { width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; break-after: page; page-break-after: always; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
.fit { width: 100%; height: 100%; object-fit: contain; }
.abs { flex: none; }
</style></head><body>${sheets.join('')}</body></html>`
}
