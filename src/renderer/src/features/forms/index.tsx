import { activeTab } from '../../state/actions'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerDialog, registerPageOverlay, registerTool } from '../api'
import { FormFieldsOverlay } from './FieldsOverlay'
import { FormsHost } from './FormsHost'
import { useForms } from './store'
import { TextOptions, TextToolOverlay, commitTextDraft } from './textTool'

/**
 * Feature: form filling + flat-PDF text and stamps.
 *  - AcroForm fields become real HTML inputs over the page (FieldsOverlay); edits go through `editPdf`.
 *  - "Add text" and check / cross / dot / date stamps draw permanent content into the page.
 */

const Svg = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const GROUP = 'Forms'

registerTool({
  id: 'forms.addText',
  label: 'Add text',
  group: GROUP,
  order: 200,
  cursor: 'text',
  icon: (
    <Svg>
      <path d="M3 4V3h10v1M8 3v10M6 13h4" />
    </Svg>
  ),
  Options: TextOptions
})
registerTool({
  id: 'forms.stampCheck',
  label: 'Check',
  group: GROUP,
  order: 201,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <path d="m3 8.5 3.5 3.5L13 4.5" />
    </Svg>
  ),
  Options: TextOptions
})
registerTool({
  id: 'forms.stampCross',
  label: 'Cross',
  group: GROUP,
  order: 202,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  Options: TextOptions
})
registerTool({
  id: 'forms.stampDot',
  label: 'Dot',
  group: GROUP,
  order: 203,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </Svg>
  ),
  Options: TextOptions
})
registerTool({
  id: 'forms.stampDate',
  label: 'Date',
  group: GROUP,
  order: 204,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </Svg>
  ),
  Options: TextOptions
})

registerCommand({
  id: 'forms.toggleHighlight',
  label: 'Highlight form fields',
  run: () => useForms.getState().toggleHighlight()
})
registerCommand({
  id: 'forms.activateAddText',
  label: 'Add text',
  run: () => {
    const t = activeTab()
    if (t) useWorkspace.getState().setActiveTool('forms.addText', t.docId)
  }
})

registerPageOverlay(FormFieldsOverlay)
registerPageOverlay(TextToolOverlay)
registerDialog(FormsHost)

// Switching tools (or leaving the page viewer) must not throw away a half-typed box: it is written to the page.
useWorkspace.subscribe((s, prev) => {
  if (prev.activeTool === 'forms.addText' && s.activeTool !== 'forms.addText') void commitTextDraft()
})
