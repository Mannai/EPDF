import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import type { DocHandle } from '../../shared/types'

interface Entry {
  handle: DocHandle
  refs: number
  watcher?: FSWatcher
  timer?: NodeJS.Timeout
}

export class InvalidPdfError extends Error {}

/** Verifies the file exists, is a regular file, and starts with a PDF header. */
export async function validatePdfFile(path: string): Promise<{ size: number; mtime: number }> {
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
  return { size: st.size, mtime: st.mtimeMs }
}

/**
 * Maps opaque document ids to on-disk paths. The renderer never supplies a path when reading
 * bytes; it can only ask for a docId that main previously issued.
 */
export class DocRegistry {
  private docs = new Map<string, Entry>()
  private byPath = new Map<string, string>()

  constructor(private onChangedOnDisk: (docId: string) => void) {}

  /** Registers (or adds a reference to) a document. Every returned handle owns one reference. */
  async register(path: string, lastPage?: number): Promise<DocHandle> {
    const { size, mtime } = await validatePdfFile(path)
    const existing = this.byPath.get(path)
    if (existing) {
      const e = this.docs.get(existing)!
      e.refs++
      e.handle = { ...e.handle, size, mtime, lastPage }
      return e.handle
    }
    const handle: DocHandle = { docId: randomUUID(), path, name: basename(path), size, mtime, lastPage }
    const entry: Entry = { handle, refs: 1 }
    this.watchEntry(entry)
    this.docs.set(handle.docId, entry)
    this.byPath.set(path, handle.docId)
    return handle
  }

  private watchEntry(entry: Entry): void {
    entry.watcher?.close()
    try {
      entry.watcher = watch(entry.handle.path, () => {
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => this.checkChanged(entry), 400)
      })
      entry.watcher.on('error', () => entry.watcher?.close())
    } catch {
      /* watching is best-effort */
    }
  }

  /** Records a write we made ourselves so the watcher does not report it as an external change. */
  noteWritten(docId: string, size: number, mtime: number): void {
    const e = this.docs.get(docId)
    if (e) e.handle = { ...e.handle, size, mtime }
  }

  /** Points an open document at a new file (after Save As). Other windows keep their own docIds. */
  rebind(docId: string, newPath: string, size: number, mtime: number): DocHandle | null {
    const e = this.docs.get(docId)
    if (!e) return null
    if (this.byPath.get(e.handle.path) === docId) this.byPath.delete(e.handle.path)
    e.handle = { ...e.handle, path: newPath, name: basename(newPath), size, mtime }
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

  private async checkChanged(entry: Entry): Promise<void> {
    const st = await stat(entry.handle.path).catch(() => null)
    if (!st) return
    if (st.mtimeMs !== entry.handle.mtime || st.size !== entry.handle.size) {
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
