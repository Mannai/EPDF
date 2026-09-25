import { registerPageOverlay, registerTool } from '../api'
import { TEXT_TOOL_ID, TextEditOverlay } from './TextEditOverlay'
import { TextOptions } from './TextOptions'
import { useTextEdit } from './state'

/**
 * Feature: edit text in the page content (docs/features/edit-content.md).
 * The content-stream engine lives in ./pdfcontent (pure TypeScript, unit-tested in Node).
 */

registerTool({
  id: TEXT_TOOL_ID,
  label: 'Edit text',
  group: 'Edit',
  order: 300,
  cursor: 'text',
  icon: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 4V3h10v1M8 3v10M6 13h4" />
    </svg>
  ),
  Options: TextOptions,
  onDeactivate: () => useTextEdit.getState().end()
})

registerPageOverlay(TextEditOverlay)
