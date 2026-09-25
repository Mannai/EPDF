// Generates deterministic "scanned" PDFs (a page that is only a picture of text) for the OCR tests:
//   node tests/fixtures/ocr.mjs <outDir>
// The text is rasterized in plain JavaScript from the bundled Noto Sans outlines (no canvas, no OS fonts), so the
// pictures are identical on every machine and can be produced in Node, Vitest or a Playwright spec alike.
import fontkit from '@pdf-lib/fontkit'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib'

const FONT_FILE = resolve('resources/fonts/NotoSans-Regular.ttf')
let fontCache = null
const loadFont = () => (fontCache ??= fontkit.create(readFileSync(FONT_FILE)))

/** Lines drawn on the letter-size fixtures. `EXPECTED` is what an OCR run should find (one entry per page). */
export const PAGE_TEXT = JSON.parse(readFileSync(new URL('./ocr-text.json', import.meta.url), 'utf8'))

const flattenPath = (commands, scale, tx, ty, sin, cos) => {
  // -> array of closed polygons in pixel space (y down); the glyph outline is y-up, so flip it.
  const polys = []
  let cur = null
  let px = 0
  let py = 0
  const map = (x, y) => {
    const gx = x * scale
    const gy = -y * scale
    return [tx + gx * cos - gy * sin, ty + gx * sin + gy * cos]
  }
  const push = (x, y) => cur.push(map(x, y))
  for (const { command, args } of commands) {
    if (command === 'moveTo') {
      if (cur && cur.length > 2) polys.push(cur)
      cur = []
      ;[px, py] = args
      push(px, py)
    } else if (command === 'lineTo') {
      ;[px, py] = args
      push(px, py)
    } else if (command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = args
      for (let i = 1; i <= 8; i++) {
        const t = i / 8
        const u = 1 - t
        push(u * u * px + 2 * u * t * cx + t * t * x, u * u * py + 2 * u * t * cy + t * t * y)
      }
      ;[px, py] = [x, y]
    } else if (command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = args
      for (let i = 1; i <= 10; i++) {
        const t = i / 10
        const u = 1 - t
        push(
          u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y
        )
      }
      ;[px, py] = [x, y]
    } else if (command === 'closePath') {
      if (cur && cur.length > 2) polys.push(cur)
      cur = null
    }
  }
  if (cur && cur.length > 2) polys.push(cur)
  return polys
}

/** Fills polygons (non-zero winding) into `cov` with 4x vertical supersampling and exact horizontal coverage. */
function fillPolys(polys, cov, W, H) {
  let minY = Infinity
  let maxY = -Infinity
  for (const p of polys) for (const [, y] of p) (minY = Math.min(minY, y)), (maxY = Math.max(maxY, y))
  const SUB = 4
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(H - 1, Math.ceil(maxY))
  for (let y = y0; y <= y1; y++) {
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB
      const xs = []
      for (const p of polys) {
        for (let i = 0; i < p.length; i++) {
          const [ax, ay] = p[i]
          const [bx, by] = p[(i + 1) % p.length]
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
            xs.push([ax + ((sy - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1])
          }
        }
      }
      xs.sort((a, b) => a[0] - b[0])
      let wind = 0
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1]
        if (wind === 0) continue
        let a = xs[i][0]
        let b = xs[i + 1][0]
        a = Math.max(0, a)
        b = Math.min(W, b)
        if (b <= a) continue
        const xa = Math.floor(a)
        const xb = Math.min(W - 1, Math.floor(b))
        for (let x = xa; x <= xb; x++) {
          const cover = Math.min(b, x + 1) - Math.max(a, x)
          if (cover > 0) cov[y * W + x] += cover / SUB
        }
      }
    }
  }
}

/**
 * Draws lines of text as black-on-white 8-bit grayscale. Each line is `{ text, x, y, size }` in pixels
 * (`y` = baseline). `angle` (degrees, clockwise) tilts the whole page around its centre like a crooked scan.
 */
