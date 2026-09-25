/** Pure list helpers for the Combine screen's drag-and-drop and keyboard reordering. */

/** Moves the item at `from` so that it ends up at index `to` (both clamped). Returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list]
  const target = Math.max(0, Math.min(list.length - 1, to))
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/** Moves the item at `index` up (-1) or down (+1); at the ends it stays put. */
export function moveBy<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  return moveItem(list, index, index + delta)
}

/** Where a dragged row lands when dropped on `overIndex`, given whether the pointer is in the lower half. */
export function dropIndex(from: number, overIndex: number, lowerHalf: boolean): number {
  let to = overIndex + (lowerHalf ? 1 : 0)
  if (from < to) to -= 1 // removing the dragged row shifts everything after it up by one
  return to
}
