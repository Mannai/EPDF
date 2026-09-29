import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import type { DocHandle } from '../../shared/types'
import { identityOf, sameIdentity, sweepStaleTemps, type FileIdentity } from './fileService'

interface Entry {
  handle: DocHandle
  refs: number
  /** The file as Epdf last read or wrote it: a save expects to find exactly this on disk. */
  identity: FileIdentity
  watcher?: FSWatcher
  timer?: NodeJS.Timeout
  /** A save of ours is in progress: file events are ours, not someone else's. */
  writing: number
}

export class InvalidPdfError extends Error {}

/** Verifies the file exists, is a regular file, and starts with a PDF header. */
export async function validatePdfFile(path: string): Promise<{ size: number; mtime: number; identity: FileIdentity }> {
  const st = await stat(path).catch(() => null)
  if (!st) throw new InvalidPdfError('The file no longer exists.')
  if (!st.isFile()) throw new InvalidPdfError('This is not a file.')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    // The spec allows the header anywhere in the first 1024 bytes.
    if (!buf.subarray(0, bytesRead).includes('%PDF-')) throw new InvalidPdfError('This file is not a valid PDF.')
  } finally {
    await fh.close()
  }
  return { size: st.size, mtime: st.mtimeMs, identity: identityOf(st) }
}

/**
 * Maps opaque document ids to on-disk paths. The renderer never supplies a path when reading
 * bytes; it can only ask for a docId that main previously issued.
 */
export class DocRegistry {
  private docs = new Map<string, Entry>()
  private byPath = new Map<string, string>()

  constructor(
    private onChangedOnDisk: (docId: string) => void,
    private debounceMs = 400
  ) {}

  /** Registers (or adds a reference to) a document. Every returned handle owns one reference. */
  async register(path: string, lastPage?: number): Promise<DocHandle> {
    const { size, mtime, identity } = await validatePdfFile(path)
    const existing = this.byPath.get(path)
    if (existing) {
      const e = this.docs.get(existing)!
      e.refs++
      if (e.writing === 0) e.handle = { ...e.handle, size, mtime }
      e.handle = { ...e.handle, lastPage }
      if (e.writing === 0 && !sameIdentity(e.identity, identity)) {
        // Changed behind the watcher's back: the windows that have it open must still be told.
        e.identity = identity
        this.watchEntry(e)
        this.onChangedOnDisk(e.handle.docId)
      }
      return e.handle
    }
    const handle: DocHandle = { docId: randomUUID(), path, name: basename(path), size, mtime, lastPage }
    const entry: Entry = { handle, refs: 1, identity, writing: 0 }
    this.watchEntry(entry)
    this.docs.set(handle.docId, entry)
    this.byPath.set(path, handle.docId)
    // An interrupted save may have left a temp file next to the document.
    void sweepStaleTemps(path).catch(() => undefined)
    return handle
  }

  /**
   * (Re)creates the file watcher. Needed after every replace-by-rename: on macOS and Linux a watcher follows the
   * old file (inode), which no longer has a name, so it would never report anything again.
   */
  private watchEntry(entry: Entry): void {
    entry.watcher?.close()
    entry.watcher = undefined
    try {
      const w = watch(entry.handle.path, () => {
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => void this.checkChanged(entry), this.debounceMs)
      })
      w.on('error', () => {
        w.close()
        if (entry.watcher === w) entry.watcher = undefined
      })
      entry.watcher = w
    } catch {
      /* watching is best-effort */
    }
  }

  /** The file as this document last saw it (what a save expects to find on disk). */
  identityOf(docId: string): FileIdentity | null {
    return this.docs.get(docId)?.identity ?? null
  }

  /** A save of ours starts / ends: file events in between are not external changes. */
  beginWrite(docId: string): void {
    const e = this.docs.get(docId)
    if (e) e.writing++
  }

  endWrite(docId: string): void {
    const e = this.docs.get(docId)
    if (e && e.writing > 0) e.writing--
  }

  /** Records a write we made ourselves so the watcher does not report it as an external change. */
  noteWritten(docId: string, size: number, mtime: number, identity: FileIdentity): void {
    const e = this.docs.get(docId)
    if (!e) return
    e.handle = { ...e.handle, size, mtime }
    e.identity = identity
    this.watchEntry(e) // the file may be a new one (replaced by rename)
  }

  /** Takes whatever is on disk now as the document's known state (after a save found the file changed). */
  async recordDiskState(docId: string): Promise<void> {
    const e = this.docs.get(docId)
    if (!e) return
    const st = await stat(e.handle.path).catch(() => null)
    if (!st) return
    e.handle = { ...e.handle, size: st.size, mtime: st.mtimeMs }
    const replaced = st.ino !== e.identity.ino || st.dev !== e.identity.dev
    e.identity = identityOf(st)
    if (replaced) this.watchEntry(e)
  }

  /** Points an open document at a new file (after Save As). Other windows keep their own docIds. */
  rebind(docId: string, newPath: string, size: number, mtime: number, identity: FileIdentity): DocHandle | null {
    const e = this.docs.get(docId)
    if (!e) return null
    if (this.byPath.get(e.handle.path) === docId) this.byPath.delete(e.handle.path)
    e.handle = { ...e.handle, path: newPath, name: basename(newPath), size, mtime }
    e.identity = identity
    this.byPath.set(newPath, docId)
    this.watchEntry(e)
    return e.handle
  }

  addRef(docId: string): DocHandle | null {
    const e = this.docs.get(docId)
    if (!e) return null
    e.refs++
    return e.handle
  }

  release(docId: string): void {
    const e = this.docs.get(docId)
    if (!e) return
    if (--e.refs > 0) return
    clearTimeout(e.timer)
    e.watcher?.close()
    this.docs.delete(docId)
    this.byPath.delete(e.handle.path)
  }

  pathOf(docId: string): string | null {
    return this.docs.get(docId)?.handle.path ?? null
  }

  private async checkChanged(entry: Entry, attempt = 0): Promise<void> {
    if (!this.docs.has(entry.handle.docId)) return
    if (entry.writing > 0) {
      // Our own save: look again once it is done (noteWritten records the result first).
      entry.timer = setTimeout(() => void this.checkChanged(entry), this.debounceMs)
      return
    }
    const st = await stat(entry.handle.path).catch(() => null)
    if (!st) {
      // Some programs save by deleting and re-creating; look again for a few seconds, then watch the new file.
      if (attempt < 5) entry.timer = setTimeout(() => void this.checkChanged(entry, attempt + 1), 1000)
      return
    }
    const now = identityOf(st)
    if (sameIdentity(now, entry.identity)) return
    const replaced = now.ino !== entry.identity.ino || now.dev !== entry.identity.dev
    entry.identity = now
    if (replaced || attempt > 0) this.watchEntry(entry)
    if (st.mtimeMs !== entry.handle.mtime || st.size !== entry.handle.size || replaced) {
      entry.handle = { ...entry.handle, mtime: st.mtimeMs, size: st.size }
      this.onChangedOnDisk(entry.handle.docId)
    }
  }

  disposeAll(): void {
    for (const e of this.docs.values()) {
      clearTimeout(e.timer)
      e.watcher?.close()
    }
    this.docs.clear()
    this.byPath.clear()
  }
}
