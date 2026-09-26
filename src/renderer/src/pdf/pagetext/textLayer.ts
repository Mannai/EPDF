import type { PageTextModel } from '@shared/pagetext'

/**
 * A selectable text layer built from the page text model, for pages PDF.js would garble (right-to-left and complex
 * scripts). It uses PDF.js's own text layer CSS (pdf_viewer.css: transparent text, `--font-height`, `--scale-x`,
 * `--rotate`, positions in % of the page), so it scales with the zoom exactly like PDF.js's layer.
 *
 * The DOM holds the text in LOGICAL order (reading order, one span per word or space, a <br> after each line), so a
 * selection, Copy and the browser's find all see the logical text; every span is positioned on the glyphs it stands
 * for (the union of their boxes, stretched to their width), so selection highlights cover the right glyphs.
 */

let measureCtx: CanvasRenderingContext2D | null = null
const FONT_FAMILY = 'sans-serif'
const MEASURE_SIZE = 100

function measure(text: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = `${MEASURE_SIZE}px ${FONT_FAMILY}`
  return measureCtx.measureText(text).width / MEASURE_SIZE
}

let segmenter: Intl.Segmenter | null | undefined
function segments(text: string): { index: number; segment: string }[] {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    } catch {
      segmenter = null
    }
  }
  if (segmenter) return [...segmenter.segment(text)].map((s) => ({ index: s.index, segment: s.segment }))
  const out: { index: number; segment: string }[] = []
  for (const m of text.matchAll(/\s+|\S+/gu)) out.push({ index: m.index!, segment: m[0] })
  return out
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u
const LTR = /\p{L}/u
function dirOf(s: string, fallback: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  for (const ch of s) {
    if (RTL.test(ch)) return 'rtl'
    if (LTR.test(ch)) return 'ltr'
  }
  return fallback
}

export interface ModelLayer {
  /** Number of spans created (diagnostics). */
  spans: number
}

/** Fills `container` (a `.textLayer` div already sized with PDF.js's setLayerDimensions) from `model`. */
export function renderModelTextLayer(container: HTMLElement, model: PageTextModel): ModelLayer {
  container.replaceChildren()
  container.dataset.pagetext = 'model'
  const frag = document.createDocumentFragment()
  const W = model.width || 1
  const H = model.height || 1
  let count = 0
  for (const line of model.lines) {
    const rad = (line.angle * Math.PI) / 180
    const ex = Math.cos(rad)
    const ey = Math.sin(rad)
    const nx = -ey
    const ny = ex
    const lineText = model.text.slice(line.start, line.end)
    for (const seg of segments(lineText)) {
      const a = line.start + seg.index
      const b = a + seg.segment.length
      let s0 = Infinity
      let s1 = -Infinity
      let t0 = Infinity
      let t1 = -Infinity
      for (let i = a; i < b; i++) {
        const q = model.charQuad[i]
        if (q < 0) continue
        for (let k = 0; k < 8; k += 2) {
          const x = model.quads[q * 8 + k]
          const y = model.quads[q * 8 + k + 1]
          const s = x * ex + y * ey
          const t = x * nx + y * ny
          if (s < s0) s0 = s
          if (s > s1) s1 = s
          if (t < t0) t0 = t
          if (t > t1) t1 = t
        }
      }
      if (!(s1 >= s0) || !(t1 > t0)) continue
      const height = t1 - t0
      const width = s1 - s0
      // top-left corner of the box in the line frame -> display space
      const x = s0 * ex + t0 * nx
      const y = s0 * ey + t0 * ny
      const span = document.createElement('span')
      span.textContent = seg.segment
      span.dir = dirOf(seg.segment, line.dir)
      span.style.left = `${((100 * x) / W).toFixed(4)}%`
      span.style.top = `${((100 * y) / H).toFixed(4)}%`
      span.style.fontFamily = FONT_FAMILY
      span.style.setProperty('--font-height', `${height.toFixed(3)}px`)
      const natural = measure(seg.segment) * height
      if (natural > 0 && width > 0) span.style.setProperty('--scale-x', (width / natural).toFixed(5))
      if (line.angle) span.style.setProperty('--rotate', `${line.angle}deg`)
      frag.append(span)
      count++
    }
    const br = document.createElement('br')
    br.setAttribute('role', 'presentation')
    frag.append(br)
  }
  const end = document.createElement('div')
  end.className = 'endOfContent'
  frag.append(end)
  container.append(frag)
  // Like PDF.js: while selecting, the end-of-content element covers the layer so the selection does not jump.
  const down = (): void => container.classList.add('selecting')
  const up = (): void => container.classList.remove('selecting')
  container.addEventListener('mousedown', down)
  document.addEventListener('mouseup', up, { once: false })
  ;(container as HTMLElement & { __ptCleanup?: () => void }).__ptCleanup = () => {
    container.removeEventListener('mousedown', down)
    document.removeEventListener('mouseup', up)
  }
  return { spans: count }
}

/** Removes the listeners a model layer installed. */
export function disposeModelTextLayer(container: HTMLElement | null): void {
  const c = container as (HTMLElement & { __ptCleanup?: () => void }) | null
  c?.__ptCleanup?.()
  if (c) {
    delete c.__ptCleanup
    delete c.dataset.pagetext
  }
}
