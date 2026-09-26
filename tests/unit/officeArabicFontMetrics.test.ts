import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadBundledFont, loadFontFromBytes, type TextFont } from '../../src/shared/text/fonts'
import { shapeText } from '../../src/shared/text/shape'
import { setupText } from './helpers/text'

/**
 * Developer measurement (opt-in: EPDF_MEASURE_FONTS=1, Windows with the fonts installed): how the Microsoft fonts that
 * Arabic Office documents name compare with the bundled Noto Arabic fonts Epdf draws them with. Prints, per font, the
 * advance width of a fixed Arabic sample (em), the ink height of its letters and the font's own line metrics. The
 * numbers are documented in docs/features/office-rtl.md and drive the size/line-height tables in office/fonts.ts.
 * Nothing here ships: the Microsoft fonts are only read on the developer's machine.
 */

setupText()

// Several paragraphs of ordinary Modern Standard Arabic (administrative, news and business vocabulary), so that the width
// ratio is not dominated by a few letters: single words differ by up to 10 % between the fonts.
const SAMPLE = [
  'بسم الله الرحمن الرحيم. هذا نص عربي لقياس عرض الخطوط وارتفاعها في المستندات، مع أرقام ١٢٣ و 456 وكلمات مثل المملكة والبحرين والمنامة.',
  'أعلنت وزارة المالية اليوم عن إطلاق برنامج جديد لدعم المشاريع الصغيرة والمتوسطة، ويهدف البرنامج إلى تسهيل حصول الشركات على التمويل اللازم لتوسيع أعمالها وخلق فرص عمل جديدة للمواطنين.',
  'يسرنا أن نرفق لكم تقرير الأداء السنوي للشركة، والذي يتضمن ملخصا للنتائج المالية وأهم الإنجازات التي تحققت خلال العام الماضي، إضافة إلى الخطط المستقبلية والتحديات المتوقعة.',
  'تعتبر اللغة العربية من أكثر اللغات انتشارا في العالم، إذ يتحدث بها أكثر من أربعمائة مليون نسمة، وهي لغة رسمية في جميع الدول العربية وإحدى اللغات الرسمية الست في الأمم المتحدة.',
  'يرجى تعبئة النموذج المرفق وإعادته قبل نهاية الشهر الحالي، مع إرفاق نسخة من البطاقة الشخصية وشهادة الخبرة، وسيتم التواصل معكم لتحديد موعد المقابلة الشخصية.',
  'مرحبا بالعالم. هذا مستند تجريبي لاختبار تحويل النصوص العربية إلى ملفات، ويهدف المشروع إلى تطوير برنامج متكامل لتحرير المستندات وتحويلها مع دعم كامل لاتجاه الكتابة من اليمين إلى اليسار.'
].join(' ')
const WIN = 'C:\\Windows\\Fonts\\'
const MS_FONTS: [string, string][] = [
  ['Arial', 'arial.ttf'],
  ['Arial Bold', 'arialbd.ttf'],
  ['Times New Roman', 'times.ttf'],
  ['Times New Roman Bold', 'timesbd.ttf'],
  ['Tahoma', 'tahoma.ttf'],
  ['Segoe UI', 'segoeui.ttf'],
  ['Simplified Arabic', 'simpo.ttf'],
  ['Traditional Arabic', 'trado.ttf'],
  ['Arabic Typesetting', 'arabtype.ttf'],
  ['Sakkal Majalla', 'majalla.ttf'],
  ['Dubai', 'DUBAI-REGULAR.TTF'],
  ['Calibri', 'calibri.ttf']
]
const NOTO: [string, string][] = [
  ['Noto Naskh Arabic', 'NotoNaskhArabic-Regular.ttf'],
  ['Noto Naskh Arabic Bold', 'NotoNaskhArabic-Bold.ttf'],
  ['Noto Sans Arabic', 'NotoSansArabic-Regular.ttf'],
  ['Noto Sans Arabic Bold', 'NotoSansArabic-Bold.ttf']
]

interface Measure {
  name: string
  covers: boolean
  width: number
  ink: number
  inkTop: number
  inkBottom: number
  ascent: number
  descent: number
  gap: number
  winAscent: number
  winDescent: number
}

function measure(name: string, f: TextFont): Measure {
  const covers = [...SAMPLE].filter((c) => /[\u0600-\u06ff]/.test(c)).every((c) => f.hasGlyph(c.codePointAt(0)!))
  let width = 0
  let top = 0
  let bottom = 0
  let inkSum = 0
  let inkN = 0
  for (const word of SAMPLE.split(' ')) {
    const r = shapeText({ font: f, rtl: true, script: 'Arab', lang: 'ar' }, word)
    for (let i = 0; i < r.length; i++) {
      width += r.ax[i]!
      const e = f.hbFont.glyphExtents(r.gid[i]!)
      if (e && e.height !== 0 && r.ax[i]! > 0) {
        top = Math.max(top, e.yBearing)
        bottom = Math.min(bottom, e.yBearing + e.height)
        inkSum += -e.height
        inkN++
      }
    }
    width += f.advanceOf(f.glyphFor(0x20))
  }
  const os2 = f.hbFace.referenceTable('OS/2')
  const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!
  const u = f.upem
  return {
    name,
    covers,
    width: width / u,
    ink: inkN ? inkSum / inkN / u : 0,
    inkTop: top / u,
    inkBottom: -bottom / u,
    ascent: f.ascent / u,
    descent: f.descent / u,
    gap: f.lineGap / u,
    winAscent: os2 ? u16(os2, 74) / u : 0,
    winDescent: os2 ? u16(os2, 76) / u : 0
  }
}

describe.skipIf(!process.env['EPDF_MEASURE_FONTS'])('Arabic Office fonts vs bundled Noto Arabic (measurement)', () => {
  it('prints the comparison table', async () => {
    const rows: Measure[] = []
    for (const [name, file] of NOTO) rows.push(measure(name, await loadBundledFont(file)))
    for (const [name, file] of MS_FONTS) {
      if (!existsSync(WIN + file)) {
        console.log(`[fonts] ${name}: not installed on this machine (${file})`)
        continue
      }
      rows.push(measure(name, await loadFontFromBytes(new Uint8Array(readFileSync(WIN + file)), { name })))
    }
    const naskh = rows[0]!.width
    const sans = rows[2]!.width
    console.log('[fonts] font | covers sample | sample width em | vs Naskh | vs Sans Arabic | mean letter ink | ink top | ink bottom | hhea asc/desc/gap | win asc/desc')
    for (const r of rows) {
      console.log(
        `[fonts] ${r.name} | ${r.covers} | ${r.width.toFixed(2)} | ${(r.width / naskh).toFixed(3)} | ${(r.width / sans).toFixed(3)} | ${r.ink.toFixed(3)} | ${r.inkTop.toFixed(3)} | ${r.inkBottom.toFixed(3)} | ${r.ascent.toFixed(3)}/${r.descent.toFixed(3)}/${r.gap.toFixed(3)} | ${r.winAscent.toFixed(3)}/${r.winDescent.toFixed(3)}`
      )
    }
    expect(rows.length).toBeGreaterThan(3)
  }, 60_000)
})

it('the font measurement is opt-in', () => {
  expect(typeof SAMPLE).toBe('string')
})
