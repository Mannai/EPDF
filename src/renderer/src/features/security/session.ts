import { PDFDocument } from 'pdf-lib'
import { permissionsToP, pToPermissions, type ProtectSettings } from '@shared/features/security'
import { currentBytes, editPdf, ensureEditable, isDirty } from '../../edit/session'
import { getAcceptedPassword } from '../../pdf/docCache'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { decryptDocument, embedMarker, hasMarker, inspectEncryption, makeProtection, readMarker, removeMarker } from './crypto/document'
import { authenticate, type Access, type EncryptionInfo, type Protection } from './crypto/handler'
import { DEFAULT_SETTINGS, algorithmOf, describeProtection, mayEdit, type DocAccess } from './logic'
import { useInfoDialog, usePasswordPrompt, useProtectDialog } from './store'

/**
 * The Security feature's document logic: unlocking encrypted documents for editing, protecting, changing and
 * removing protection, and the info dialog. Everything about a document's protection is kept in memory only:
 *  - in the plaintext snapshots themselves, as a "protection marker" (see crypto/document.ts), so undo/redo/recovery
 *    stay consistent and `beforeWrite` knows how to re-encrypt, and
 *  - in `accessByDoc`, which password level (owner/user) opened the document in this window.
 */

const accessByDoc = new Map<string, DocAccess>()

export const getAccess = (docId: string): DocAccess | undefined => accessByDoc.get(docId)
export const setAccess = (docId: string, a: DocAccess): void => void accessByDoc.set(docId, a)
export const forgetAccess = (docId: string): void => void accessByDoc.delete(docId)

const tabName = (docId: string): string => useTabs.getState().tabs.find((t) => t.docId === docId)?.name ?? 'This document'

type Purpose = 'edit' | 'owner'

/**
 * Finds a password that opens the document: the one PDF.js already accepted, then the empty password, and only
 * then asks the user (repeating on a wrong password until they cancel). For `owner` the password must be the owner's.
 */
async function obtainAccess(docId: string, info: EncryptionInfo, purpose: Purpose): Promise<Access | null> {
  const good = (a: Access | null): a is Access => !!a && (purpose === 'edit' || a.kind === 'owner')
  const silent = new Set<string>()
  for (const pw of [getAcceptedPassword(docId), '']) {
    if (pw === undefined || silent.has(pw)) continue
    silent.add(pw)
    const a = await authenticate(info, pw)
    if (good(a)) return a
  }
  const name = tabName(docId)
  let incorrect = false
  for (;;) {
    const pw = await usePasswordPrompt.getState().ask({
      title: purpose === 'owner' ? 'Owner password required' : 'Password required to edit',
      message:
        purpose === 'owner'
          ? `Changing or removing the protection of “${name}” needs its owner (permissions) password.`
          : `“${name}” is password protected. Enter its password to edit it.`,
      incorrect,
      confirmLabel: purpose === 'owner' ? 'Continue' : 'Unlock'
    })
    if (pw === null) return null
    const a = await authenticate(info, pw)
    if (good(a)) return a
    incorrect = true
  }
}

/**
 * The `decrypt` edit hook: unlock an encrypted document for editing. Returns the plaintext (carrying the protection
 * marker, so saving re-encrypts it with the document's own settings) or null if the user cancels, the file uses
 * unsupported encryption, or its permissions forbid editing.
 */
export async function unlockForEditing(docId: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  let probe
  try {
    probe = await inspectEncryption(bytes)
  } catch (err) {
    notify('error', errorMessage(err))
    return null
  }
  if (!probe) return null
  const access = await obtainAccess(docId, probe.info, 'edit')
  if (!access) return null
  setAccess(docId, { kind: access.kind, P: probe.info.P, R: probe.info.R })
  if (!mayEdit(access.kind, probe.info.P)) {
    notify(
      'error',
      `“${tabName(docId)}” can’t be edited: its permissions do not allow changing the document. Open it with the owner password to edit it.`
    )
    return null
  }
  try {
    const plain = await decryptDocument(bytes, probe, access, { info: probe.info, key: access.key })
    // A tab whose open-password prompt was cancelled shows an error; now that the document is unlocked, let it load.
    if (useTabs.getState().tabs.find((t) => t.docId === docId)?.status === 'error') useTabs.getState().contentChanged(docId)
    return plain
  } catch (err) {
    notify('error', `Couldn’t unlock “${tabName(docId)}”: ${errorMessage(err)}`)
    return null
  }
}

