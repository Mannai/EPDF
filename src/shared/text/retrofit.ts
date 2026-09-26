import { Encodings } from '@pdf-lib/standard-fonts'
import { isTextEngineConfigured } from './env'
import { layoutParagraph } from './layout'
import { useRendererResources } from './renderer'
import type { ParagraphOptions } from './types'

/**
 * Helpers for features that write text into PDFs (forms, add text, markup, reports, redaction, text editing).
 *
 * The rule every feature follows (docs/text-engine.md, "Which path writes the text"): text whose every character
 * WinAnsi can encode (the encoding of the standard 14 fonts: Western European Latin and common punctuation) keeps the
 * standard-font output it always had (no font embedded, byte-for-byte the same drawing); any other character sends
 * that whole piece of text (a field value, a text box, a report line) through the text engine, which shapes it, orders
 * it for display, embeds subset fonts and keeps it extractable in logical order.
 */

const LAYOUT = /[\r\n\t]/g

/** True when WinAnsi (standard 14 fonts) can encode every character of `text` (newlines and tabs are layout). */
export function isWinAnsiText(text: string): boolean {
  for (const ch of text.replace(LAYOUT, '')) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp === 0x7f) continue
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) return false
  }
  return true
}

/** The characters of `text` WinAnsi cannot encode (each once). */
export function nonWinAnsiChars(text: string): string[] {
  const out = new Set<string>()
  for (const ch of text.replace(LAYOUT, '')) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp !== 0x7f && !Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) out.add(ch)
  }
  return [...out]
}

/**
 * Makes sure the engine can read its fonts and WebAssembly: in the sandboxed renderer it asks main over the
 * `text:resource` channel; Node hosts (tests, workers) must have called `useNodeResources()` already.
 */
export function ensureTextEngine(): void {
  if (isTextEngineConfigured()) return
  if ((globalThis as unknown as { epdf?: unknown }).epdf) {
    useRendererResources()
    return
  }
  throw new Error('The text engine is not set up in this process (call useNodeResources() or useRendererResources()).')
}

/** Characters of `text` that no bundled font (after the fallbacks of `options.fontStack`) can draw, each once. */
export async function uncoveredChars(text: string, options: ParagraphOptions = {}): Promise<string[]> {
  ensureTextEngine()
  const layout = await layoutParagraph(text, { ...options, width: undefined, onMissing: 'notdef' })
  const out = new Set<string>()
  for (const m of layout.missing) if (!/\s/.test(m.char)) out.add(m.char)
  return [...out]
}