export function rasterizeText(lines, W, H, { angle = 0, noise = 0 } = {}) {
  const font = loadFont()
  const cov = new Float32Array(W * H)
  const rad = (angle * Math.PI) / 180
  const sin = Math.sin(rad)
  const cos = Math.cos(rad)
  for (const line of lines) {
    const scale = line.size / font.unitsPerEm
    const run = font.layout(line.text)
    let pen = 0
    run.glyphs.forEach((g, i) => {
      const gx = line.x + (pen + run.positions[i].xOffset) * scale
      const gy = line.y - run.positions[i].yOffset * scale
      pen += run.positions[i].xAdvance
      if (!g.path.commands.length) return
      // Rotate the glyph's anchor around the page centre, then rotate the outline itself.
      const dx = gx - W / 2
      const dy = gy - H / 2
      const tx = W / 2 + dx * cos - dy * sin
      const ty = H / 2 + dx * sin + dy * cos
      fillPolys(flattenPath(g.path.commands, scale, tx, ty, sin, cos), cov, W, H)
    })
  }
  const out = new Uint8Array(W * H)
  let seed = 12345
  for (let i = 0; i < out.length; i++) {
    let v = 255 - Math.round(255 * Math.min(1, cov[i]))
    if (noise) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      v = Math.max(0, Math.min(255, v + Math.round(((seed / 0x7fffffff) - 0.5) * noise)))
    }
    out[i] = v
  }
  return out
}

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Encodes 8-bit grayscale pixels as a PNG. */
export function encodeGrayPng(gray, W, H) {
  const raw = Buffer.alloc((W + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0
    Buffer.from(gray.buffer, gray.byteOffset + y * W, W).copy(raw, y * (W + 1) + 1)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export const DPI = 200
const px = (pt) => Math.round((pt * DPI) / 72)

/** Text lines laid out on a `wPt` x `hPt` page at `DPI`, 14pt text with generous leading, starting near the top. */
export function pageLines(texts, wPt, { sizePt = 15, topPt = 110, leadPt = 34, leftPt = 72 } = {}) {
  void wPt
  return texts.map((text, i) => ({ text, x: px(leftPt), y: px(topPt + i * leadPt), size: px(sizePt) }))
}

/** PNG bytes of one scanned page of `wPt` x `hPt` points. */
export function scanPng(texts, wPt = 612, hPt = 792, opts = {}) {
  const W = px(wPt)
  const H = px(hPt)
  return encodeGrayPng(rasterizeText(pageLines(texts, wPt, opts), W, H, opts), W, H)
}

const addScanPage = async (doc, texts, { rotate = 0, crop = null, tilt = 0, size = [612, 792], origin = [0, 0] } = {}) => {
  const [wPt, hPt] = size
  // A landscape-displayed page (Rotate 90/270) still has a portrait MediaBox: the picture is drawn sideways in
  // user space so that, once the viewer rotates the page, the text reads upright.
  const displayW = rotate % 180 === 0 ? wPt : hPt
  const displayH = rotate % 180 === 0 ? hPt : wPt
  const png = await doc.embedPng(scanPng(texts, displayW, displayH, { angle: tilt }))
  const page = doc.addPage(size)
  if (origin[0] || origin[1]) {
    page.setMediaBox(origin[0], origin[1], wPt, hPt)
  }
  const [ox, oy] = origin
  if (rotate === 0) page.drawImage(png, { x: ox, y: oy, width: wPt, height: hPt })
  else if (rotate === 90) page.drawImage(png, { x: ox + wPt, y: oy, width: hPt, height: wPt, rotate: degrees(90) })
  else if (rotate === 180) page.drawImage(png, { x: ox + wPt, y: oy + hPt, width: wPt, height: hPt, rotate: degrees(180) })
  else page.drawImage(png, { x: ox, y: oy + hPt, width: hPt, height: wPt, rotate: degrees(270) })
  if (rotate) page.setRotation(degrees(rotate))
  if (crop) page.setCropBox(...crop)
  return page
}

const save = (doc) => doc.save()

/** One scanned page. */
export async function createScan1() {
  const doc = await PDFDocument.create()
  await addScanPage(doc, PAGE_TEXT[0])
  return save(doc)
}

/** Three scanned pages (progress, multi-page). */
export async function createScan3() {
  const doc = await PDFDocument.create()
  for (const t of PAGE_TEXT) await addScanPage(doc, t)
  return save(doc)
}

/** A scan whose page is marked /Rotate. `rotate` is 90, 180 or 270. */
export async function createScanRotated(rotate = 90) {
  const doc = await PDFDocument.create()
  await addScanPage(doc, PAGE_TEXT[0], { rotate })
  return save(doc)
}

/** A scan with an offset MediaBox and a smaller CropBox, so page space does not start at (0,0). */
export async function createScanCropped() {
  const doc = await PDFDocument.create()
  await addScanPage(doc, PAGE_TEXT[0], { origin: [40, 60] })
  const page = doc.getPage(0)
  // The picture spans the media box; the visible area is a window on it (the text stays inside).
  page.setCropBox(40 + 20, 60 + 30, 612 - 20, 792 - 30 - 30)
  return save(doc)
}

/** A page with real (vector) text followed by a scanned page. */
export async function createScanMixed() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  p.drawText('This page already contains genuine searchable text', { x: 72, y: 700, size: 16, font })
  await addScanPage(doc, PAGE_TEXT[1])
  return save(doc)
}

/** A scan that is slightly crooked (clockwise, degrees). */
export async function createScanSkewed(tilt = 3) {
  const doc = await PDFDocument.create()
  await addScanPage(doc, PAGE_TEXT[0], { tilt })
  return save(doc)
}

/** Writes every fixture above into `outDir` and returns the file names. */
export async function createAll(outDir) {
  mkdirSync(outDir, { recursive: true })
  const files = {
    'scan1.pdf': await createScan1(),
    'scan3.pdf': await createScan3(),
    'scan-rot90.pdf': await createScanRotated(90),
    'scan-rot270.pdf': await createScanRotated(270),
    'scan-crop.pdf': await createScanCropped(),
    'scan-mixed.pdf': await createScanMixed(),
    'scan-skew.pdf': await createScanSkewed(3)
  }
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(outDir, name), bytes)
  return Object.keys(files)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = resolve(process.argv[2] ?? 'test-results/fixtures')
  const names = await createAll(out)
  console.log('OCR fixtures written to', out, names.join(', '))
}

// Keep PDFName referenced for callers that patch page dictionaries.
export { PDFName }
