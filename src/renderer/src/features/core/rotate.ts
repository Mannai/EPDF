import { degrees } from 'pdf-lib'
import { EditError, editPdf } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { errorMessage, notify } from '../../state/notify'
import { registerCommand } from '../api'

async function rotateCurrentPage(delta: 90 | -90): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.status !== 'ready') return
  try {
    await editPdf(tab.docId, delta > 0 ? 'Rotate page clockwise' : 'Rotate page counterclockwise', (pdf) => {
      const page = pdf.getPage(tab.view.page - 1)
      page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360))
    })
  } catch (err) {
    notify('error', err instanceof EditError ? err.message : `Couldn’t rotate the page: ${errorMessage(err)}`)
  }
}

// The simplest complete example of a feature: two commands whose menu items are contributed by
// src/main/features/core/index.ts. The page organizer builds on the same `editPdf` pipeline.
registerCommand({ id: 'page.rotateCW', label: 'Rotate Page Clockwise', run: () => rotateCurrentPage(90) })
registerCommand({ id: 'page.rotateCCW', label: 'Rotate Page Counterclockwise', run: () => rotateCurrentPage(-90) })
