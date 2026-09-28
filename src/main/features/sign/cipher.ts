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
  /** Linux only: which secret store backs the key ('gnome_libsecret', 'kwallet5', ... or 'basic_text'). */
  getSelectedStorageBackend?(): string
}

/**
 * Wraps `safeStorage`. Availability is asked on every call (it can only become true after `app.ready`,
 * and tests flip it at run time). On Linux without a keyring (GNOME Keyring, KWallet), Electron falls back to
 * `basic_text`: "encryption" with a key built into Chromium, which protects nothing. That counts as unavailable.
 */
export function safeStorageCipher(getSafeStorage: () => SafeStorageLike, platform: NodeJS.Platform = process.platform): SecretCipher {
  return {
    isAvailable: () => {
      try {
        const s = getSafeStorage()
        if (!s.isEncryptionAvailable()) return false
        return platform !== 'linux' || (s.getSelectedStorageBackend?.() ?? 'basic_text') !== 'basic_text'
      } catch {
        return false
      }
    },
    encrypt: (plain) => getSafeStorage().encryptString(plain),
    decrypt: (cipher) => getSafeStorage().decryptString(Buffer.from(cipher))
  }
}
