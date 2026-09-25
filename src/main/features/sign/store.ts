import type Database from 'better-sqlite3'
import {
  MAX_SIGNATURES,
  looksLikePng,
  type SaveSignatureRequest,
  type SignatureKind,
  type SignatureMethod,
  type SignatureRecord
} from '../../../shared/features/sign'
import type { SecretCipher } from './cipher'

export class SignatureStoreError extends Error {}

/** Thrown when the OS cannot protect secrets. Signatures are never stored unencrypted. */
export class EncryptionUnavailableError extends SignatureStoreError {
  constructor() {
    super(
      'Your system’s secure storage is not available, so signatures can’t be saved safely. ' +
        'Epdf never stores a signature without encryption. On Linux, install and unlock a keyring ' +
        '(for example GNOME Keyring or KWallet) and try again.'
    )
  }
}

interface Row {
  id: number
  name: string
  kind: SignatureKind
  method: SignatureMethod
  width: number
  height: number
  image: Buffer
  created_at: number
}

/**
 * Saved signatures. The PNG is base64-encoded and encrypted with the OS secret store before it reaches
 * SQLite, so the database file (and its backups) never contain the image in the clear.
 */
export class SignatureStore {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: SecretCipher
  ) {}

  get encryptionAvailable(): boolean {
    return this.cipher.isAvailable()
  }

  list(): SignatureRecord[] {
    const rows = this.db.prepare('SELECT * FROM signatures ORDER BY created_at DESC, id DESC').all() as Row[]
    const out: SignatureRecord[] = []
    for (const r of rows) {
      let png: Uint8Array
      try {
        png = Buffer.from(this.cipher.decrypt(r.image), 'base64')
      } catch {
        continue // written by another user account / keyring: unreadable here, skip rather than fail the list
      }
      if (!looksLikePng(png)) continue
      out.push({ id: r.id, name: r.name, kind: r.kind, method: r.method, width: r.width, height: r.height, createdAt: r.created_at, png })
    }
    return out
  }

  save(req: SaveSignatureRequest, now = Date.now()): number {
    if (!this.cipher.isAvailable()) throw new EncryptionUnavailableError()
    if (!looksLikePng(req.png)) throw new SignatureStoreError('The signature image is not a valid PNG.')
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM signatures').get() as { n: number }).n
    if (count >= MAX_SIGNATURES) {
      throw new SignatureStoreError(`You can keep up to ${MAX_SIGNATURES} signatures. Delete one to add another.`)
    }
    const image = Buffer.from(this.cipher.encrypt(Buffer.from(req.png).toString('base64')))
    const info = this.db
      .prepare('INSERT INTO signatures (name, kind, method, width, height, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.name, req.kind, req.method, req.width, req.height, image, now)
    return Number(info.lastInsertRowid)
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM signatures WHERE id = ?').run(id).changes > 0
  }
}
