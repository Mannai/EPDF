import { safeStorage } from 'electron'
import { z } from 'zod'
import {
  DeleteSignatureRequestSchema,
  ListSignaturesRequestSchema,
  SaveSignatureRequestSchema,
  type SaveSignatureResult,
  type SignatureRecord,
  type SignatureStatus
} from '../../../shared/features/sign'
import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'
import { safeStorageCipher } from './cipher'
import { EncryptionUnavailableError, SignatureStore, SignatureStoreError } from './store'

/**
 * Visual signatures: saved (encrypted) signature images. Channels `sign:list`, `sign:save`, `sign:delete`
 * and `sign:status`. The renderer never sees ciphertext and main never writes a plain image to disk.
 * Expected failures (no secure storage, too many signatures) come back as `{ ok: false, message }` so the
 * UI can show them verbatim instead of an IPC error.
 */
export function register(ctx: MainContext): void {
  const store = new SignatureStore(
    ctx.repos.db,
    safeStorageCipher(() => safeStorage)
  )

  registerFeatureChannel('sign:status', z.object({}).optional(), (): SignatureStatus => ({ encryptionAvailable: store.encryptionAvailable }))

  registerFeatureChannel('sign:list', ListSignaturesRequestSchema, (): SignatureRecord[] => store.list())

  registerFeatureChannel('sign:save', SaveSignatureRequestSchema, (req): SaveSignatureResult => {
    try {
      return { ok: true, id: store.save(req) }
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) return { ok: false, code: 'encryption-unavailable', message: err.message }
      if (err instanceof SignatureStoreError) return { ok: false, code: 'rejected', message: err.message }
      throw err
    }
  })

  registerFeatureChannel('sign:delete', DeleteSignatureRequestSchema, ({ id }) => ({ deleted: store.delete(id) }))

  contributeMenu({
    menu: 'Tools',
    items: () => [
      { type: 'separator' },
      commandItem('Signatures…', 'sign.manage'),
      commandItem('Sign Document', 'sign.activate'),
      commandItem('Add Initials', 'sign.activateInitials')
    ]
  })
}
