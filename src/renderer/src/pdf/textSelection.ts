/*
 * Steady text selection over PDF.js text layers.
 *
 * A text layer is absolutely positioned spans with gaps between them. When a drag passes over a gap, Chromium picks
 * the nearest selectable node, which can be far away (often the end of the page), so the selection jumps around
 * while dragging. PDF.js's own viewer avoids this with an "end of content" element that it moves next to the
 * selection's moving end during the drag (TextLayerBuilder in pdfjs-dist/web/pdf_viewer.mjs). Epdf builds its text
 * layers with the bare TextLayer API, so this is a port of that logic.
 *
 * Ported from PDF.js (https://github.com/mozilla/pdf.js), Copyright Mozilla Foundation, Apache License 2.0.
 * The `.endOfContent` / `.textLayer.selecting` styles come from pdfjs-dist/web/pdf_viewer.css, already loaded.
 */

const layers = new Map<HTMLElement, HTMLElement>()
let listeners: AbortController | null = null

/** Enables steady selection on a rendered text layer. Returns a function that undoes it (call before re-rendering). */
export function enableTextLayerSelection(textLayer: HTMLElement): () => void {
  const end = document.createElement('div')
  end.className = 'endOfContent'
  textLayer.append(end)
  const onDown = (): void => textLayer.classList.add('selecting')
  textLayer.addEventListener('mousedown', onDown)
  layers.set(textLayer, end)
  enableGlobalListeners()
  return () => {
    textLayer.removeEventListener('mousedown', onDown)
    textLayer.classList.remove('selecting')
    end.remove()
    layers.delete(textLayer)
    if (layers.size === 0) {
      listeners?.abort()
      listeners = null
    }
  }
}

function reset(end: HTMLElement, textLayer: HTMLElement): void {
  if (textLayer.isConnected) textLayer.append(end)
  end.style.width = ''
  end.style.height = ''
  textLayer.classList.remove('selecting')
}

function enableGlobalListeners(): void {
  if (listeners) return
  listeners = new AbortController()
  const { signal } = listeners
  let pointerDown = false
  document.addEventListener('pointerdown', () => (pointerDown = true), { signal })
  document.addEventListener(
    'pointerup',
    () => {
      pointerDown = false
      layers.forEach(reset)
    },
    { signal }
  )
  window.addEventListener(
    'blur',
    () => {
      pointerDown = false
      layers.forEach(reset)
    },
    { signal }
  )
  document.addEventListener('keyup', () => !pointerDown && layers.forEach(reset), { signal })

  let modernEngine: boolean | undefined
  let prevRange: Range | undefined
  document.addEventListener(
    'selectionchange',
    () => {
      const selection = document.getSelection()
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset)
        return
      }
      const active = new Set<HTMLElement>()
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i)
        for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer)
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add('selecting')
        else reset(end, layer)
      }
      // Chromium 148+ (and Firefox) keep the selection steady on their own; older engines need the moving end marker.
      if (modernEngine === undefined) {
        const m = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)
        modernEngine = !!m && parseInt(m[1]!, 10) >= 148
      }
      if (modernEngine) return

      const range = selection.getRangeAt(0)
      const modifyStart =
        !!prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0)
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
      if ((anchor as Element | null)?.classList?.contains('highlight')) anchor = anchor!.parentNode
      if (!modifyStart && range.endOffset === 0) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode
          anchor = anchor?.previousSibling ?? null
        } while (anchor && !anchor.childNodes.length)
      }
      const parentLayer = (anchor?.parentElement?.closest('.textLayer') ?? null) as HTMLElement | null
      const end = parentLayer ? layers.get(parentLayer) : undefined
      if (end && parentLayer && anchor?.parentElement) {
        end.style.width = parentLayer.style.width
        end.style.height = parentLayer.style.height
        end.style.userSelect = 'text'
        anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling)
      }
      prevRange = range.cloneRange()
    },
    { signal }
  )
}
