import type { PDFPage } from 'pdf-lib'
import { Fixture, LETTER, LOREM_AR, LOREM_EN, rng, toVisual, words, wrap, type Doc, type Truth, type UniFont } from './lbDocs'

/** Heading-detection fixtures with known ground truth (see lbDocs.ts for the drawing primitives). */

const CHAPTERS_EN = ['Introduction', 'System Architecture', 'Implementation', 'Evaluation', 'Conclusion']
const SECTIONS_EN = [
  ['Background', 'Objectives', 'Scope of this Report'],
  ['Overview', 'Core Components', 'Data Flow'],
  ['Tooling', 'Build Process', 'Deployment'],
  ['Methodology', 'Results', 'Discussion'],
  ['Summary', 'Future Work']
]

interface Cursor {
  page: PDFPage
  y: number
  pageIndex: number
}

/** A long English report: title page, 5 chapters with sections and subsections, running header, page numbers, captions, bullets, footnotes. */
export async function englishReport(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sans, sansBold, serif } = fx.fonts
  const rand = rng(7)
  const truth: Truth[] = []
  const decoys: string[] = ['Annual Report 2024', 'Prepared by the Finance Department', 'ACME Corporation', 'Table 1: Revenue by quarter', 'Figures are unaudited']

  const cover = fx.page()
  const centered = (page: PDFPage, font: typeof sans, text: string, y: number, size: number): void => {
    fx.latin(page, font, text, (612 - fx.width(font, text, size)) / 2, y, size)
  }
  centered(cover, sansBold, 'Annual Report 2024', 560, 30)
  centered(cover, sans, 'Prepared by the Finance Department', 520, 14)
  centered(cover, sans, 'ACME Corporation', 200, 12)

  const cur: Cursor = { page: fx.page(), y: 700, pageIndex: 1 }
  const newPage = (): void => {
    cur.page = fx.page()
    cur.pageIndex++
    cur.y = 700
  }
  const ensure = (h: number): void => {
    if (cur.y - h < 72) newPage()
  }
  const paragraph = (n: number): void => {
    const lines = wrap(words(rand, n, LOREM_EN), 468, (s) => fx.width(serif, s, 11))
    for (const l of lines) {
      ensure(14)
      fx.latin(cur.page, serif, l, 72, cur.y, 11)
      cur.y -= 14
    }
    cur.y -= 8
  }
  const heading = (text: string, size: number, level: number, above: number, below: number): void => {
    ensure(above + size + below + 30)
    cur.y -= above
    fx.latin(cur.page, sansBold, text, 72, cur.y, size)
    truth.push({ pageIndex: cur.pageIndex, text, level })
    cur.y -= size + below
  }

  CHAPTERS_EN.forEach((title, ci) => {
    if (ci > 0) newPage()
    heading(`${ci + 1} ${title}`, 20, 1, 0, 14)
    paragraph(70)
    SECTIONS_EN[ci].forEach((sec, si) => {
      heading(`${ci + 1}.${si + 1} ${sec}`, 14, 2, 14, 8)
      paragraph(90)
      if (si === 0) {
        heading(`${ci + 1}.${si + 1}.1 Details`, 12, 3, 8, 6)
        paragraph(60)
        // A bullet list, a caption and a footnote: none of these is a heading.
        for (const item of ['First point to remember', 'Second point to remember', 'Third point to remember']) {
          ensure(14)
          fx.latin(cur.page, serif, `• ${item}`, 90, cur.y, 11)
          cur.y -= 14
        }
        cur.y -= 8
      }
      if (si === 1) {
        ensure(40)
        fx.latin(cur.page, sansBold, 'Table 1: Revenue by quarter', 72, cur.y, 9)
        cur.y -= 16
        fx.latin(cur.page, sans, 'Q1   Q2   Q3   Q4   1200   1350   1500   1720', 72, cur.y, 9)
        cur.y -= 20
      }
      paragraph(50)
    })
    fx.latin(cur.page, sans, '1 Figures are unaudited.', 72, 52, 8)
  })

  // Running header (from page 2 on) and page numbers.
  fx.doc.getPages().forEach((p, i) => {
    if (i === 0) return
    fx.latin(p, sans, 'ACME Corp - Annual Report 2024', 72, 760, 9)
    fx.latin(p, sans, `Page ${i + 1}`, 290, 30, 9)
  })
  return { name: 'english-report', bytes: await fx.save(), truth, decoys }
}

/**
 * A harder report: a table of contents with dot leaders (not headings), chapters with wrapped titles, a table
 * with a bold header row, bold "Note:" lines, a sidebar quote in a larger size, and unnumbered second-level headings.
 */
