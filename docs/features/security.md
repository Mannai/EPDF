# Security: password protection

Protect a PDF with a **password to open** and/or a **password to edit** plus permission restrictions; open,
edit and re-save protected documents; change or remove the protection; inspect what a file uses.

Everything is implemented in-house in TypeScript (no qpdf, OpenSSL or any other program): the PDF standard
security handler, MD5, RC4, AES and the revision 6 hash. SHA-2 comes from WebCrypto (`crypto.subtle`, available
in the renderer and in Node).

Code: `src/renderer/src/features/security/` (UI and session logic), with the DOM-free crypto in `crypto/`
(unit-tested in Node), `src/shared/features/security.ts` (permission model, zod schema) and
`src/main/features/security/index.ts` (only the three menu items: no channel, no file access in main).

## Using it

**Tools**

| Item | Command | What it does |
|---|---|---|
| Protect with Password… | `security.protect` | Choose encryption, passwords and permissions. Nothing is written until you Save. On an already protected document the same item is **Change Password Protection** (asks for the owner password first). |
| Remove Password Protection… | `security.remove` | After a confirmation the document is saved without any protection. Needs the owner password. |
| Document Properties ▸ Security… | `security.info` | Read-only: algorithm, key length, security handler revision, whether it opens with an empty password, metadata encryption, each permission. |

There are no keyboard shortcuts; the items are in the menu and are ordinary commands other features can run.

**Encryption choices** (Protect dialog)

| Choice | PDF handler | Notes |
|---|---|---|
| AES-256 (default) | V5 / R6, Algorithm 2.B hash | PDF 2.0 handler; written as `%PDF-1.7` + Adobe `ExtensionLevel 8` for 1.x documents, like qpdf and Acrobat |
| AES-128 | V4 / R4, `AESV2` crypt filters | compatibility |
| RC4-128 | V2 / R3 | legacy compatibility, weak; the dialog says so |

Reading also supports RC4-40 (R2) and AES-256 revision 5 (the deprecated draft); Epdf never writes those.

**Passwords.** *Password to open* (user) and *password to edit* (owner) may be set independently. With only a
password to open, a random owner password nobody knows is used. With only a password to edit, the document
opens without a prompt but the restrictions (and owner-only actions) apply. Restricting anything requires a
password to edit (otherwise nobody could ever lift the restrictions). Passwords are never stored or logged and
Epdf cannot recover a forgotten one.

**Permissions.** Printing (none / low resolution / high resolution), copying text and images, editing content,
comments and form filling, page assembly, accessibility extraction. They map to the `/P` bits 3, 12, 5, 4,
6 + 9, 11 and 10.

### Opening and editing a protected document

* Opening uses PDF.js and the existing **Password required** dialog. A wrong password is rejected in place.
* Editing (any feature that calls `editPdf` / `ensureEditable`) goes through the `decrypt` edit hook. It reuses
  the password PDF.js accepted (kept **in memory only**, per document, and forgotten when the tab closes), then
  the empty password, and only then asks with its own dialog (wrong password: retry; Cancel: nothing changes).
  The unlock is not an undo step and does not mark the document unsaved.
* **Every write** (Save, Save As, Save a Copy and the autosaved recovery copy) goes through `bytesForWriting` →
  the `beforeWrite` hook, which re-encrypts with the document's original passwords/permissions, so a protected
  document never reaches disk (including the recovery folder) as plaintext. The file encryption key and the
  original `/O /U /OE /UE /Perms /P /ID` are carried, so the *same passwords* keep working; only random IVs change.
* **Permissions are respected.** Opened with the **user** password only:
  * editing needs the "modify content" permission (`/P` bit 4). If it is off the unlock hook refuses with a clear
    message (`decrypt` returns `null`) and `editPdf` throws its usual "password protected" error. Open the file
    with the owner password to edit. (Deliberately strict: annotate-only / form-fill-only documents are also
    refused, because the hook cannot tell what kind of edit is coming.)
  * **Print** (File ▸ Print…, Print to PDF) and **export** (Word/Excel/PowerPoint) refuse with a notification when
    printing / copying is off; **Copy** of page text is cancelled with a notification. Low-resolution-only
    printing is treated as allowed. Opened with the owner password, everything is allowed.
