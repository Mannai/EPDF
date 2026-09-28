import { shortcutLabel } from '../features/keys'
import { askConfirmChecked } from './confirm'
import { notify } from './notify'
import { useTabs } from './tabs'

/**
 * Delete / Backspace on something selected on a page (a comment, shape, stamp, link, form field, image, redaction
 * mark) asks first. "Don't ask again" turns the question off (setting `confirmDelete`); Edit ▸ Ask Before Deleting
 * turns it back on. Deleting from a right-click menu doesn't ask: choosing "Delete" there is already deliberate.
 * Resolves true when the caller should delete.
 */
export async function confirmDelete(what: string, message = `You can undo this with ${shortcutLabel('Ctrl+Z')}.`): Promise<boolean> {
  if (!useTabs.getState().settings.confirmDelete) return true
  const { value, checked } = await askConfirmChecked({
    title: `Delete ${what}?`,
    message,
    buttons: [
      { label: 'Delete', value: 'delete', variant: 'danger' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel',
    checkbox: 'Don’t ask again'
  })
  if (value !== 'delete') return false
  if (checked) {
    const s = useTabs.getState()
    s.setSettings({ ...s.settings, confirmDelete: false })
    void window.epdf.setSetting({ key: 'confirmDelete', value: false })
    notify('info', 'Epdf won’t ask before deleting any more. To turn it back on: Edit ▸ Ask Before Deleting.')
  }
  return true
}
