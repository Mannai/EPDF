/** Main → renderer event names. Kept dependency-free so the preload bundle stays tiny. */
export const EVENTS = [
  'doc:open',
  'doc:changedOnDisk',
  'menu:action',
  'theme:changed',
  'recent:changed',
  /** Main asks the renderer to confirm (save / discard) before this window closes. */
  'window:closeRequested',
  /** Generic feature event: `{ channel, payload }`, see `EpdfApi.onFeature`. */
  'feature:event'
] as const
export type EventChannel = (typeof EVENTS)[number]
