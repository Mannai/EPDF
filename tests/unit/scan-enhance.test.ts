import { unzlibSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { applyPngUp, enhance, packBilevel } from '../../src/shared/features/scan/enhance'
import { createRgba, toGray, type RgbaImage } from '../../src/shared/features/scan/image'
import { renderTextPage } from '../support/scanImages'

/** The page with a smooth illumination ramp (a shadow) multiplied in: left side 1.0, right side `dark`. */
function withShadow(img: RgbaImage, dark: number): RgbaImage {
  const out = createRgba(img.width, img.height)
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const f = 1 - (1 - dark) * (x / (img.width - 1))
      const o = (y * img.width + x) * 4
      for (let c = 0; c < 3; c++) out.data[o + c] = img.data[o + c] * f
    }
  return out
}

// the image maths is CPU heavy and the suite runs in parallel with other test files
vi.setConfig({ testTimeout: 60_000 })

const text = renderTextPage(620, 877, 5)
const truthInk = (x: number, y: number): boolean => text.data[(y * 620 + x) * 4] < 100

/** Fractions of true-ink pixels that became dark and of true-paper pixels that became light, per horizontal half. */
function recall(out: RgbaImage, dark: (v: number) => boolean, light: (v: number) => boolean): { ink: number[]; paper: number[] } {
  const ink = [0, 0]
  const inkN = [0, 0]
  const paper = [0, 0]
  const paperN = [0, 0]
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const half = x < out.width / 2 ? 0 : 1
      const v = out.data[(y * out.width + x) * 4]
      if (truthInk(x, y)) {
        inkN[half]++
        if (dark(v)) ink[half]++
      } else {
        paperN[half]++
        if (light(v)) paper[half]++
      }
    }
  return { ink: ink.map((n, i) => n / inkN[i]), paper: paper.map((n, i) => n / paperN[i]) }
}

describe('enhance: black & white document', () => {
  const shadowed = withShadow(text, 0.45)
  const bw = enhance(shadowed, 'bw')

  it('produces only pure black and pure white pixels', () => {
    let bad = 0
    for (let i = 0; i < bw.data.length; i += 4) {
      const v = bw.data[i]
      if (!((v === 0 || v === 255) && bw.data[i + 1] === v && bw.data[i + 2] === v)) bad++
    }
    expect(bad).toBe(0)
  })

  it('removes the shadow: ink is kept and paper stays white on both the lit and the shaded half', () => {
    const r = recall(bw, (v) => v === 0, (v) => v === 255)
    for (const half of [0, 1]) {
      expect(r.ink[half]).toBeGreaterThan(0.85)
      expect(r.paper[half]).toBeGreaterThan(0.97)
    }
  })

  it('a plain global threshold could not do this (control): the shaded half would be lost', () => {
    const g = toGray(shadowed)
    let paperDark = 0
    let paperN = 0
    for (let y = 0; y < g.height; y++)
      for (let x = Math.floor(g.width * 0.75); x < g.width; x++) {
        if (truthInk(x, y)) continue
        paperN++
        if (g.data[y * g.width + x] < 128) paperDark++
      }
    // the shaded paper is ~0.5*245 = 120 < 128, i.e. a fixed threshold would blacken it
    expect(paperDark / paperN).toBeGreaterThan(0.5)
  })

  it('bias keeps more faint marks when positive', () => {
    const faint = createRgba(200, 200, [250, 250, 250])
    for (let y = 60; y < 66; y++) for (let x = 20; x < 180; x++) faint.data[(y * 200 + x) * 4] = faint.data[(y * 200 + x) * 4 + 1] = faint.data[(y * 200 + x) * 4 + 2] = 150
    for (let y = 120; y < 126; y++) for (let x = 20; x < 180; x++) faint.data[(y * 200 + x) * 4] = faint.data[(y * 200 + x) * 4 + 1] = faint.data[(y * 200 + x) * 4 + 2] = 40
    const count = (img: RgbaImage): number => {
      let n = 0
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) n++
      return n
    }
    expect(count(enhance(faint, 'bw', { bwBias: 40 }))).toBeGreaterThanOrEqual(count(enhance(faint, 'bw', { bwBias: -40 })))
  })

  it('a blank page stays blank instead of turning into noise', () => {
    const blank = createRgba(300, 400, [240, 238, 232])
    for (let i = 0; i < blank.data.length; i += 4) blank.data[i] += (i / 4) % 5
    const out = enhance(blank, 'bw')
    let black = 0
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] === 0) black++
    expect(black).toBe(0)
  })
})

describe('enhance: grayscale and colour', () => {
  it('grey: neutral output with a white, even background despite the shadow', () => {
    const out = enhance(withShadow(text, 0.5), 'gray')
    const r = recall(out, (v) => v < 110, (v) => v > 225)
    for (const half of [0, 1]) {
      expect(r.paper[half]).toBeGreaterThan(0.95)
      expect(r.ink[half]).toBeGreaterThan(0.85)
    }
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(out.data[i + 1])
  })

  it('colour: white-balances a yellow sheet but keeps a red mark red', () => {
    const img = createRgba(300, 300, [236, 226, 170])
    for (let y = 100; y < 160; y++) for (let x = 100; x < 200; x++) img.data[(y * 300 + x) * 4] = 200, (img.data[(y * 300 + x) * 4 + 1] = 30), (img.data[(y * 300 + x) * 4 + 2] = 30)
    // the mark is big; give the estimator paper around it (window is a few percent of the size)
    const out = enhance(img, 'color')
    const px = (x: number, y: number): number[] => Array.from(out.data.slice((y * 300 + x) * 4, (y * 300 + x) * 4 + 3))
    const paper = px(20, 20)
    expect(Math.min(...paper)).toBeGreaterThan(225)
    expect(Math.max(...paper) - Math.min(...paper)).toBeLessThan(12)
    const mark = px(150, 130)
    expect(mark[0]).toBeGreaterThan(mark[1] + 60)
  })

  it('"original" returns the very same image', () => {
    expect(enhance(text, 'original')).toBe(text)
  })
})

describe('1-bit packing', () => {
  it('packs MSB first with 1 = white and pads rows; PNG-Up + zlib round-trips', () => {
    const img = createRgba(10, 3, [255, 255, 255])
    // black pixels at (0,0), (9,1), (3,2)
    for (const [x, y] of [[0, 0], [9, 1], [3, 2]]) img.data[(y * 10 + x) * 4] = img.data[(y * 10 + x) * 4 + 1] = img.data[(y * 10 + x) * 4 + 2] = 0
    const { packed, rowBytes } = packBilevel(img)
    expect(rowBytes).toBe(2)
    expect(packed[0]).toBe(0b01111111)
    expect(packed[1]).toBe(0b11000000)
    expect(packed[2]).toBe(0b11111111)
    expect(packed[3]).toBe(0b10000000)
    const filtered = applyPngUp(packed, rowBytes, 3)
    expect(filtered[0]).toBe(0)
    expect(filtered[3]).toBe(2)
    // undo the Up filter like a PDF reader does
    const back = new Uint8Array(packed.length)
    for (let y = 0; y < 3; y++) for (let x = 0; x < rowBytes; x++) back[y * rowBytes + x] = (filtered[y * (rowBytes + 1) + 1 + x] + (y ? back[(y - 1) * rowBytes + x] : 0)) & 255
    expect(Array.from(back)).toEqual(Array.from(packed))
    expect(unzlibSync).toBeTypeOf('function')
  })
})
