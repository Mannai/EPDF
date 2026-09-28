import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../src/main/db/migrations'
import { safeStorageCipher, type SecretCipher } from '../../src/main/features/sign/cipher'
import { EncryptionUnavailableError, SignatureStore, SignatureStoreError } from '../../src/main/features/sign/store'
import {
  DeleteSignatureRequestSchema,
  MAX_SIGNATURES,
  MAX_SIGNATURE_BYTES,
  SaveSignatureRequestSchema,
  looksLikePng,
  type SaveSignatureRequest
} from '../../src/shared/features/sign'

/** A recognisably-not-plain cipher: XOR with a key, then a marker prefix. Stands in for safeStorage. */
function fakeCipher(): SecretCipher & { available: boolean } {
  const key = 0x5a
  const c = {
    available: true,
    isAvailable: () => c.available,
    encrypt: (plain: string) => Uint8Array.from([0x76, 0x31, 0x30, ...Buffer.from(plain, 'utf8').map((b) => b ^ key)]),
    decrypt: (cipher: Uint8Array) => {
      if (cipher[0] !== 0x76) throw new Error('bad ciphertext')
      return Buffer.from(cipher.subarray(3).map((b) => b ^ key)).toString('utf8')
    }
  }
  return c
}

/** A tiny but valid 1x1 PNG. */
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
)

const req = (over: Partial<SaveSignatureRequest> = {}): SaveSignatureRequest => ({ name: 'Mine', kind: 'signature', method: 'draw', png: PNG, width: 1, height: 1, ...over })

let db: Database.Database
let cipher: ReturnType<typeof fakeCipher>
let store: SignatureStore
beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  cipher = fakeCipher()
  store = new SignatureStore(db, cipher)
})

describe('migration 3', () => {
  it('adds the signatures table as the third, gap-free migration', () => {
    expect(MIGRATIONS.find((m) => m.version === 3)?.sql).toContain('CREATE TABLE signatures')
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    const cols = (db.prepare("PRAGMA table_info('signatures')").all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['id', 'name', 'kind', 'method', 'width', 'height', 'image', 'created_at'])
  })

  it('only allows the two kinds', () => {
    expect(() => db.prepare("INSERT INTO signatures (name, kind, width, height, image, created_at) VALUES ('x', 'stamp', 1, 1, x'00', 0)").run()).toThrow()
  })
})

describe('SignatureStore', () => {
  it('round-trips a signature through encryption', () => {
    const id = store.save(req({ name: 'Ada' }), 1000)
    const [rec] = store.list()
    expect(rec).toMatchObject({ id, name: 'Ada', kind: 'signature', method: 'draw', width: 1, height: 1, createdAt: 1000 })
    expect(Buffer.from(rec.png).equals(Buffer.from(PNG))).toBe(true)
  })

  it('never stores the image in the clear (not as PNG bytes, not as base64)', () => {
    store.save(req())
    const raw = (db.prepare('SELECT image FROM signatures').get() as { image: Buffer }).image
    expect(looksLikePng(raw)).toBe(false)
    expect(raw.includes(Buffer.from(PNG))).toBe(false)
    expect(raw.toString('latin1')).not.toContain('iVBORw0KGgo') // base64 of the PNG header
    expect(raw.includes(Buffer.from([0x49, 0x48, 0x44, 0x52]))).toBe(false) // "IHDR" chunk name
  })

  it('refuses to save when encryption is unavailable, and stores nothing', () => {
    cipher.available = false
    expect(store.encryptionAvailable).toBe(false)
    expect(() => store.save(req())).toThrow(EncryptionUnavailableError)
    expect((db.prepare('SELECT COUNT(*) AS n FROM signatures').get() as { n: number }).n).toBe(0)
  })

  it('still lists (and deletes) what was saved earlier when encryption goes away', () => {
    const id = store.save(req())
    cipher.available = false
    expect(store.list()).toHaveLength(1)
    expect(store.delete(id)).toBe(true)
  })

  it('rejects data that is not a PNG', () => {
    expect(() => store.save(req({ png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }))).toThrow(SignatureStoreError)
  })

  it('enforces the maximum number of signatures', () => {
    for (let i = 0; i < MAX_SIGNATURES; i++) store.save(req({ name: `s${i}` }))
    expect(() => store.save(req())).toThrow(/up to 24/)
  })

  it('lists newest first and deletes by id', () => {
    const a = store.save(req({ name: 'old' }), 1)
    const b = store.save(req({ name: 'new', kind: 'initials' }), 2)
    expect(store.list().map((r) => r.id)).toEqual([b, a])
    expect(store.delete(a)).toBe(true)
    expect(store.delete(a)).toBe(false)
    expect(store.list().map((r) => r.name)).toEqual(['new'])
  })

  it('skips rows it cannot decrypt (another OS user’s keyring) instead of failing', () => {
    store.save(req({ name: 'ok' }))
    db.prepare("INSERT INTO signatures (name, kind, method, width, height, image, created_at) VALUES ('alien', 'signature', 'draw', 1, 1, x'0102030405', 5)").run()
    expect(store.list().map((r) => r.name)).toEqual(['ok'])
  })
})