async function currentProtection(docId: string): Promise<Protection | null> {
  const bytes = await currentBytes(docId)
  if (!hasMarker(bytes)) return null
  return readMarker(await PDFDocument.load(bytes, { updateMetadata: false }))
}

async function ensureOwner(docId: string, prot: Protection): Promise<boolean> {
  if (getAccess(docId)?.kind === 'owner') return true
  const access = await obtainAccess(docId, prot.info, 'owner')
  if (!access) return false
  setAccess(docId, { kind: 'owner', P: prot.info.P, R: prot.info.R })
  return true
}

/** Tools ▸ Protect with Password… (also used to change the passwords/permissions of a protected document). */
export async function protectFlow(docId: string): Promise<void> {
  try {
    if (!(await ensureEditable(docId))) return
    const current = await currentProtection(docId)
    if (current && !(await ensureOwner(docId, current))) return
    const initial: ProtectSettings = current
      ? {
          algorithm: algorithmOf(current.info),
          userPassword: '',
          ownerPassword: '',
          permissions: pToPermissions(current.info.P, current.info.R),
          encryptMetadata: current.info.encryptMetadata
        }
      : DEFAULT_SETTINGS
    const settings = await useProtectDialog.getState().ask({ docId, fileName: tabName(docId), changing: !!current, initial })
    if (!settings) return
    await editPdf(docId, current ? 'Change password protection' : 'Protect with password', async (pdf) => {
      const protection = await makeProtection(pdf, {
        algorithm: settings.algorithm,
        userPassword: settings.userPassword,
        ownerPassword: settings.ownerPassword,
        P: permissionsToP(settings.permissions),
        encryptMetadata: settings.encryptMetadata
      })
      embedMarker(pdf, protection)
    })
    // The person who just chose the passwords has full control in this window.
    const after = await currentProtection(docId)
    if (after) setAccess(docId, { kind: 'owner', P: after.info.P, R: after.info.R })
    notify('success', 'Password protection set. Save the document to apply it to the file.')
  } catch (err) {
    notify('error', `Couldn’t protect the document: ${errorMessage(err)}`)
  }
}

/** Tools ▸ Remove Password Protection… */
export async function removeFlow(docId: string): Promise<void> {
  try {
    if (!(await ensureEditable(docId))) return
    const current = await currentProtection(docId)
    if (!current) {
      notify('info', `“${tabName(docId)}” is not password protected.`)
      return
    }
    if (!(await ensureOwner(docId, current))) return
    const choice = await askConfirm({
      title: 'Remove password protection?',
      message: `“${tabName(docId)}” will be saved without any password or restrictions. Anyone who gets the file will be able to read and change it.`,
      buttons: [
        { label: 'Remove Protection', value: 'remove', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (choice !== 'remove') return
    await editPdf(docId, 'Remove password protection', (pdf) => {
      removeMarker(pdf)
    })
    forgetAccess(docId)
    notify('success', 'Password protection removed. Save the document to write it without protection.')
  } catch (err) {
    notify('error', `Couldn’t remove the protection: ${errorMessage(err)}`)
  }
}

/** Tools ▸ Document Properties ▸ Security… */
export async function infoFlow(docId: string): Promise<void> {
  try {
    const bytes = await currentBytes(docId)
    let info: EncryptionInfo | null = null
    if (hasMarker(bytes)) info = (await currentProtection(docId))?.info ?? null
    else info = (await inspectEncryption(bytes))?.info ?? null
    useInfoDialog.getState().show(await describeProtection(tabName(docId), info, { unsaved: isDirty(docId), access: getAccess(docId) }))
  } catch (err) {
    notify('error', `Couldn’t read the document’s security settings: ${errorMessage(err)}`)
  }
}
