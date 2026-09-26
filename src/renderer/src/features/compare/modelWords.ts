import { rangeBoxes, type PageTextModel } from '@shared/pagetext'
import { clusters, foldChar, keyOf, tokenSpans } from './diff/normalize'
import type { CompareOptions, PageModel } from './diff/types'
import { toPageModel, type Word } from './diff/words'

/**
 * Words of a page read with the page text model (right-to-left and complex-script pages): the model's lines are
 * already in reading order and logical order, so they are tokenised as they are (the geometric line building of
 * `diff/words.ts` would put right-to-left words back into visual order). Boxes are the glyph boxes of each word.
 */
export function modelPageWords(model: PageTextModel, opts: CompareOptions): PageModel {
  const words: Word[] = []
  model.lines.forEach((line, li) => {
    const text = model.text.slice(line.start, line.end)
    let folded = ''
    const from: number[] = []
    const to: number[] = []
    let off = line.start
    for (const ch of clusters(text)) {
      const f = foldChar(ch)
      if (!(f === ' ' && (folded === '' || folded.endsWith(' ')))) {
        for (let k = 0; k < f.length; k++) {
          folded += f[k]
          from.push(off)
          to.push(off + ch.length)
        }
      }
      off += ch.length
    }
    for (const sp of tokenSpans(folded)) {
      const token = folded.slice(sp.start, sp.end)
      const key = keyOf(token, opts)
      if (key === null) continue
      const boxes = rangeBoxes(model, from[sp.start], to[sp.end - 1])
      if (!boxes.length) continue
      const x0 = Math.min(...boxes.map((b) => b.x0))
      const y0 = Math.min(...boxes.map((b) => b.y0))
      const x1 = Math.max(...boxes.map((b) => b.x1))
      const y1 = Math.max(...boxes.map((b) => b.y1))
      words.push({ text: token, key, boxes: [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }], line: li, block: line.block })
    }
  })
  return toPageModel(words, model.width, model.height)
}