export async function hardReport(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sans, sansBold, serif, serifBold } = fx.fonts
  const rand = rng(41)
  const truth: Truth[] = []
  const decoys = ['1 Getting Started ........ 3', 'Quarter Revenue Cost', 'Note: keep regular backups.', '\u201CSimplicity is prerequisite for reliability.\u201D']
  const chapters = ['Getting Started', 'Daily Operations', 'Backup and Recovery Procedures for Production Databases in Regulated Environments', 'Reference']
  const subs = [['Requirements', 'First Run'], ['Monitoring', 'Alerting'], ['Full Backups', 'Point in Time Recovery'], ['Command Line']]

  const toc = fx.page()
  fx.latin(toc, sansBold, 'Table of Contents', 72, 700, 16)
  truth.push({ pageIndex: 0, text: 'Table of Contents', level: 1 })
  chapters.slice(0, 2).concat(['Reference']).forEach((c, i) => fx.latin(toc, serif, `${i + 1} ${c} .................. ${3 + i * 3}`, 72, 660 - i * 18, 11))
  fx.latin(toc, serif, '1 Getting Started ........ 3', 72, 560, 11)

  const cur: Cursor = { page: fx.page(), y: 700, pageIndex: 1 }
  const newPage = (): void => {
    cur.page = fx.page()
    cur.pageIndex++
    cur.y = 700
  }
  const ensure = (h: number): void => {
    if (cur.y - h < 72) newPage()
  }
  const paragraph = (n: number): void => {
    for (const l of wrap(words(rand, n, LOREM_EN), 468, (t) => fx.width(serif, t, 11))) {
      ensure(14)
      fx.latin(cur.page, serif, l, 72, cur.y, 11)
      cur.y -= 14
    }
    cur.y -= 8
  }
  chapters.forEach((title, ci) => {
    if (ci > 0) newPage()
    const full = `Chapter ${ci + 1}: ${title}`
    const lines = wrap(full.split(' '), 468, (t) => fx.width(sansBold, t, 22))
    lines.forEach((l) => {
      fx.latin(cur.page, sansBold, l, 72, cur.y, 22)
      cur.y -= 26
    })
    truth.push({ pageIndex: cur.pageIndex, text: full, level: 1 })
    cur.y -= 6
    paragraph(70)
    subs[ci].forEach((sec, si) => {
      ensure(80)
      cur.y -= 12
      fx.latin(cur.page, serifBold, sec, 72, cur.y, 15)
      truth.push({ pageIndex: cur.pageIndex, text: sec, level: 2 })
      cur.y -= 20
      paragraph(80)
      if (ci === 0 && si === 0) {
        ensure(120)
        fx.latin(cur.page, sansBold, 'Quarter Revenue Cost', 72, cur.y, 11)
        fx.latin(cur.page, sans, 'Q1 1200 800', 72, cur.y - 14, 11)
        fx.latin(cur.page, sans, 'Q2 1350 900', 72, cur.y - 28, 11)
        cur.y -= 50
        fx.latin(cur.page, sansBold, 'Note: keep regular backups.', 72, cur.y, 11)
        cur.y -= 22
        fx.latin(cur.page, serif, '\u201CSimplicity is prerequisite for reliability.\u201D', 120, cur.y, 13)
        cur.y -= 26
      }
    })
  })
  fx.doc.getPages().forEach((p, i) => {
    if (i === 0) return
    fx.latin(p, sans, 'Operations Handbook', 72, 760, 9)
    fx.latin(p, sans, `${i + 1}`, 300, 30, 9)
  })
  return { name: 'hard-report', bytes: await fx.save(), truth, decoys }
}

/** Headings differ from the body only by weight (same size), no numbering. */
export async function boldOnlyManual(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sansBold, serif } = fx.fonts
  const rand = rng(11)
  const truth: Truth[] = []
  const titles = ['Overview', 'Installation', 'Configuration', 'Troubleshooting', 'Frequently Asked Questions', 'Release Notes']
  let page = fx.page()
  let pageIndex = 0
  let y = 720
  for (const t of titles) {
    if (y < 260) {
      page = fx.page()
      pageIndex++
      y = 720
    }
    y -= 12
    fx.latin(page, sansBold, t, 72, y, 11)
    truth.push({ pageIndex, text: t, level: 1 })
    y -= 20
    for (const l of wrap(words(rand, 120, LOREM_EN), 468, (s) => fx.width(serif, s, 11))) {
      fx.latin(page, serif, l, 72, y, 11)
      y -= 14
    }
  }
  return { name: 'bold-only', bytes: await fx.save(), truth, decoys: [] }
}

