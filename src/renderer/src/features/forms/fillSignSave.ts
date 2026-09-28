import { PDFDocument } from 'pdf-lib'
import { editPdf } from '../../edit/session'
import { askConfirmChecked } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { registerBeforeSave } from '../api'
import { refreshAnnots, useAnnots } from '../markup/data'
import { flattenFillItems } from '../markup/pdf/flatten'

/**
 * Saving a document that has editable Fill & sign items (typed text, marks, signatures) asks whether to lock them into
 * the page: locked, they look the same in every reader and can't be moved or changed; kept editable, anyone who opens
 * the file can still move, restyle or delete them (as with Acrobat's Fill & Sign). "Don't ask again" remembers the
 * answer (setting `fillSignOnSave`; Edit ▸ When Saving Fill & Sign Items changes it).
 */

type Choice = 'lock' | 'keep'

async function hasFillItems(docId: string): Promise<boolean> {
  await refreshAnnots(docId)
  return !!useAnnots.getState().byDoc[docId]?.annots.some((a) => a.fillSign)
}

async function choose(): Promise<Choice | null> {
  const s = useTabs.getState().settings
  if (s.fillSignOnSave !== 'ask') return s.fillSignOnSave
  const { value, checked } = await askConfirmChecked({
    title: 'Lock filled-in items into the page?',
    message:
      'The text, marks and signatures you added with Fill & sign are still editable.\n\n' +
      'Lock them: they become part of the page and look the same in every reader, but can no longer be moved or changed.\n' +
      'Keep them editable: you (and anyone you send the file to) can still move, change or delete them.',
    buttons: [
      { label: 'Lock into page', value: 'lock', variant: 'primary' },
      { label: 'Keep editable', value: 'keep' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel',
    checkbox: 'Don’t ask again'
  })
  if (value !== 'lock' && value !== 'keep') return null
  if (checked) {
    const st = useTabs.getState()
    st.setSettings({ ...st.settings, fillSignOnSave: value })
    void window.epdf.setSetting({ key: 'fillSignOnSave', value })
    notify('info', `Filled-in items will be ${value === 'lock' ? 'locked into the page' : 'kept editable'} when saving. To change this: Edit ▸ When Saving Fill & Sign Items.`)
  }
  return value
}

registerBeforeSave(async (docId, mode) => {
  if (!(await hasFillItems(docId))) return true
  const choice = await choose()
  if (choice === null) return false
  if (choice === 'keep') return true
  if (mode === 'copy') {
    // Only the copy is locked; the open document keeps its editable items.
    return {
      transform: async (bytes) => {
        try {
          const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
          flattenFillItems(pdf)
          return await pdf.save()
        } catch (err) {
          notify('error', `The filled-in items could not be locked into the copy, so they stay editable in it: ${errorMessage(err)}`)
          return bytes
        }
      }
    }
  }
  try {
    await editPdf(docId, 'Lock filled-in items', (pdf) => {
      flattenFillItems(pdf)
    })
    return true
  } catch (err) {
    notify('error', `The filled-in items could not be locked into the page: ${errorMessage(err)}`)
    return false
  }
})
