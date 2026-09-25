/**
 * Hooks that let a feature (Security) take part in how document bytes enter and leave the edit pipeline,
 * without the pipeline knowing anything about encryption.
 *
 *   registerEditHooks({
 *     // A document can't be edited because it is encrypted: return its decrypted bytes (asking the user for
 *     // a password if needed), or null if the user declined / the password is wrong / editing is not permitted.
 *     decrypt: async (docId, encryptedBytes) => ...,
 *     // EVERY time document bytes leave the app's memory (Save, Save As, Save a Copy, the autosaved recovery
 *     // copy): return the bytes to write. Security re-encrypts here, so a protected document never reaches
 *     // disk (including the recovery folder) as plaintext.
 *     beforeWrite: async (docId, plainBytes) => ...,
 *   })
 */
export interface EditHooks {
  decrypt?(docId: string, bytes: Uint8Array): Promise<Uint8Array | null>
  beforeWrite?(docId: string, bytes: Uint8Array): Promise<Uint8Array>
}

const hooks: EditHooks[] = []

export function registerEditHooks(h: EditHooks): void {
  hooks.push(h)
}

/** First hook that can decrypt wins. Returns null if none could. */
export async function runDecrypt(docId: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const h of hooks) {
    const out = await h.decrypt?.(docId, bytes)
    if (out) return out
  }
  return null
}

/** Every `beforeWrite` hook runs, in registration order, each seeing the previous one's output. */
export async function runBeforeWrite(docId: string, bytes: Uint8Array): Promise<Uint8Array> {
  let out = bytes
  for (const h of hooks) if (h.beforeWrite) out = await h.beforeWrite(docId, out)
  return out
}

/** Test helper. */
export function _resetEditHooks(): void {
  hooks.length = 0
}
