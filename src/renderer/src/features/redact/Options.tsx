import { useWorkspace } from '../../state/workspace'
import { IconRedactPanel } from './icons'
import { AREA_TOOL, FIND_TOOL, TEXT_TOOL } from './overlay'
import { REDACT_PANEL } from './Panel'
import { useDocRedact, useRedact } from './store'

const HINT: Record<string, string> = {
  [TEXT_TOOL]: 'Select text on the page to mark it',
  [AREA_TOOL]: 'Drag on the page to mark an area',
  [FIND_TOOL]: 'Search in the panel, then mark the matches'
}

/** Ribbon controls shown while a redaction tool is active. */
export function RedactOptions({ docId }: { docId: string }): JSX.Element {
  const tool = useWorkspace((s) => s.activeTool)
  const panelOpen = useWorkspace((s) => s.rightPanel === REDACT_PANEL)
  const d = useDocRedact(docId)
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-muted">{HINT[tool ?? ''] ?? ''}</span>
      <span className="shrink-0 whitespace-nowrap text-xs" data-testid="redact-ribbon-count" aria-live="polite">
        {d.marks.length} {d.marks.length === 1 ? 'mark' : 'marks'}
      </span>
      <button type="button" className="btn shrink-0 whitespace-nowrap text-xs" aria-pressed={panelOpen} onClick={() => useWorkspace.getState().toggleRightPanel(REDACT_PANEL)}>
        <IconRedactPanel />
        Redaction panel
      </button>
      <button type="button" className="btn-primary shrink-0 whitespace-nowrap text-xs" disabled={d.marks.length === 0} data-testid="redact-ribbon-apply" onClick={() => useRedact.getState().openDialog(docId)}>
        Review and apply…
      </button>
    </>
  )
}
