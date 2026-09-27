import type { z } from 'zod'
import type {
  DocHandleSchema,
  DocViewStateSchema,
  SettingsSchema,
  TabReportSchema,
  ViewModeSchema,
  ZoomModeSchema
} from './schemas'

export type ZoomMode = z.infer<typeof ZoomModeSchema>
export type ViewMode = z.infer<typeof ViewModeSchema>
export type DocViewState = z.infer<typeof DocViewStateSchema>
export type DocHandle = z.infer<typeof DocHandleSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type TabReport = z.infer<typeof TabReportSchema>

export interface RecentFile {
  path: string
  name: string
  size: number
  lastOpenedAt: number
  openCount: number
  lastPage: number
  favorite: boolean
}

/** A document delivered to a renderer, optionally with the view state to restore. */
export interface OpenedDoc {
  handle: DocHandle
  view: DocViewState
  activate: boolean
  /** Restore the autosaved edits without asking (used when a dirty tab moves to a new window). */
  autoRecover?: boolean
}

export interface AppInfo {
  version: string
  platform: string
  darkMode: boolean
  docBaseUrl: string
  /** How often unsaved edits are autosaved to the recovery folder. */
  autosaveMs: number
}

export interface SaveResult {
  path: string
  name: string
  mtime: number
  size: number
}

export interface VersionInfo {
  id: number
  savedAt: number
  size: number
  note: string
}

export type MenuAction =
  /** Runs a renderer command registered with `registerCommand` (features add their own). */
  | { type: 'command'; id: string }
  | { type: 'open' }
  | { type: 'close-tab' }
  | { type: 'next-tab' }
  | { type: 'prev-tab' }
  | { type: 'find' }
  | { type: 'find-next' }
  | { type: 'find-prev' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-actual' }
  | { type: 'fit-width' }
  | { type: 'fit-page' }
  | { type: 'view-mode'; mode: ViewMode }
  | { type: 'toggle-sidebar' }
  | { type: 'page-next' }
  | { type: 'page-prev' }
  | { type: 'page-first' }
  | { type: 'page-last' }
  | { type: 'goto-page' }
  | { type: 'detach-tab' }
  /** Settings were changed from the menu: re-read them. */
  | { type: 'settings-changed' }
  | { type: 'reload' }

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultViewMode: 'continuous',
  defaultZoomMode: 'fit-width',
  restoreOnLaunch: true,
  sidebarOpen: true,
  confirmDelete: true
}
