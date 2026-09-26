/**
 * The text corpus shared by the unit tests, the PDF.js extraction checks and the Chromium comparison harness.
 * `expected` is what a reader extracting the page text must get back (logical order).
 */
export interface CorpusItem {
  id: string
  label: string
  text: string
  size?: number
  lang?: string
  direction?: 'ltr' | 'rtl' | 'auto'
  /** Preferred font families (bundled family names); fallbacks are appended automatically. */
  fonts?: string[]
  /** Wrap width in points (multi-line items). */
  width?: number
  align?: 'start' | 'end' | 'center' | 'justify'
  /** Chromium cannot produce this layout (kashida justification): only sanity-checked, not compared. */
  noReference?: boolean
  /** PDF.js is known to insert stray spaces/text items for these (see docs/text-engine.md "PDF.js quirks"). */
  pdfjsQuirk?: 'combining-marks'
}

const arLong =
  'اللغة العربية هي أكثر اللغات السامية تحدثا، وإحدى أكثر اللغات انتشارا في العالم، ويتحدثها أكثر من أربعمائة مليون نسمة. تكتب من اليمين إلى اليسار وتتصل حروفها ببعضها، وتتغير أشكال الحروف بحسب موقعها من الكلمة.'

export const CORPUS: CorpusItem[] = [
  { id: 'ar-plain', label: 'Arabic (Naskh)', text: 'مرحبا بالعالم، هذا نص عربي للاختبار', fonts: ['Noto Naskh Arabic'] },
  { id: 'ar-sans', label: 'Arabic (Sans)', text: 'مرحبا بالعالم، هذا نص عربي للاختبار', fonts: ['Noto Sans Arabic'] },
  { id: 'ar-lamalef', label: 'Arabic lam-alef', text: 'الله لا إله إلا هو الرحمن الرحيم', fonts: ['Noto Naskh Arabic'] },
  { id: 'ar-tashkeel', label: 'Arabic with tashkeel', text: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', fonts: ['Noto Naskh Arabic'], size: 28, pdfjsQuirk: 'combining-marks' },
  { id: 'ar-tashkeel-sans', label: 'Arabic tashkeel (Sans)', text: 'مُحَمَّدٌ رَسُولُ اللَّهِ', fonts: ['Noto Sans Arabic'], size: 28, pdfjsQuirk: 'combining-marks' },
  { id: 'ar-wrap-300', label: 'Arabic paragraph, width 300', text: arLong, fonts: ['Noto Naskh Arabic'], width: 300, size: 16 },
  { id: 'ar-wrap-220', label: 'Arabic paragraph, width 220', text: arLong, fonts: ['Noto Naskh Arabic'], width: 220, size: 16 },
  { id: 'ar-wrap-150', label: 'Arabic paragraph, width 150', text: arLong, fonts: ['Noto Sans Arabic'], width: 150, size: 14 },
  { id: 'ar-justify', label: 'Arabic justified with kashida', text: arLong, fonts: ['Noto Naskh Arabic'], width: 260, size: 16, align: 'justify', noReference: true },
  { id: 'ar-justify-sans', label: 'Arabic justified with kashida (Sans)', text: arLong, fonts: ['Noto Sans Arabic'], width: 260, size: 16, align: 'justify', noReference: true },
  { id: 'en-justify', label: 'English justified', text: 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly and the sphinx of black quartz judges my vow.', fonts: ['Noto Sans'], width: 240, size: 14, align: 'justify', noReference: true },
  { id: 'fa', label: 'Persian', text: 'سلام دنیا، این یک متن فارسی است ۱۲۳ گچپژ', fonts: ['Noto Naskh Arabic'], lang: 'fa' },
  { id: 'ur', label: 'Urdu (Naskh)', text: 'یہ ایک اردو جملہ ہے۔ ٹھیک ہے، شکریہ', fonts: ['Noto Naskh Arabic'], lang: 'ur' },
  { id: 'ur-nastaliq', label: 'Urdu (Nastaliq)', text: 'یہ ایک اردو جملہ ہے', fonts: ['Noto Nastaliq Urdu'], lang: 'ur', size: 28 },
  { id: 'he', label: 'Hebrew', text: 'שלום עולם, זהו טקסט בעברית', fonts: ['Noto Sans Hebrew'] },
  { id: 'he-niqqud', label: 'Hebrew with niqqud', text: 'בְּרֵאשִׁית בָּרָא אֱלֹהִים', fonts: ['Noto Sans Hebrew'], size: 28 },
  { id: 'mixed-rtl', label: 'Arabic with English, numbers, punctuation', text: 'سعر المنتج 250 ريال (شامل الضريبة) حوالي 12.5% من ABC-123', fonts: ['Noto Naskh Arabic', 'Noto Sans'], direction: 'rtl' },
  { id: 'mixed-ltr', label: 'English with Arabic', text: 'The price is 250 ريال and the code is ABC-123 (مثال جميل) ok', fonts: ['Noto Sans', 'Noto Naskh Arabic'], direction: 'ltr' },
  { id: 'mixed-auto', label: 'Arabic paragraph starting with a number', text: '2024 هو العام الجديد، Happy New Year!', fonts: ['Noto Sans Arabic', 'Noto Sans'] },
  { id: 'th', label: 'Thai', text: 'สวัสดีชาวโลก ภาษาไทย น้ำใจ ผู้ใหญ่ ปลากะพง', fonts: ['Noto Sans Thai'] },
  { id: 'hi', label: 'Hindi (Devanagari)', text: 'नमस्ते दुनिया क्षत्रिय हिन्दी ज्ञान श्री कर्म', fonts: ['Noto Sans Devanagari'], size: 24 },
  { id: 'bn', label: 'Bengali', text: 'বাংলা ভাষা কেমন আছেন', fonts: ['Noto Sans Bengali'], size: 24 },
  { id: 'ta', label: 'Tamil', text: 'தமிழ் மொழி வணக்கம்', fonts: ['Noto Sans Tamil'], size: 24 },
  { id: 'zh', label: 'Chinese (Simplified)', text: '你好，世界！这是一个中文测试。', lang: 'zh-Hans', size: 24 },
  { id: 'ja', label: 'Japanese', text: 'こんにちは世界。日本語のテストです。', lang: 'ja', size: 24 },
  { id: 'ko', label: 'Korean', text: '안녕하세요 세계. 한국어 테스트입니다.', lang: 'ko', size: 24 },
  { id: 'emoji', label: 'Emoji next to text', text: 'Hello 😀 مرحبا ⭐ 123', fonts: ['Noto Sans', 'Noto Naskh Arabic'], direction: 'ltr' },
  { id: 'latin', label: 'Latin with ligatures and kerning', text: 'Waffle office AVATAR To. The quick brown fox — “quotes”', fonts: ['Noto Sans'] }
]

export const byId = (id: string): CorpusItem => {
  const it = CORPUS.find((c) => c.id === id)
  if (!it) throw new Error(`no corpus item ${id}`)
  return it
}
