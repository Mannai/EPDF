import type { KeyboardEvent } from 'react'

/**
 * The page viewer turns ArrowLeft/Right, PageUp/Down, Home and End into page navigation (and calls
 * `preventDefault`) for any key event that bubbles up to it, including ones typed inside our inputs.
 * That would break the cursor keys in a text field, arrow-key selection in a radio group or a select,
 * and nudging a placed signature. Call this first in every key handler of an input/box that lives on a
 * page: it stops those keys from reaching the viewer (it does not cancel the browser's own behaviour).
 */
const VIEWER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'])

export function isolateViewerKeys(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'stopPropagation'>): void {
  if (VIEWER_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation()
}
