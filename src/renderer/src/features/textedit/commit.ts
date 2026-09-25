import { EditError, editPdf } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import { fontLoader } from './fontLoader'
import { EditRefusedError } from './pdfcontent/write'
import { applyTextEdit, type TextEditResult } from './pdfcontent/textEdit'
import { isTextEditChanged, useTextEdit } from './state'

/**
 * Commits the open inline edit as one undo step ("Edit text"). On refusal or failure the document is left
 * unchanged and the editor stays open so the user can adjust the text.
 */
export async function commitTextEdit(): Promise<void> {
  const st = useTextEdit.getState()
  const ed = st.editing
  if (!ed || st.busy) return
  if (!isTextEditChanged(ed)) {
    st.end()
    return
  }
  st.setBusy(true)
  try {
    let result: TextEditResult | undefined
    await editPdf(ed.docId, 'Edit text', async (pdf) => {
      result = await applyTextEdit(
        pdf,
        ed.pageIndex,
        {
          blockId: ed.blockId,
          oldText: ed.oldText,
          newText: ed.text,
          size: Math.abs(ed.size - ed.origSize) > 0.005 ? ed.size : undefined,
          color: ed.color.toLowerCase() !== ed.origColor.toLowerCase() ? ed.color : undefined
        },
        fontLoader
      )
    })
    if (useTextEdit.getState().editing === ed) useTextEdit.getState().end()
    if (result) notify(result.strategy === 'fallback-font' ? 'info' : 'success', result.message)
  } catch (err) {
    const message = err instanceof EditRefusedError || err instanceof EditError ? err.message : `Couldn’t edit the text: ${errorMessage(err)}`
    notify('error', message)
  } finally {
    useTextEdit.getState().setBusy(false)
  }
}

export function cancelTextEdit(): void {
  useTextEdit.getState().end()
}