/** Unnumbered ALL-CAPS headings at almost the body size. */
export async function capsHeadings(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sans, serif } = fx.fonts
  const rand = rng(13)
  const truth: Truth[] = []
  const titles = ['INTRODUCTION', 'METHODS AND MATERIALS', 'RESULTS', 'DISCUSSION', 'ACKNOWLEDGEMENTS']
  let page = fx.page()
  let pageIndex = 0
  let y = 720
  for (const t of titles) {
    if (y < 260) {
      page = fx.page()
      pageIndex++
      y = 720
    }
    y -= 22
    fx.latin(page, sans, t, 72, y, 12)
    truth.push({ pageIndex, text: t, level: 1 })
    y -= 22
    for (const l of wrap(words(rand, 110, LOREM_EN), 468, (s) => fx.width(serif, s, 11))) {
      fx.latin(page, serif, l, 72, y, 11)
      y -= 14
    }
  }
  return { name: 'all-caps', bytes: await fx.save(), truth, decoys: [] }
}

/** Ten pages of prose with a running header and page numbers: nothing here is a heading. */
export async function noHeadings(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sans, serif } = fx.fonts
  const rand = rng(17)
  for (let p = 0; p < 10; p++) {
    const page = fx.page()
    let y = 700
    for (const l of wrap(words(rand, 420, LOREM_EN), 468, (s) => fx.width(serif, s, 11))) {
      if (y < 80) break
      fx.latin(page, serif, l, 72, y, 11)
      y -= 14
    }
    fx.latin(page, sans, 'Internal memorandum - draft', 72, 760, 9)
    fx.latin(page, sans, `${p + 1}`, 300, 30, 9)
  }
  return { name: 'no-headings', bytes: await fx.save(), truth: [], decoys: [] }
}

/** Two-column paper: a full-width title, numbered bold section headings inside each column. */
export async function twoColumn(): Promise<Doc> {
  const fx = await Fixture.create()
  const { sans, sansBold, serif } = fx.fonts
  const rand = rng(23)
  const truth: Truth[] = []
  const decoys = ['A Study of Modular Systems', 'Jane Doe and John Roe']
  const sections: [string, number][] = [
    ['1 Introduction', 1],
    ['2 Related Work', 1],
    ['3 Method', 1],
    ['3.1 Data Collection', 2],
    ['3.2 Analysis', 2],
    ['4 Results', 1],
    ['5 Conclusion', 1]
  ]
  const COLS = [54, 318]
  const colW = 240
  let page = fx.page()
  let pageIndex = 0
  const centered = (text: string, y: number, font: typeof sans, size: number): void => {
    fx.latin(page, font, text, (612 - fx.width(font, text, size)) / 2, y, size)
  }
  centered('A Study of Modular Systems', 730, sansBold, 18)
  centered('Jane Doe and John Roe', 708, sans, 10)
  let col = 0
  let y = 670
  const advance = (h: number): void => {
    if (y - h < 60) {
      col++
      if (col > 1) {
        page = fx.page()
        pageIndex++
        col = 0
        y = 720
      } else y = pageIndex === 0 ? 670 : 720
    }
  }
  for (const [title, level] of sections) {
    advance(60)
    y -= level === 1 ? 10 : 6
    fx.latin(page, sansBold, title, COLS[col], y, level === 1 ? 12 : 10)
    truth.push({ pageIndex, text: title, level })
    y -= 14
    for (const l of wrap(words(rand, level === 1 ? 190 : 130, LOREM_EN), colW, (s) => fx.width(serif, s, 10))) {
      advance(12)
      fx.latin(page, serif, l, COLS[col], y, 10)
      y -= 12
    }
  }
  return { name: 'two-column', bytes: await fx.save(), truth, decoys }
}

const ORDINALS_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس']
const CHAPTER_TOPICS_AR = ['مقدمة عن الأمن', 'المفاهيم الأساسية', 'التهديدات والمخاطر', 'أساليب الحماية', 'الخلاصة والتوصيات']
const SECTIONS_AR = [['نظرة عامة', 'أهداف الكتاب'], ['التعريفات', 'المبادئ الأساسية'], ['أنواع التهديدات', 'تحليل المخاطر'], ['التشفير', 'إدارة الهوية'], ['ملخص الفصول']]
const toArabicDigits = (n: number): string => String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)))

/**
 * An Arabic right-to-left book. `order` selects how the text is stored in the content stream: visual (leftmost
 * glyph first, what browsers and most producers write) or logical.
 */
