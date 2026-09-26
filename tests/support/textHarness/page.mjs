// Page side of the text rendering harness: renders a PDF with PDF.js (canvas) and the same text with Chromium's own
// text engine (DOM). Called from the Playwright test through page.evaluate(window.__harness.*).
const root = new URLSearchParams(location.search).get('root')
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '')
const pdfjs = await import(fileUrl(root + '/node_modules/pdfjs-dist/build/pdf.mjs'))
pdfjs.GlobalWorkerOptions.workerSrc = fileUrl(root + '/node_modules/pdfjs-dist/build/pdf.worker.mjs')

const loadedFonts = new Set()

async function ensureFonts(fonts) {
  // fonts: [{ name, url }]
  for (const f of fonts) {
    if (loadedFonts.has(f.name)) continue
    const face = new FontFace(f.name, `url("${f.url}")`)
    await face.load()
    document.fonts.add(face)
    loadedFonts.add(f.name)
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Render page 1 of a PDF (base64) at CSS scale (96/72) into the #pdf canvas; returns RGBA pixels (base64) and size. */
async function renderPdf(b64, scale = 96 / 72) {
  const task = pdfjs.getDocument({ data: b64ToBytes(b64), verbosity: 0 })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale })
  const canvas = document.getElementById('pdf')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let bin = ''
  const data = img.data
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000))
  await task.destroy()
  return { width: canvas.width, height: canvas.height, rgba: btoa(bin) }
}

/**
 * Lay out the given lines with Chromium's text engine in #stage and return the element's client rect.
 * spec: { fonts:[{name,url}], families:[name...], sizePt, lang, lines:[{text, dir, height}], boxWidth }
 */
async function renderHtml(spec) {
  await ensureFonts(spec.fonts)
  await document.fonts.ready
  const stage = document.getElementById('stage')
  stage.textContent = ''
  stage.style.left = '20px'
  stage.style.top = '20px'
  stage.style.width = spec.boxWidth * (96 / 72) + 'px'
  for (const line of spec.lines) {
    const d = document.createElement('div')
    d.className = 'line'
    d.dir = line.dir
    if (spec.lang) d.lang = spec.lang
    d.style.fontFamily = spec.families.map((n) => `"${n}"`).join(', ')
    d.style.fontSize = (spec.sizePt * 96) / 72 + 'px'
    d.style.lineHeight = (line.height * 96) / 72 + 'px'
    d.style.height = (line.height * 96) / 72 + 'px'
    d.style.textAlign = line.align || 'start'
    d.textContent = line.text
    stage.appendChild(d)
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const r = stage.getBoundingClientRect()
  return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }
}

window.__harness = { renderPdf, renderHtml, ready: true, pdfjsVersion: pdfjs.version }