describe('safeStorageCipher', () => {
  it('delegates to the OS store and reads availability on every call', () => {
    let available = false
    const calls: string[] = []
    const c = safeStorageCipher(() => ({
      isEncryptionAvailable: () => available,
      encryptString: (s) => {
        calls.push('enc')
        return Buffer.from(`E(${s})`)
      },
      decryptString: (b) => {
        calls.push('dec')
        return b.toString().slice(2, -1)
      }
    }), 'win32')
    expect(c.isAvailable()).toBe(false)
    available = true
    expect(c.isAvailable()).toBe(true)
    expect(c.decrypt(c.encrypt('secret'))).toBe('secret')
    expect(calls).toEqual(['enc', 'dec'])
  })

  it('reports unavailable if safeStorage itself throws', () => {
    const c = safeStorageCipher(() => {
      throw new Error('not ready')
    })
    expect(c.isAvailable()).toBe(false)
  })

  it('Linux: a real keyring counts; the basic_text fallback (a key built into Chromium) does not', () => {
    const store = (backend?: string) => ({
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
      ...(backend ? { getSelectedStorageBackend: () => backend } : {})
    })
    expect(safeStorageCipher(() => store('gnome_libsecret'), 'linux').isAvailable()).toBe(true)
    expect(safeStorageCipher(() => store('kwallet6'), 'linux').isAvailable()).toBe(true)
    expect(safeStorageCipher(() => store('basic_text'), 'linux').isAvailable()).toBe(false)
    expect(safeStorageCipher(() => store(), 'linux').isAvailable()).toBe(false) // backend unknown: not trusted
    expect(safeStorageCipher(() => store(), 'darwin').isAvailable()).toBe(true) // the question only exists on Linux
  })
})

describe('channel schemas (size limits)', () => {
  it('accepts a normal request and trims the name', () => {
    const r = SaveSignatureRequestSchema.parse({ ...req(), name: '  Ada  ' })
    expect(r.name).toBe('Ada')
  })

  it('rejects oversize images, bad dimensions, empty names, unknown kinds and non-bytes', () => {
    const bad = (o: object): boolean => SaveSignatureRequestSchema.safeParse({ ...req(), ...o }).success
    expect(bad({ png: new Uint8Array(MAX_SIGNATURE_BYTES + 1) })).toBe(false)
    expect(bad({ png: new Uint8Array(0) })).toBe(false)
    expect(bad({ png: 'not bytes' })).toBe(false)
    expect(bad({ width: 0 })).toBe(false)
    expect(bad({ width: 100000 })).toBe(false)
    expect(bad({ height: 1.5 })).toBe(false)
    expect(bad({ name: '   ' })).toBe(false)
    expect(bad({ name: 'x'.repeat(61) })).toBe(false)
    expect(bad({ kind: 'stamp' })).toBe(false)
    expect(bad({ method: 'telepathy' })).toBe(false)
    expect(bad({})).toBe(true)
  })

  it('validates delete requests', () => {
    expect(DeleteSignatureRequestSchema.safeParse({ id: 3 }).success).toBe(true)
    expect(DeleteSignatureRequestSchema.safeParse({ id: 0 }).success).toBe(false)
    expect(DeleteSignatureRequestSchema.safeParse({ id: '3' }).success).toBe(false)
  })
})
