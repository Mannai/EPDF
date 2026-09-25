import { activeTab } from '../../state/actions'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerDialog, registerPageOverlay, registerTool } from '../api'
import { SignatureDialog } from './SignatureDialog'
import { SIGN_TOOL_IDS, SignOptions, SignOverlay, cancelPlacement } from './SignTool'
import { useSignatures } from './store'

/**
 * Feature: visual self-signing. A "Signatures" dialog (draw / type / import, stored encrypted by main) and
 * the Sign / Initials tools that place the saved image on a page. NOT a cryptographic digital signature.
 */

const Svg = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const refresh = (): void => void useSignatures.getState().refresh().catch(() => undefined)

registerTool({
  id: SIGN_TOOL_IDS.signature,
  label: 'Sign',
  group: 'Sign',
  order: 250,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <path d="M2 11c1.5-4 3-6 4-6s-.5 5 .5 5S9 6 10 6s0 4 1 4 1.5-1 3-2" />
      <path d="M2 13.5h12" />
    </Svg>
  ),
  Options: () => <SignOptions kind="signature" />,
  onActivate: refresh,
  onDeactivate: cancelPlacement
})
registerTool({
  id: SIGN_TOOL_IDS.initials,
  label: 'Initials',
  group: 'Sign',
  order: 251,
  cursor: 'crosshair',
  icon: (
    <Svg>
      <path d="M3 3v6M3 3h2.5a1.5 1.5 0 0 1 0 3H3M9 3v6M11.5 3v6" />
      <path d="M2 13.5h12" />
    </Svg>
  ),
  Options: () => <SignOptions kind="initials" />,
  onActivate: refresh,
  onDeactivate: cancelPlacement
})

registerCommand({ id: 'sign.manage', label: 'Signatures…', run: () => useSignatures.getState().openDialog() })
registerCommand({
  id: 'sign.activate',
  label: 'Sign document',
  run: () => {
    const t = activeTab()
    if (t) useWorkspace.getState().setActiveTool(SIGN_TOOL_IDS.signature, t.docId)
  }
})
registerCommand({
  id: 'sign.activateInitials',
  label: 'Add initials',
  run: () => {
    const t = activeTab()
    if (t) useWorkspace.getState().setActiveTool(SIGN_TOOL_IDS.initials, t.docId)
  }
})

registerPageOverlay(SignOverlay)
registerDialog(SignatureDialog)

// A half-placed signature never survives switching tools or documents.
useWorkspace.subscribe((s, prev) => {
  if (s.activeTool !== prev.activeTool) cancelPlacement()
})
