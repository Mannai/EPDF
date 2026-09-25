import type { z } from 'zod'
import {
  CloseAckRequestSchema,
  DetachTabRequestSchema,
  DocIdRequestSchema,
  DroppedPathsRequestSchema,
  FeatureCallRequestSchema,
  ForceCloseRequestSchema,
  OpenDialogRequestSchema,
  OpenPathRequestSchema,
  RecentRemoveRequestSchema,
  RecoveryWriteRequestSchema,
  SaveAsRequestSchema,
  SaveRequestSchema,
  SetDefaultRequestSchema,
  SetSettingRequestSchema,
  SettingsGetRequestSchema,
  TabReportSchema,
  VersionReadRequestSchema
} from './schemas'
import type { EventChannel } from './channels'
import type { AppInfo, DocHandle, MenuAction, OpenedDoc, RecentFile, SaveResult, Settings, VersionInfo } from './types'

/** Renderer → main request/response channels. The request schema is enforced in main for every call. */
export const INVOKE = {
  'file:openDialog': { req: OpenDialogRequestSchema },
  'file:open': { req: OpenPathRequestSchema },
  'file:openDropped': { req: DroppedPathsRequestSchema },
  'file:close': { req: DocIdRequestSchema },
  'file:reveal': { req: DocIdRequestSchema },
  'file:save': { req: SaveRequestSchema },
  'file:saveAs': { req: SaveAsRequestSchema },
  'file:saveCopy': { req: SaveAsRequestSchema },
  'recovery:write': { req: RecoveryWriteRequestSchema },
  'recovery:read': { req: DocIdRequestSchema },
  'recovery:clear': { req: DocIdRequestSchema },
  'versions:list': { req: DocIdRequestSchema },
  'versions:read': { req: VersionReadRequestSchema },
  'recent:list': { req: SetDefaultRequestSchema },
  'recent:remove': { req: RecentRemoveRequestSchema },
  'recent:clear': { req: SetDefaultRequestSchema },
  'tabs:report': { req: TabReportSchema },
  'tabs:detach': { req: DetachTabRequestSchema },
  'window:ready': { req: SetDefaultRequestSchema },
  'window:close': { req: ForceCloseRequestSchema },
  'window:closeAck': { req: CloseAckRequestSchema },
  'settings:getAll': { req: SetDefaultRequestSchema },
  'settings:set': { req: SetSettingRequestSchema },
  'settings:get': { req: SettingsGetRequestSchema },
  'app:info': { req: SetDefaultRequestSchema },
  'app:setDefaultPdf': { req: SetDefaultRequestSchema },
  'feature:call': { req: FeatureCallRequestSchema }
} as const

export type InvokeChannel = keyof typeof INVOKE
export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof INVOKE)[C]['req']>

export interface InvokeResponses {
  'file:openDialog': DocHandle[]
  'file:open': DocHandle | null
  'file:openDropped': DocHandle[]
  'file:close': void
  'file:reveal': void
  /** Atomically overwrites the document's file. Rejects if the file cannot be written. */
  'file:save': SaveResult
  /** Shows a Save dialog; the document is re-bound to the new path. Null if cancelled. */
  'file:saveAs': SaveResult | null
  /** Shows a Save dialog; the open document is untouched. Null if cancelled. */
  'file:saveCopy': SaveResult | null
  'recovery:write': void
  'recovery:read': Uint8Array | null
  'recovery:clear': void
  'versions:list': VersionInfo[]
  'versions:read': Uint8Array | null
  'recent:list': RecentFile[]
  'recent:remove': void
  'recent:clear': void
  'tabs:report': void
  'tabs:detach': void
  'window:ready': void
  'window:close': void
  'window:closeAck': void
  'settings:getAll': Settings
  'settings:set': void
  'settings:get': Settings[keyof Settings]
  'app:info': AppInfo
  'app:setDefaultPdf': void
  'feature:call': unknown
}

/** Main → renderer events (names live in channels.ts). */
export interface EventPayloads {
  'doc:open': OpenedDoc[]
  'doc:changedOnDisk': { docId: string }
  'menu:action': MenuAction
  'theme:changed': { darkMode: boolean }
  'recent:changed': undefined
  'window:closeRequested': undefined
  'feature:event': { channel: string; payload: unknown }
}

/** The typed surface exposed on `window.epdf` by the preload script. */
export interface EpdfApi {
  openDialog(multi?: boolean): Promise<DocHandle[]>
  openPath(path: string): Promise<DocHandle | null>
  openDropped(paths: string[]): Promise<DocHandle[]>
  closeDoc(docId: string): Promise<void>
  revealDoc(docId: string): Promise<void>
  saveFile(docId: string, bytes: Uint8Array): Promise<SaveResult>
  saveFileAs(docId: string, bytes: Uint8Array, suggestedName?: string): Promise<SaveResult | null>
  saveCopy(docId: string, bytes: Uint8Array, suggestedName?: string): Promise<SaveResult | null>
  writeRecovery(docId: string, bytes: Uint8Array): Promise<void>
  readRecovery(docId: string): Promise<Uint8Array | null>
  clearRecovery(docId: string): Promise<void>
  listVersions(docId: string): Promise<VersionInfo[]>
  readVersion(docId: string, versionId: number): Promise<Uint8Array | null>
  getPathForFile(file: File): string
  listRecent(): Promise<RecentFile[]>
  removeRecent(path: string): Promise<void>
  clearRecent(): Promise<void>
  reportTabs(report: InvokeRequest<'tabs:report'>): Promise<void>
  detachTab(req: InvokeRequest<'tabs:detach'>): Promise<void>
  ready(): Promise<void>
  /** Closes this window. `discard` skips the unsaved-changes guard (the renderer has already asked). */
  closeWindow(discard?: boolean): Promise<void>
  /** The user chose Cancel in an unsaved-changes prompt: stay open (and abandon a quit that was waiting). */
  cancelClose(): Promise<void>
  /** Tells main the close request arrived and is being handled (stops the "renderer is hung" watchdog). */
  ackClose(): Promise<void>
  getSettings(): Promise<Settings>
  setSetting(req: InvokeRequest<'settings:set'>): Promise<void>
  getAppInfo(): Promise<AppInfo>
  setDefaultPdf(): Promise<void>
  on<C extends EventChannel>(channel: C, cb: (payload: EventPayloads[C]) => void): () => void
  /**
   * Calls a channel registered by a main-process feature (`registerFeatureChannel`). Main validates the
   * payload against that feature's schema and rejects unknown channels.
   */
  call<Res = unknown>(channel: string, payload?: unknown): Promise<Res>
  /** Subscribes to events a main-process feature pushes with `sendFeatureEvent`. */
  onFeature(channel: string, cb: (payload: unknown) => void): () => void
}
