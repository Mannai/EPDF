import { Suspense, lazy } from 'react'
import { activeTab } from '../../state/actions'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import type { MarkGroup } from '@shared/features/headerfooter'
import { registerCommand, registerDialog, registerTool } from '../api'
import { IconBackground, IconBates, IconHeaderFooter, IconWatermark } from './icons'
import { useHfUi } from './store'

/**
 * Headers & footers, Bates numbering, watermarks and backgrounds (feature 21). One dialog with a tab per kind, a live
 * preview and presets; everything is drawn with the text engine (any script, Arabic first), marked as /Artifact
 * content with Acrobat-compatible PieceInfo so it can be found, updated and removed later (also after reopening).
 * The PDF logic is in ./pdf (pure pdf-lib). See docs/features/headerfooter.md.
 */

// The dialog (and with it the PDF code and the text engine) loads on first use, not at start-up.
const LazyDialog = lazy(() => import('./Dialog').then((m) => ({ default: m.PageMarksDialog })))
function DialogHost(): JSX.Element | null {
  const open = useHfUi((s) => s.open)
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <LazyDialog />
    </Suspense>
  )
}
registerDialog(DialogHost)

const readyTab = (): ReturnType<typeof activeTab> | null => {
  const t = activeTab()
  return t && t.status === 'ready' && t.numPages > 0 ? t : null
}
const hasDoc = (): boolean => !!readyTab()

function openDialog(group: MarkGroup): void {
  const t = readyTab()
  if (t) useHfUi.getState().show(t.docId, group, t.view.page)
}

const GROUP = 'Page marks'
const TOOLS: { id: string; label: string; group: MarkGroup; order: number; icon: JSX.Element }[] = [
  { id: 'headerfooter.tool.hf', label: 'Header & footer…', group: 'headerfooter', order: 700, icon: <IconHeaderFooter /> },
  { id: 'headerfooter.tool.bates', label: 'Bates…', group: 'bates', order: 710, icon: <IconBates /> },
  { id: 'headerfooter.tool.watermark', label: 'Watermark…', group: 'watermark', order: 720, icon: <IconWatermark /> },
  { id: 'headerfooter.tool.background', label: 'Background…', group: 'background', order: 730, icon: <IconBackground /> }
]
for (const t of TOOLS) {
  registerTool({
    id: t.id,
    label: t.label,
    group: GROUP,
    order: t.order,
    icon: t.icon,
    onActivate: (docId) => {
      // a button, not a mode: open the dialog and leave no tool selected
      queueMicrotask(() => {
        useWorkspace.getState().setActiveTool(null, docId)
        openDialog(t.group)
      })
    }
  })
}

registerCommand({ id: 'headerfooter.open', label: 'Header and Footer…', enabled: hasDoc, run: () => openDialog('headerfooter') })
registerCommand({ id: 'headerfooter.bates', label: 'Bates Numbering…', enabled: hasDoc, run: () => openDialog('bates') })
registerCommand({ id: 'headerfooter.watermark', label: 'Watermark…', enabled: hasDoc, run: () => openDialog('watermark') })
registerCommand({ id: 'headerfooter.background', label: 'Background…', enabled: hasDoc, run: () => openDialog('background') })

const removeCommand = (id: string, label: string, group: MarkGroup): void =>
  registerCommand({
    id,
    label,
    enabled: hasDoc,
    run: async () => {
      const t = readyTab()
      if (!t) return
      const { removeAction } = await import('./actions')
      await removeAction(t.docId, group)
    }
  })
removeCommand('headerfooter.removeHeaderFooter', 'Remove Headers and Footers', 'headerfooter')
removeCommand('headerfooter.removeBates', 'Remove Bates Numbering', 'bates')
removeCommand('headerfooter.removeWatermark', 'Remove Watermarks', 'watermark')
removeCommand('headerfooter.removeBackground', 'Remove Backgrounds', 'background')

// A dialog that belongs to a tab that is no longer active is closed.
useTabs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId && useHfUi.getState().open) useHfUi.getState().close()
})
