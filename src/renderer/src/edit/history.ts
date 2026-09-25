export interface Entry<T> {
  value: T
  label: string
}

/**
 * Linear undo/redo history of full-document snapshots. Position -1 is "the original" (what was loaded
 * from disk); `markSaved()` records which position matches the file on disk so `dirty` is accurate even
 * after undoing back to it. Bounded by entry count and total bytes: when trimmed, the oldest edit becomes
 * the new original (undo can no longer reach past it).
 */
export class History<T extends { byteLength: number }> {
  original: T | null = null
  private stack: Entry<T>[] = []
  private index = -1
  /** History position that matches disk. -1 = original, -2 = nothing (the saved state was trimmed away). */
  private savedIndex = -1

  constructor(
    private maxEntries = 40,
    private maxBytes = 768 * 1024 * 1024
  ) {}

  /** Records a new state, discarding any redo branch. */
  push(label: string, value: T): void {
    this.stack.length = this.index + 1
    // A saved state that lived on the discarded redo branch no longer exists.
    if (this.savedIndex > this.index) this.savedIndex = -2
    this.stack.push({ value, label })
    this.index = this.stack.length - 1
    this.trim()
  }

  private trim(): void {
    let total = this.stack.reduce((n, e) => n + e.value.byteLength, 0)
    while (this.stack.length > this.maxEntries || (total > this.maxBytes && this.stack.length > 1)) {
      const dropped = this.stack.shift()!
      total -= dropped.value.byteLength
      this.original = dropped.value
      this.index--
      // savedIndex shifts with the stack; if it pointed at the old original it now matches nothing.
      this.savedIndex = this.savedIndex - 1 < -1 ? -2 : this.savedIndex - 1
    }
  }

  /** The current state, or null while at the original. */
  get current(): T | null {
    return this.index >= 0 ? this.stack[this.index].value : null
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
    return this.index !== this.savedIndex
  }
  get length(): number {
    return this.stack.length
  }
  get position(): number {
    return this.index
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

  markSaved(): void {
    this.savedIndex = this.index
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
