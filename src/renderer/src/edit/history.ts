/**
 * A tag an edit carried (e.g. 'redaction', 'protect'), with the revision of the edit that introduced it, so the same
 * edit can be recognised again after undo/redo or after it was folded into the original.
 */
export interface Tagged {
  tag: string
  revision: number
}

export interface Entry<T> {
  value: T
  label: string
  /** Unique id of this state (see `nextRevision`). */
  revision: number
  /** What kind of edit produced this state; follows the entry through undo/redo and trimming. */
  tags: readonly string[]
}

/**
 * Every state of every document gets a revision id from this counter, so an id is never reused: not after undo and a
 * new edit, not after trimming, and not by the next history of the same document after its edits were discarded.
 */
let nextRevision = 1
const newRevision = (): number => nextRevision++

/**
 * Linear undo/redo history of full-document snapshots. Position -1 is "the original" (what was loaded from disk).
 * Each state has a unique revision id; `markSaved(revision)` records which revision is on disk, so `dirty` stays
 * accurate after undoing back to it, and a save that took a while marks exactly the state it wrote, never an edit
 * made while it was being written. Bounded by entry count and total bytes: when trimmed, the oldest edit becomes the
 * new original (undo can no longer reach past it) and its tags move into the original's lineage.
 */
export class History<T extends { byteLength: number }> {
  original: T | null = null
  /** The first revision this history issued; revisions below it belong to an earlier (discarded) history. */
  readonly firstRevision: number
  private originalRevision: number
  private originalLineage: Tagged[] = []
  private stack: Entry<T>[] = []
  private index = -1
  /** Revision that matches the file on disk. */
  private savedRev: number
  private issued = new Set<number>()

  constructor(
    private maxEntries = 40,
    private maxBytes = 768 * 1024 * 1024
  ) {
    this.originalRevision = this.issue()
    this.firstRevision = this.originalRevision
    this.savedRev = this.originalRevision
  }

  private issue(): number {
    const r = newRevision()
    this.issued.add(r)
    return r
  }

  /** Records a new state, discarding any redo branch. Returns the new state's revision. */
  push(label: string, value: T, tags: readonly string[] = []): number {
    this.stack.length = this.index + 1
    const revision = this.issue()
    this.stack.push({ value, label, revision, tags: [...tags] })
    this.index = this.stack.length - 1
    this.trim()
    return revision
  }

  private trim(): void {
    let total = this.stack.reduce((n, e) => n + e.value.byteLength, 0)
    while (this.stack.length > this.maxEntries || (total > this.maxBytes && this.stack.length > 1)) {
      const dropped = this.stack.shift()!
      total -= dropped.value.byteLength
      this.original = dropped.value
      this.originalRevision = dropped.revision
      for (const tag of dropped.tags) this.originalLineage.push({ tag, revision: dropped.revision })
      this.index--
    }
  }

  /** The current state, or null while at the original. */
  get current(): T | null {
    return this.index >= 0 ? this.stack[this.index].value : null
  }

  /** Revision of the current state. */
  get revision(): number {
    return this.index >= 0 ? this.stack[this.index].revision : this.originalRevision
  }

  /** Every tag on the way from the loaded file to the current state, oldest first. */
  get lineage(): Tagged[] {
    const out = [...this.originalLineage]
    for (let i = 0; i <= this.index; i++) for (const tag of this.stack[i].tags) out.push({ tag, revision: this.stack[i].revision })
    return out
  }

  get canUndo(): boolean {
    return this.index >= 0
  }
  get canRedo(): boolean {
    return this.index < this.stack.length - 1
  }
  get undoLabel(): string | undefined {
    return this.index >= 0 ? this.stack[this.index].label : undefined
  }
  get redoLabel(): string | undefined {
    return this.canRedo ? this.stack[this.index + 1].label : undefined
  }
  get dirty(): boolean {
    return this.revision !== this.savedRev
  }
  get length(): number {
    return this.stack.length
  }
  get position(): number {
    return this.index
  }
  /** The revision that is on disk. */
  get savedRevision(): number {
    return this.savedRev
  }

  undo(): boolean {
    if (!this.canUndo) return false
    this.index--
    return true
  }

  redo(): boolean {
    if (!this.canRedo) return false
    this.index++
    return true
  }

  /** True if `revision` is a state this history created (not one from an earlier, discarded history). */
  owns(revision: number): boolean {
    return revision >= this.firstRevision && this.issued.has(revision)
  }

  /**
   * Records that `revision` (default: the current state) is what is on disk now. Revisions this history did not issue
   * are ignored (returns false): they belong to edits that were discarded while the save was running.
   */
  markSaved(revision: number = this.revision): boolean {
    if (!this.owns(revision)) return false
    this.savedRev = revision
    return true
  }

  /**
   * Drops every undo and redo step: the current state becomes the original, keeping its revision and lineage. Whether
   * the document counts as saved does not change (an edit made after the last save stays unsaved).
   */
  clearSteps(): void {
    if (this.index >= 0) {
      const lineage = this.lineage
      const cur = this.stack[this.index]
      this.original = cur.value
      this.originalRevision = cur.revision
      this.originalLineage = lineage
    }
    this.stack = []
    this.index = -1
  }

  /**
   * Swaps the bytes of the current state for an equivalent representation (e.g. the decrypted form of an
   * encrypted snapshot) without adding an undo step or changing whether the document counts as saved.
   */
  replaceCurrent(value: T): void {
    if (this.index >= 0) this.stack[this.index].value = value
    else this.original = value
  }
}
