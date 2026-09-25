/**
 * File names for split/extract output. Titles come from bookmarks (untrusted text inside a PDF), so they are
 * reduced to something that is safe to create on Windows, macOS and Linux: no separators or traversal, no
 * reserved device names, no control or bidi-override characters, bounded length.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i
// Path separators, characters Windows forbids, C0/C1 controls, zero-width and bidi override/isolate characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = max
  const code = s.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut-- // do not end on a lone high surrogate
  return s.slice(0, cut)
}

/**
 * A single, safe file-name stem (no extension). Never empty, never "." or "..", never a reserved Windows
 * device name, never ending in a dot or space.
 */
export function sanitizeFileName(input: string, opts: { fallback?: string; maxLength?: number } = {}): string {
  const fallback = opts.fallback ?? 'part'
  const max = opts.maxLength ?? 100
  let s = (input ?? '').normalize('NFC').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[. ]+/, '').replace(/[. ]+$/, '') // no hidden files, "..", or trailing dots/spaces (Windows strips them)
  s = truncate(s, max).replace(/[. ]+$/, '').trim()
  if (!s) return fallback
  // "CON", "con.txt", "COM1 - notes": the device name is whatever comes before the first dot.
  if (RESERVED.test(s.split('.')[0].trim())) s = `_${s}`
  return s
}

/** `name.pdf`, or `name (2).pdf`, `name (3).pdf`... until it is not in `taken` (compared case-insensitively) and adds it. */
export function uniqueFileName(stem: string, ext: string, taken: Set<string>): string {
  const e = ext.startsWith('.') ? ext : `.${ext}`
  let candidate = `${stem}${e}`
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${e}`
  taken.add(candidate.toLowerCase())
  return candidate
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/**
 * Names for the parts of a split: "Report - 01 - Introduction.pdf" style. `titles[i]` is optional text
 * (a bookmark title or page range). Names are unique among themselves and against `existing` (file names already
 * in the target folder), so nothing is ever overwritten.
 */
export function partFileNames(base: string, titles: (string | undefined)[], existing: Iterable<string> = []): string[] {
  const taken = new Set<string>([...existing].map((s) => s.toLowerCase()))
  const stem = sanitizeFileName(base, { fallback: 'document', maxLength: 60 })
  const width = Math.max(2, String(titles.length).length)
  return titles.map((t, i) => {
    const title = t ? sanitizeFileName(t, { fallback: '', maxLength: 60 }) : ''
    const name = title ? `${stem} - ${pad(i + 1, width)} - ${title}` : `${stem} - ${pad(i + 1, width)}`
    return uniqueFileName(name, '.pdf', taken)
  })
}

/** The name of a PDF without its extension, for use as a base ("Annual Report.pdf" → "Annual Report"). */
export const stemOf = (fileName: string): string => fileName.replace(/\.pdf$/i, '')
