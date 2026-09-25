import { z } from 'zod'

export const CombineItemSchema = z.object({
  id: z.string().max(64),
  /** Optional page range such as `1-3, 5, 8-` (only meaningful for PDFs and multi-page TIFFs). */
  range: z.string().max(200).optional()
})

export const CombineRunPayloadSchema = z.object({
  items: z.array(CombineItemSchema).min(1).max(200),
  /** Add one bookmark per input file (with that file's own bookmarks nested beneath it). */
  bookmarks: z.boolean().default(true),
  images: z.object({ pageSize: z.enum(['image', 'a4', 'letter']).default('image') }).default({ pageSize: 'image' }),
  engine: z.enum(['builtin', 'libreoffice']).default('builtin'),
  openInApp: z.boolean().default(false)
})
export type CombineRunPayload = z.infer<typeof CombineRunPayloadSchema>

export type RangeResult = { ok: true; pages: number[] } | { ok: false; error: string }

/**
 * Parses a page-range expression into 0-based page indexes, in the order written (`3,1-2` => [2,0,1]).
 * Empty text means "all pages". Open ranges (`5-`, `-3`) are allowed. Out-of-range or malformed input is an error.
 */
export function parsePageRange(text: string | undefined, pageCount: number): RangeResult {
  const all = Array.from({ length: pageCount }, (_, i) => i)
  const src = (text ?? '').trim()
  if (!src) return { ok: true, pages: all }
  if (pageCount < 1) return { ok: false, error: 'This file has no pages.' }
  const out: number[] = []
  for (const raw of src.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part)
    if (!m || (!m[1] && !m[3])) return { ok: false, error: `“${part}” is not a valid page range.` }
    const hasDash = m[2] === '-'
    const from = m[1] ? parseInt(m[1], 10) : 1
    const to = hasDash ? (m[3] ? parseInt(m[3], 10) : pageCount) : from
    if (from < 1 || to < 1) return { ok: false, error: 'Page numbers start at 1.' }
    if (from > pageCount || to > pageCount) return { ok: false, error: `This file has only ${pageCount} page${pageCount === 1 ? '' : 's'}.` }
    if (from > to) return { ok: false, error: `“${part}” goes backwards. Write it as ${to}-${from}.` }
    for (let p = from; p <= to; p++) out.push(p - 1)
  }
  if (out.length === 0) return { ok: false, error: 'Enter at least one page.' }
  return { ok: true, pages: out }
}