export async function arabicBook(order: 'visual' | 'logical'): Promise<Doc> {
  const fx = await Fixture.create()
  const regular: UniFont = fx.uni('ABCDEF+NotoNaskhArabic-Regular')
  const bold: UniFont = fx.uni('ABCDEF+NotoNaskhArabic-Bold')
  const rand = rng(29)
  const truth: Truth[] = []
  const decoys: string[] = ['كتاب الأمن السيبراني', 'دليل شامل للمبتدئين']
  const RIGHT = 540
  const stored = (logical: string): string => (order === 'visual' ? toVisual(logical) : logical)
  const right = (page: PDFPage, font: UniFont, logical: string, y: number, size: number): void => {
    const w = font.width(logical, size)
    fx.drawUni(page, font, stored(logical), RIGHT - w, y, size)
  }
  const cover = fx.page()
  const mid = (font: UniFont, logical: string, y: number, size: number): void => {
    fx.drawUni(cover, font, stored(logical), (612 - font.width(logical, size)) / 2, y, size)
  }
  mid(bold, 'كتاب الأمن السيبراني', 560, 30)
  mid(regular, 'دليل شامل للمبتدئين', 520, 14)

  const cur: Cursor = { page: fx.page(), y: 700, pageIndex: 1 }
  const newPage = (): void => {
    cur.page = fx.page()
    cur.pageIndex++
    cur.y = 700
  }
  const ensure = (h: number): void => {
    if (cur.y - h < 72) newPage()
  }
  const paragraph = (n: number): void => {
    for (const l of wrap(words(rand, n, LOREM_AR), 468, (s) => regular.width(s, 12))) {
      ensure(18)
      right(cur.page, regular, l, cur.y, 12)
      cur.y -= 18
    }
    cur.y -= 8
  }
  const heading = (text: string, size: number, level: number, above: number, below: number): void => {
    ensure(above + size + below + 30)
    cur.y -= above
    right(cur.page, bold, text, cur.y, size)
    truth.push({ pageIndex: cur.pageIndex, text, level })
    cur.y -= size + below
  }
  CHAPTERS_EN.forEach((_, ci) => {
    if (ci > 0) newPage()
    heading(`الفصل ${ORDINALS_AR[ci]}: ${CHAPTER_TOPICS_AR[ci]}`, 22, 1, 0, 16)
    paragraph(60)
    SECTIONS_AR[ci].forEach((sec, si) => {
      heading(`${ci + 1}.${si + 1} ${sec}`, 15, 2, 14, 10)
      paragraph(80)
      paragraph(40)
    })
  })
  fx.doc.getPages().forEach((p, i) => {
    if (i === 0) return
    const h = 'كتاب الأمن السيبراني'
    fx.drawUni(p, regular, stored(h), (612 - regular.width(h, 9)) / 2, 760, 9)
    const n = toArabicDigits(i + 1)
    fx.drawUni(p, regular, n, 300, 30, 9)
  })
  return { name: `arabic-${order}`, bytes: await fx.save(), truth, decoys }
}

/** Chinese report: "第一章 …" chapters and "1.1 …" sections in a CJK font. */
export async function cjkReport(): Promise<Doc> {
  const fx = await Fixture.create()
  const regular = fx.uni('ABCDEF+NotoSansCJKsc-Regular')
  const bold = fx.uni('ABCDEF+NotoSansCJKsc-Bold')
  const rand = rng(31)
  const truth: Truth[] = []
  const bodyChars = Array.from('系统采用模块化设计每个组件通过明确定义的接口进行通信并在处理之前验证每一个请求然后存储结果')
  const cur: Cursor = { page: fx.page(), y: 700, pageIndex: 0 }
  const newPage = (): void => {
    cur.page = fx.page()
    cur.pageIndex++
    cur.y = 700
  }
  const chapters: [string, string[]][] = [
    ['第一章 概述', ['1.1 背景', '1.2 目标']],
    ['第二章 系统设计', ['2.1 总体架构', '2.2 数据流']],
    ['第三章 实现', ['3.1 工具链']]
  ]
  const paragraph = (n: number): void => {
    const text = Array.from({ length: n }, () => bodyChars[Math.floor(rand() * bodyChars.length)])
    const perLine = 34
    for (let i = 0; i < text.length; i += perLine) {
      if (cur.y < 80) newPage()
      fx.drawUni(cur.page, regular, text.slice(i, i + perLine).join(''), 72, cur.y, 11)
      cur.y -= 16
    }
    cur.y -= 8
  }
  chapters.forEach(([title, secs], ci) => {
    if (ci > 0) newPage()
    fx.drawUni(cur.page, bold, title, 72, cur.y, 22)
    truth.push({ pageIndex: cur.pageIndex, text: title, level: 1 })
    cur.y -= 40
    paragraph(140)
    for (const s of secs) {
      cur.y -= 10
      fx.drawUni(cur.page, bold, s, 72, cur.y, 15)
      truth.push({ pageIndex: cur.pageIndex, text: s, level: 2 })
      cur.y -= 26
      paragraph(200)
    }
  })
  return { name: 'cjk', bytes: await fx.save(), truth, decoys: [] }
}

export const ALL_HEADING_DOCS = { englishReport, hardReport, boldOnlyManual, capsHeadings, noHeadings, twoColumn, cjkReport }
export { LETTER }
