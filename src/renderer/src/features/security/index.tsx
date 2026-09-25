import { activeTab } from '../../state/actions'
import { useTabs } from '../../state/tabs'
import { registerEditHooks } from '../../edit/hooks'
import { registerCommand, registerDialog } from '../api'
import { SecurityDialogs } from './Dialogs'
import { applyMarkerProtection } from './crypto/document'
import { installGates } from './gate'
import { forgetAccess, infoFlow, protectFlow, removeFlow, unlockForEditing } from './session'

/**
 * Feature: password protection (PDF standard security handler, AES-256 by default).
 *  - Opening an encrypted document uses PDF.js and its password prompt; editing it goes through the `decrypt` hook,
 *    which unlocks it in memory (asking again only if needed).
 *  - Every write (Save, Save As, Save a Copy, autosave recovery) goes through `beforeWrite`, which re-encrypts
 *    with the document's own protection, so a protected document never reaches disk as plaintext.
 *  - Tools: Protect with Password, Remove Password Protection, Document Properties ▸ Security.
 * Crypto lives in ./crypto (pure TypeScript, unit-tested in Node). See docs/features/security.md.
 */

registerEditHooks({
  decrypt: (docId, bytes) => unlockForEditing(docId, bytes),
  beforeWrite: (_docId, bytes) => applyMarkerProtection(bytes)
})

registerDialog(SecurityDialogs)

const withTab = (fn: (docId: string) => Promise<void>) => (): void => {
  const t = activeTab()
  if (t && t.status === 'ready') void fn(t.docId)
}

registerCommand({ id: 'security.protect', label: 'Protect with Password', run: withTab(protectFlow) })
registerCommand({ id: 'security.remove', label: 'Remove Password Protection', run: withTab(removeFlow) })
registerCommand({ id: 'security.info', label: 'Document Security', run: withTab(infoFlow) })

installGates()

// Forget what we know about a document when its tab closes.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const t of prev.tabs) if (!open.has(t.docId)) forgetAccess(t.docId)
})
