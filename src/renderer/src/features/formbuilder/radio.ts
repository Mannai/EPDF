import { useUi } from '../../state/ui'
import { runEdit } from './actions'
import { nudge } from './logic/align'
import { addRadioButton } from './logic/create'
import { deleteRadioButton } from './logic/edit'
import type { FieldInfo } from './logic/spec'
import { useBuilder, widgetKey } from './store'

/** Adding and removing buttons of an existing radio group from the properties panel. */

export async function addRadioButtonAction(docId: string, field: FieldInfo): Promise<void> {
  const last = field.widgets[field.widgets.length - 1]
  if (!last) return
  const visualWidth = last.pageRotation === 90 || last.pageRotation === 270 ? last.rect.y2 - last.rect.y1 : last.rect.x2 - last.rect.x1
  const moved = nudge([{ id: 'n', rect: last.rect, rotation: last.pageRotation }], visualWidth + 18, 0).get('n')!
  const used = new Set(field.widgets.map((w) => w.value))
  let n = field.widgets.length + 1
  while (used.has(`Choice${n}`)) n++
  let index = field.widgets.length
  const ok = await runEdit(docId, `Add a button to “${field.name}”`, async (pdf) => {
    await addRadioButton(pdf, field.name, last.pageIndex, moved, `Choice${n}`)
    index = pdf.getForm().getRadioGroup(field.name).acroField.getWidgets().length - 1
  })
  if (ok) {
    useBuilder.getState().select(docId, [widgetKey(field.name, index)])
    useUi.getState().announce(`Radio button Choice${n} added to “${field.name}”. Move it into place with the arrow keys.`)
  }
}

export async function deleteRadioButtonAction(docId: string, field: FieldInfo, index: number): Promise<void> {
  const ok = await runEdit(docId, field.widgets.length <= 1 ? `Delete “${field.name}”` : `Remove a button from “${field.name}”`, (pdf) => deleteRadioButton(pdf, field.name, index))
  if (ok) {
    useBuilder.getState().select(docId, [])
    useUi.getState().announce('Radio button removed')
  }
}
