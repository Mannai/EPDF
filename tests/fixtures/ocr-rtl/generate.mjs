// Generates the right-to-left "scanned" fixtures (image-only PDFs) of tests/fixtures/ocr-rtl from corpus.json:
//   node tests/fixtures/ocr-rtl/generate.mjs [outDir]
// Each page is laid out as HTML (one <div> per line, the page's font and direction), printed to a picture by
// Microsoft Edge in headless mode (real Windows fonts and Chromium's Arabic shaping, like a document typed in any
// editor), then degraded like a scan: turned by a slight angle, softened, low contrast (grey paper, dark grey ink),
// sensor noise and specks, and saved as a JPEG inside an A5 PDF at 300 dpi.
//
// DEV ONLY: it needs Edge (msedge.exe). The generated PDFs are committed, so the tests never need Edge. The noise is
// seeded, so a rerun on the same machine gives the same pictures (fonts or Edge updates can change a few pixels).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import upngModule from '@pdf-lib/upng'
import jpeg from 'jpeg-js'

const UPNG = upngModule.default ?? upngModule
import { PDFDocument } from 'pdf-lib'

const HERE = resolve('tests/fixtures/ocr-rtl')
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))

export const DPI = 300
/** Standard deviation of the sensor noise (grey levels) and the JPEG quality: a scanner's grain, kept small enough that
 *  the committed files stay a few hundred KB. */
const NOISE = 6
const QUALITY = 60
// A5 in CSS pixels (96 per inch) and in points
const CSS_W = 559
const CSS_H = 794
const PT_W = 419.53
const PT_H = 595.28

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

function html(page) {
  const lines = page.lines.map((l) => `<div>${esc(l)}</div>`).join('\n')
  return `<!doctype html><html lang="${page.lang.slice(0, 2)}" dir="${page.dir}"><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
body{padding:56px 48px;font-family:'${page.font}';font-size:${page.size}px;line-height:1.9;color:#000}
div{white-space:nowrap}
</style></head><body>
${lines}
</body></html>`
}

// seeded PRNG (mulberry32) and a normal deviate
function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  return { next, normal }
}

/** RGBA screenshot -> degraded grey picture. */
export function degrade(rgba, w, h, angleDeg, seed, clean = false) {
  const noise = clean ? 0 : NOISE
  const specks = clean ? 0 : 400
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  // rotate around the centre (bilinear), white outside
  const a = (angleDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const rot = new Float32Array(w * h)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const sx = cx + dx * c + dy * s
      const sy = cy - dx * s + dy * c
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
        rot[y * w + x] = 255
        continue
      }
      const fx = sx - x0
      const fy = sy - y0
      const i = y0 * w + x0
      rot[y * w + x] = (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy
    }
  }
  // soften (3x3 weighted blur), low contrast, noise
  const r = rng(seed)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = rot[y * w + x] * 4
      let wsum = 4
      for (const [ox, oy, k] of [[-1, 0, 2], [1, 0, 2], [0, -1, 2], [0, 1, 2], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]]) {
        const xx = x + ox
        const yy = y + oy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        v += rot[yy * w + xx] * k
        wsum += k
      }
      v /= wsum
      v = 45 + (v * (228 - 45)) / 255 + r.normal() * noise
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
  // specks of dust
  for (let k = 0; k < specks; k++) {
    const x = Math.floor(r.next() * w)
    const y = Math.floor(r.next() * h)
    const rad = r.next() < 0.8 ? 1 : 2
    for (let yy = y - rad; yy <= y + rad; yy++) for (let xx = x - rad; xx <= x + rad; xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 70
  }
  return out
}

export function grayToJpeg(gray, w, h, quality = QUALITY) {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    rgba[p] = rgba[p + 1] = rgba[p + 2] = gray[i]
    rgba[p + 3] = 255
  }
  return jpeg.encode({ data: rgba, width: w, height: h }, quality).data
}

async function imagePdf(jpg) {
  const pdf = await PDFDocument.create()
  pdf.setProducer('Epdf test fixture (ocr-rtl)')
  pdf.setCreationDate(new Date('2026-09-28T00:00:00Z'))
  pdf.setModificationDate(new Date('2026-09-28T00:00:00Z'))
  const img = await pdf.embedJpg(jpg)
  const page = pdf.addPage([PT_W, PT_H])
  page.drawImage(img, { x: 0, y: 0, width: PT_W, height: PT_H })
  return pdf.save()
}

/** `clean`: no sensor noise and no specks (still turned, softened and low contrast), for comparisons; not committed. */
export async function generate(outDir = HERE, { clean = false } = {}) {
  if (!EDGE) throw new Error('Microsoft Edge (msedge.exe) is needed to regenerate these fixtures')
  const corpus = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'))
  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'epdf-ocr-rtl-'))
  try {
    let seed = 1
    for (const page of corpus.pages) {
      const htmlFile = join(tmp, `${page.name}.html`)
      const png = join(tmp, `${page.name}.png`)
      writeFileSync(htmlFile, html(page))
      execFileSync(EDGE, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        `--user-data-dir=${join(tmp, 'profile')}`,
        `--force-device-scale-factor=${DPI / 96}`,
        `--window-size=${CSS_W},${CSS_H}`,
        `--screenshot=${png}`,
        pathToFileURL(htmlFile).href
      ])
      const img = UPNG.decode(readFileSync(png))
      const rgba = new Uint8Array(UPNG.toRGBA8(img)[0])
      const gray = degrade(rgba, img.width, img.height, page.angle, seed++, clean)
      const pdf = await imagePdf(grayToJpeg(gray, img.width, img.height))
      writeFileSync(join(outDir, `${page.name}.pdf`), pdf)
      console.log(`${page.name}.pdf ${img.width}x${img.height} px, ${Math.round(pdf.length / 1024)} KB`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

//   node tests/fixtures/ocr-rtl/generate.mjs <outDir> --clean   writes the noise-free variants
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  await generate(dir ? resolve(dir) : HERE, { clean: args.includes('--clean') })
}
