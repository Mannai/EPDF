import type { FlowDocument, Paragraph } from './flow'
import { DEFAULT_PARA_PROPS } from './flow'
import type { ConvertEnv } from './env'

/** Decodes a text file: UTF-8/16 with BOM, then UTF-8, then Windows-1252 as the fallback for legacy files. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Plain text as monospace pages: every line is a paragraph (blank lines kept), long lines wrap, form feeds break pages. */
export function readPlainText(bytes: Uint8Array, env: ConvertEnv): FlowDocument {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n')
  const style = { family: 'Liberation Mono', size: 10, bold: false, italic: false, underline: false, strike: false, color: '#000000' }
  const props = { ...DEFAULT_PARA_PROPS, widowControl: false }
  const blocks: Paragraph[] = []
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop() // a trailing newline does not add a blank line
  for (const line of lines) {
    if (line.includes('\f')) {
      const parts = line.split('\f')
      parts.forEach((p, i) => {
        if (i > 0) blocks.push({ k: 'p', props: { ...props, pageBreakBefore: true }, inlines: p ? [{ k: 'text', text: p, style }] : [], markStyle: style })
        else blocks.push({ k: 'p', props, inlines: p ? [{ k: 'text', text: p, style }] : [], markStyle: style })
      })
    } else blocks.push({ k: 'p', props, inlines: line ? [{ k: 'text', text: line, style }] : [], markStyle: style })
  }
  if (blocks.length === 0) blocks.push({ k: 'p', props, inlines: [], markStyle: style })
  const m = 62
  return {
    // 8 columns of Liberation Mono 10pt (6.0pt each)
    defaultTabStop: 48,
    sections: [
      {
        page: { width: env.page.width, height: env.page.height, margins: { top: m, right: m, bottom: m, left: m, header: 36, footer: 36 } },
        type: 'nextPage',
        blocks
      }
    ]
  }
}