* **Change / remove** = an ordinary edit (`editPdf`): one undo step ("Undo Change password protection",
  "Undo Remove password protection"). After removing, saving writes a plain file.

## How it works (for maintainers)

* `crypto/handler.ts`: password encoding (Latin-1 / UTF-8 candidates for R≤4; SASLprep + 127-byte truncation
  for R5/6), Algorithms 2/3/4/5/6/7 (MD5 based), 2.A/2.B (R5/R6), per-object keys (Algorithm 1/1.A), and
  `createProtection`.
* `crypto/document.ts`: pdf-lib's parser reads the file sequentially, so we hook the one method that turns
  `n g obj … endobj` into an object, decrypt strings and streams there (object streams are decrypted *first* and
  then expanded, their inner strings are not decrypted again), and skip the `/Encrypt` dictionary, XRef streams
  and signature `/Contents`. Crypt filters: `/Identity` and named filters on a stream's own `/Filter [/Crypt]`, `/StmF`, `/StrF`,
  `/EncryptMetadata false`. Encryption is the mirror image and serialises with a classic xref table.
* `crypto/aes.ts` is a synchronous table-driven AES (strings and per-object keys make WebCrypto round trips
  slow); `crypto/bulk.ts` uses WebCrypto for streams ≥ 512 KiB (with a padding trick because WebCrypto insists on
  valid PKCS#7) and processes RC4 in slices that yield to the event loop.
* **The protection marker.** Undo/redo history holds plaintext snapshots, so a snapshot must say by itself whether
  and how it is protected. A raw (never compressed, never in an object stream) stream referenced from the
  catalog (`/EpdfSecurity`) carries the encryption parameters and the file key. `beforeWrite` finds it with a cheap
  byte search (`hasMarker`), removes it and encrypts. Snapshots without a marker (including an encrypted original
  that was never unlocked) are written unchanged, so nothing is ever double-encrypted. The marker lives in memory
  snapshots only; it is never written to disk by the normal save paths (a feature that writes `currentBytes`
  directly instead of `bytesForWriting` would write a plaintext copy *with* the marker: use `bytesForWriting`).

## Threat model: what this does and does not protect

* **Protects:** the *password to open* with AES-256 (or AES-128) keeps the content unreadable to anyone who
  gets the file without the password: the file on disk, in the autosave/recovery folder and in copies you save
  is encrypted. Password checks compare in constant time and fail after a fixed amount of work, so a wrong password reveals nothing about how much of it matched.
* **Does not protect:**
  * **Permissions are advisory.** Print/copy/edit restrictions are flags in the file. Whoever can open the
    document holds the key: software that ignores the flags (many do), or a person with a debugger, can do
    everything. Epdf honours them in its own UI as described above, but they are not a security boundary.
  * Anyone who knows the password to open can read *and copy* the content; the password to edit only gates
    changing the protection.
  * RC4 and AES-128 files are weaker (RC4-128 has known weaknesses; revision ≤ 4 passwords are hashed with MD5 and
    are cheap to brute-force offline). Use AES-256 with a long random password.
  * Weak passwords are weak: revision 6 slows guessing down but cannot save a short password.
  * While a document is open, its plaintext and key are in memory (and PDF.js sees plaintext). The protection is
    of the file at rest / in transit, not of a running process.
  * Metadata unless "Encrypt document metadata" is on (file names, page count and file size are always visible).
  * Other features that create *new* files from a protected document (extract/split/combine/export) produce
    unprotected output unless you protect that output.

## Limits and known gaps

* Certificate (public-key) encryption is not supported: PDF.js cannot open such files either, and Epdf reports that the security handler is not supported if an edit reaches one.
* Files are written with a classic cross-reference table and **no object streams** (larger for documents that
  had them). Encrypted object streams are read fine.
* Memory: unlocking or encrypting a 90 MB document uses roughly 5–6 copies transiently (about 600 MB peak in the
  performance check); 90 MB takes ≈ 1.3 s to encrypt and ≈ 0.5 s to decrypt in Node.
* Editing needs the *modify content* permission (strict, see above); low-resolution print is not enforced as
  low resolution.
* Signatures: an encrypted signed document can be unlocked and read; editing (and therefore re-encrypting) a
  signed document invalidates its signatures like any edit.

## Manual test

1. Open a PDF, **Tools ▸ Protect with Password…**, password to open `abc`, confirm, **Protect**, **Save**.
   Close and reopen: the *Password required* dialog appears; a wrong password is rejected, `abc` opens it.
2. Rotate a page, wait 15 s (or set `EPDF_AUTOSAVE_MS=300`), look in `<userData>/recovery`: the file is
   encrypted (open it in a hex viewer: no readable text, `/Encrypt` present). Save: the file stays protected.
3. **Tools ▸ Document Properties ▸ Security…** shows AES-256, permissions and "No: a password is required".
4. **Tools ▸ Protect with Password…** again on the protected document: asks for the owner password only if the
   window was opened with the user password; change the passwords; Save; only the new ones work.
5. **Tools ▸ Remove Password Protection…**, confirm, Save: the file opens without a prompt; **Undo** before saving
   brings the protection back.
6. Open `tests/fixtures/security/no-permissions-aes256.pdf` with `u256p`: rotating shows the "permissions do
   not allow" message, File ▸ Print… and copying refuse. Reopen with `o256p` (owner): all work.
7. Independent check (optional, dev machine): `qpdf --password=… --check file.pdf` and `--show-encryption`.

## Fixtures and passwords

`tests/fixtures/security/` holds files produced by **qpdf 12.4.1** (an independent implementation) from one
plaintext source, with the passwords in `README.txt` (regenerate with `node tests/fixtures/security.mjs`):

| File | user | owner |
|---|---|---|
| `rc4-40` | `user40` | `owner40` |
| `rc4-128` | `user128` | `owner128` |
| `aes-128` | `userAes` | `ownerAes` |
| `aes-256-r6` | `user256` | `owner256` |
| `aes-256-r5` | `user5` | `owner5` |
| `user-only` | `onlyuser` | (unknown) |
| `owner-only` | *(empty)* | `onlyowner` |
| `no-permissions-aes128` / `-aes256` | `u128` / `u256p` | `o128` / `o256p` |
| `lowres-print-rc4-128` | `ulow` | `olow` |
| `cleartext-metadata-aes128` / `-aes256` (EncryptMetadata false) | `umeta` / `umeta6` | `ometa` / `ometa6` |
| `objstm-aes256` / `-aes128` / `-rc4-128` (encrypted object streams) | `userObj` | `ownerObj` |
| `unicode-password-aes256` | `pässö€` | `oüw` |
| `latin1-password-rc4-128` | `pässö` | `oüw` |
| `plain.pdf` | (unencrypted source) | |

## Tests

* `tests/unit/security-primitives.test.ts`: MD5 (RFC 1321), RC4, AES (FIPS-197, SP 800-38A) vectors, cross-checked against Node crypto.
* `tests/unit/security-fixtures.test.ts`: every qpdf fixture decrypts to the known plaintext with the user and the owner password; wrong passwords fail.
* `tests/unit/security-encrypt.test.ts`: files we encrypt open in PDF.js (legacy build) with the passwords and `qpdf --check` / `--show-encryption` agree (skipped without qpdf).
* `tests/unit/security-edge.test.ts`: hand-assembled files (Identity crypt filter, `/StrF /Identity`, direct `/Encrypt`, incremental update), bulk AES paths, the protection marker, failure modes.
* `tests/unit/security-fuzz.test.ts`: 200 seeded random documents/passwords/permissions/algorithms round-trip object for object; Algorithm 2.B against an independent Node-crypto implementation; SASLprep and password limits; `/P` mapping.
* `tests/unit/security-logic.test.ts`: permission decisions and the info dialog content.
* `tests/e2e/security.spec.ts`: the UI flows end to end, including the on-disk and recovery-folder checks, permissions, cancel paths and axe scans (light and dark).
