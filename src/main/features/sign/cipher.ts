/**
 * The only thing the signature store needs from the OS secret storage. Electron's `safeStorage` is one
 * implementation; tests use a fake. There is deliberately NO plain-text implementation.
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Uint8Array
  decrypt(cipher: Uint8Array): string
}

/** Minimal shape of Electron's `safeStorage` (so this module never imports `electron` itself). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

/**
 * Wraps `safeStorage`. Availability is asked on every call (it can only become true after `app.ready`,
 * and tests flip it at run time).
 */
export function safeStorageCipher(getSafeStorage: () => SafeStorageLike): SecretCipher {
  return {
    isAvailable: () => {
      try {
        return getSafeStorage().isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain) => getSafeStorage().encryptString(plain),
    decrypt: (cipher) => getSafeStorage().decryptString(Buffer.from(cipher))
  }
}
