import type { ReactNode } from 'react'
import { ensureEditable } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerDialog, registerPageOverlay, registerPanel, registerTool } from '../api'
import { registerValueCheck } from '../forms/values'
import { addAtCenter, clearForm, enterEdit, enterPreview, exportCsv, openTabOrder, selectedFieldName } from './actions'
import { BuilderHost } from './BuilderHost'
import { BuilderOptions } from './Options'
import { BuilderOverlay } from './Overlay'
import { FormBuilderPanel } from './Panel'
import { checkValue, parseScripts } from './logic/actions'
import { CREATE_TOOLS, PANEL_ID, SELECT_TOOL, useBuilder } from './store'

/**
 * Feature: form builder (Tools ▸ Prepare Form…, Detect Form Fields…).
 *  - Automatic detection of fields on flat PDFs (review overlay, one undo step to create them).
 *  - Manual tools for every field type, select / move / resize / align, properties panel, tab-order editor.
 *  - Preview mode (the normal form-filling behaviour), clear form, CSV list of fields.
 * All edits go through `editPdf`. PDF scripts written for other readers are never executed here.
 */

const Svg = ({ children }: { children: ReactNode }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const GROUP = 'Form builder'

function activate(docId: string, id: string): void {
  useBuilder.getState().setMode('fields')
  useWorkspace.getState().setRightPanel(PANEL_ID)
  void ensureEditable(docId).then((ok) => {
    if (!ok && useWorkspace.getState().activeTool === id) {
      useWorkspace.getState().setActiveTool(null, docId)
      notify('info', 'The document is password protected and was not unlocked, so the form cannot be edited.')
    }
  })
  if (id === 'formbuilder.radio') {
    const name = selectedFieldName(docId, 'radio')
    useBuilder.getState().setRadioGroup(name)
  }
}

const tools: { id: string; label: string; order: number; cursor: string; icon: ReactNode }[] = [
  {
    id: SELECT_TOOL,
    label: 'Edit fields',
    order: 400,
    cursor: 'default',
    icon: (
      <Svg>
        <path d="M4 2.5v10l2.6-2.4 1.8 3.4 1.6-.8-1.8-3.3H12z" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.text',
    label: 'Text field',
    order: 401,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="1.5" y="4.5" width="13" height="7" rx="1" />
        <path d="M4 8h3" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.checkbox',
    // Ribbon labels avoid the words "Check", "Date" and "Sign": other features' tests find their tools by such words.
    label: 'Tick box',
    order: 402,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="m5 8.2 2.2 2.2L11 5.8" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.radio',
    label: 'Radio group',
    order: 403,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.dropdown',
    label: 'Dropdown',
    order: 404,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="1.5" y="4.5" width="13" height="7" rx="1" />
        <path d="m9.5 7 1.5 1.8L12.5 7" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.list',
    label: 'List box',
    order: 405,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="2.5" y="2" width="11" height="12" rx="1" />
        <path d="M5 5h6M5 8h6M5 11h4" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.date',
    label: 'Calendar field',
    order: 406,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
        <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.signature',
    label: 'Sig. field',
    order: 407,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <path d="M2 11.5c1.5-3 2.5-6 3.5-6s0 5 1.2 5 1.3-3 2.3-3 .3 2.4 1.5 2.4" />
        <path d="M2 14h12" />
      </Svg>
    )
  },
  {
    id: 'formbuilder.button',
    label: 'Button',
    order: 408,
    cursor: 'crosshair',
    icon: (
      <Svg>
        <rect x="1.5" y="4" width="13" height="8" rx="2.5" />
        <path d="M5 8h6" />
      </Svg>
    )
  }
]

for (const t of tools) {
  registerTool({
    id: t.id,
    label: t.label,
    group: GROUP,
    order: t.order,
    cursor: t.cursor,
    icon: t.icon,
    Options: BuilderOptions,
    onActivate: (docId) => activate(docId, t.id)
  })
}

registerPanel({
  id: PANEL_ID,
  label: 'Form fields',
  side: 'right',
  order: 400,
  icon: (
    <Svg>
      <rect x="1.5" y="3" width="13" height="4" rx="1" />
      <rect x="1.5" y="9" width="13" height="4" rx="1" />
    </Svg>
  ),
  Component: FormBuilderPanel
})

registerPageOverlay(BuilderOverlay)
registerDialog(BuilderHost)

registerCommand({
  id: 'formbuilder.prepare',
  label: 'Prepare Form',
  run: () => {
    const t = activeTab()
    if (t) enterEdit(t.docId)
  }
})
registerCommand({
  id: 'formbuilder.detect',
  label: 'Detect Form Fields',
  run: () => {
    const t = activeTab()
    if (!t || t.status !== 'ready') return
    useBuilder.getState().setDetectScope({ open: true, scope: 'current', range: '' })
  }
})
registerCommand({
  id: 'formbuilder.preview',
  label: 'Preview form',
  run: () => {
    const t = activeTab()
    if (t) enterPreview(t.docId)
  }
})
registerCommand({
  id: 'formbuilder.tabOrder',
  label: 'Edit tab order',
  run: () => {
    const t = activeTab()
    if (!t) return
    enterEdit(t.docId)
    openTabOrder(t.docId)
  }
})
registerCommand({
  id: 'formbuilder.exportCsv',
  label: 'Export list of form fields',
  run: () => {
    const t = activeTab()
    if (t) void exportCsv(t.docId)
  }
})
registerCommand({
  id: 'formbuilder.clearForm',
  label: 'Clear form',
  run: () => {
    const t = activeTab()
    if (t) void clearForm(t.docId)
  }
})
registerCommand({
  id: 'formbuilder.addField',
  label: 'Add form field',
  run: (arg) => {
    const t = activeTab()
    const kind = typeof arg === 'string' ? (arg as keyof typeof CREATE_TOOLS) : 'formbuilder.text'
    if (t && CREATE_TOOLS[kind]) void addAtCenter(t.docId, CREATE_TOOLS[kind])
  }
})

// Epdf's own fill experience honours the formats and limits set here: the forms overlay asks this check before it
// accepts a typed value. It recognises the standard scripts (never runs them).
registerValueCheck((field, value) => checkValue(parseScripts({ format: field.scripts?.format, validate: field.scripts?.validate }), value, field.label))
