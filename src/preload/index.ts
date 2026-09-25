import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { EVENTS, type EventChannel } from '../shared/channels'
import type { EpdfApi, InvokeChannel, InvokeRequest, InvokeResponses } from '../shared/ipc'

function invoke<C extends InvokeChannel>(channel: C, req?: InvokeRequest<C>): Promise<InvokeResponses[C]> {
  return ipcRenderer.invoke(channel, req) as Promise<InvokeResponses[C]>
}

const api: EpdfApi = {
  openDialog: (multi) => invoke('file:openDialog', { multi }),
  openPath: (path) => invoke('file:open', { path }),
  openDropped: (paths) => invoke('file:openDropped', { paths }),
  closeDoc: (docId) => invoke('file:close', { docId }),
  revealDoc: (docId) => invoke('file:reveal', { docId }),
  saveFile: (docId, bytes) => invoke('file:save', { docId, bytes }),
  saveFileAs: (docId, bytes, suggestedName) => invoke('file:saveAs', { docId, bytes, suggestedName }),
  saveCopy: (docId, bytes, suggestedName) => invoke('file:saveCopy', { docId, bytes, suggestedName }),
  writeRecovery: (docId, bytes) => invoke('recovery:write', { docId, bytes }),
  readRecovery: (docId) => invoke('recovery:read', { docId }),
  clearRecovery: (docId) => invoke('recovery:clear', { docId }),
  listVersions: (docId) => invoke('versions:list', { docId }),
  readVersion: (docId, versionId) => invoke('versions:read', { docId, versionId }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listRecent: () => invoke('recent:list'),
  removeRecent: (path) => invoke('recent:remove', { path }),
  clearRecent: () => invoke('recent:clear'),
  reportTabs: (report) => invoke('tabs:report', report),
  detachTab: (req) => invoke('tabs:detach', req),
  ready: () => invoke('window:ready'),
  closeWindow: (discard) => invoke('window:close', { discard }),
  cancelClose: () => invoke('window:close', { cancel: true }),
  getSettings: () => invoke('settings:getAll'),
  setSetting: (req) => invoke('settings:set', req),
  getAppInfo: () => invoke('app:info'),
  setDefaultPdf: () => invoke('app:setDefaultPdf'),
  on(channel, cb) {
    // Only allow known event channels, and never hand the raw IpcRendererEvent to page code.
    if (!(EVENTS as readonly string[]).includes(channel)) throw new Error(`Unknown event channel: ${channel}`)
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(channel as EventChannel, listener)
    return () => ipcRenderer.removeListener(channel as EventChannel, listener)
  },
  // Not a raw pass-through: main only serves channels that a feature explicitly registered, and
  // validates every payload against that feature's zod schema.
  call: (channel, payload) => invoke('feature:call', { channel, payload }) as Promise<never>,
  onFeature(channel, cb) {
    const listener = (_e: IpcRendererEvent, msg: { channel: string; payload: unknown }): void => {
      if (msg && msg.channel === channel) cb(msg.payload)
    }
    ipcRenderer.on('feature:event', listener)
    return () => ipcRenderer.removeListener('feature:event', listener)
  }
}

contextBridge.exposeInMainWorld('epdf', api)
