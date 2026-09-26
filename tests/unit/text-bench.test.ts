import { describe, expect, it } from 'vitest'
import { layoutParagraph } from '../../src/shared/text/layout'
import { clearShapingCache, shapingCacheStats } from '../../src/shared/text/shape'
import { setupText } from './helpers/text'

/**
 * Performance benchmarks with regression thresholds. Times are wall-clock on a developer machine that may be busy with
 * other work, so the thresholds are generous multiples of the measured times (documented in docs/text-engine.md).
 */
setupText()

const AR = 'كتاب مدرسة جامعة مدينة طالب معلم قلم ورقة بيت شمس قمر نهر جبل بحر سماء أرض ماء نار هواء صباح مساء ليل نهار سفر عمل بيت ولد بنت أب أم أخ أخت صديق'.split(' ')
const EN = 'the quick brown fox jumps over lazy dog and runs through green forest under bright blue sky while birds sing songs about home and friends in summer time'.split(' ')
const HE = 'שלום עולם ספר בית ילד מורה בית ספר יום לילה מים אש אוויר'.split(' ')
const TH = ['สวัสดีชาวโลก', 'ภาษาไทยสวยงาม', 'ขอบคุณมากครับ', 'ยินดีต้อนรับ', 'วันนี้อากาศดี']
const ZH = ['你好世界', '这是一个测试', '中文文本排版', '自动换行处理', '欢迎使用']
const HI = ['नमस्ते', 'दुनिया', 'हिन्दी', 'क्षत्रिय', 'भारत', 'विद्यालय']
const NUM = ['123', '4.5', '٢٠٢٤', '۱۲۳', '(2024)', '50%']

function paragraphs(count: number, seed: number): string[] {
  let s = seed
  const rnd = (n: number): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return Math.floor((s / 0x100000000) * n)
  }
  const pick = <T>(a: T[]): T => a[rnd(a.length)]!
  const out: string[] = []
  for (let p = 0; p < count; p++) {
    const kind = p % 6
    const words: string[] = []
    const n = 20 + rnd(20)
    for (let i = 0; i < n; i++) {
      if (kind === 0) words.push(pick(AR))
      else if (kind === 1) words.push(rnd(8) === 0 ? pick(NUM) : pick(EN))
      else if (kind === 2) words.push(rnd(4) === 0 ? pick(EN) : pick(AR), ...(rnd(6) === 0 ? [pick(NUM)] : []))
      else if (kind === 3) words.push(pick(HE))
      else if (kind === 4) words.push(rnd(3) === 0 ? pick(TH) : rnd(2) === 0 ? pick(ZH) : pick(HI))
      else words.push(rnd(3) === 0 ? pick(AR) : pick(EN))
    }
    out.push(words.join(kind === 4 ? '' : ' '))
  }
  return out
}

async function run(paras: string[]): Promise<{ ms: number; lines: number }> {
  const t0 = performance.now()
  let lines = 0
  for (const p of paras) lines += (await layoutParagraph(p, { size: 12, width: 300 })).lines.length
  return { ms: performance.now() - t0, lines }
}

describe('performance: shaping + layout of 1,000 mixed-script paragraphs', () => {
  it('meets the timing thresholds after warm-up', async () => {
    const a = paragraphs(1000, 1)
    const cold = await run(a) // loads fonts, fills caches
    const b = paragraphs(1000, 2) // different paragraphs from the same vocabulary
    const warm = await run(b)
    clearShapingCache()
    const noCache = await run(b) // fonts loaded, shaping cache empty
    const again = await run(b)
    const st = shapingCacheStats()
    console.log(
      `bench: cold ${cold.ms.toFixed(0)} ms (fonts + shaping), warm ${warm.ms.toFixed(0)} ms, empty shaping cache ${noCache.ms.toFixed(0)} ms, fully cached ${again.ms.toFixed(0)} ms; ${warm.lines} lines; cache ${st.size} entries`
    )
    expect(warm.lines).toBeGreaterThan(1500)
    // "well under a second" for 1,000 paragraphs once warmed up
    expect(warm.ms).toBeLessThan(1000)
    expect(again.ms).toBeLessThan(700)
    // without any shaping cache (worst case, fonts loaded) it must stay in the same ballpark, not degrade to seconds
    expect(noCache.ms).toBeLessThan(2500)
    // and the very first pass, which also loads a dozen fonts (CJK, Indic, Thai, Arabic, Hebrew), stays usable
    expect(cold.ms).toBeLessThan(6000)
  }, 60_000)

  it('itemization and line breaking scale linearly with text length', async () => {
    const word = 'مرحبا hello '
    const t = async (n: number): Promise<number> => {
      const text = word.repeat(n)
      await layoutParagraph(text, { size: 12, width: 300 })
      const t0 = performance.now()
      for (let i = 0; i < 3; i++) await layoutParagraph(text, { size: 12, width: 300 })
      return (performance.now() - t0) / 3
    }
    const small = await t(500)
    const big = await t(4000)
    console.log(`bench: 500 word pairs ${small.toFixed(1)} ms, 4000 word pairs ${big.toFixed(1)} ms`)
    expect(big).toBeLessThan(small * 8 * 3 + 50) // 8x the text in well under quadratic time
  })
})
