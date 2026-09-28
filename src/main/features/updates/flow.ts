/**
 * The update conversation, independent of Electron and electron-updater so it can be tested with fakes:
 * check → (ask) download → (ask) restart. Installing happens when the app really quits, never before, so a
 * pending "Save changes?" prompt can still veto it and no work is lost.
 *
 * Where the app can't replace itself (a Linux .deb, installed by the system's package manager; macOS without a
 * Developer ID signature), the flow only tells the user about the new version and offers the download page; nothing
 * is downloaded or installed.
 */

export interface UpdateCheckResult {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
}

export interface UpdaterLike {
  checkForUpdates(): Promise<UpdateCheckResult | null | undefined>
  downloadUpdate(): Promise<unknown>
}

export interface UpdateUi {
  confirmDownload(version: string, current: string): Promise<boolean>
  confirmRestart(version: string): Promise<boolean>
  notifyUpToDate(current: string): Promise<void>
  notifyError(message: string): Promise<void>
  notifyUnavailable(): Promise<void>
  /** Notify-only installs: tells the user a version is out and opens the download page if they want it. True = opened. */
  offerDownloadPage(version: string, current: string): Promise<boolean>
  /** 0..1 while downloading, null when finished. */
  progress(fraction: number | null): void
}

export type UpdateOutcome = 'unavailable' | 'busy' | 'up-to-date' | 'declined' | 'error' | 'ready' | 'restarting' | 'notified'

export interface UpdateFlowOptions {
  updater: UpdaterLike
  ui: UpdateUi
  currentVersion: string
  /** False for a dev/unpackaged run: there is nothing installed to update. */
  canUpdate: boolean
  /** False when the app can't install its own updates (a Linux .deb, macOS): only tell the user. Default true. */
  canInstall?: boolean
  /** Starts the normal quit (which asks about unsaved changes); the installer runs once the quit really happens. */
  requestQuit: () => void
}

export interface UpdateFlow {
  /** `manual` = the user asked (always reports the result); otherwise a background check that stays quiet unless there is news. */
  check(manual: boolean): Promise<UpdateOutcome>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createUpdateFlow(o: UpdateFlowOptions): UpdateFlow {
  let running = false
  let downloaded: string | null = null // version already on disk, waiting for a restart
  const declined = new Set<string>() // versions the user said "later" to in a background check (don't nag again this session)

  const offerRestart = async (version: string): Promise<UpdateOutcome> => {
    if (await o.ui.confirmRestart(version)) {
      o.requestQuit()
      return 'restarting'
    }
    return 'ready' // it installs the next time the app quits
  }

  return {
    async check(manual) {
      if (!o.canUpdate) {
        if (manual) await o.ui.notifyUnavailable()
        return 'unavailable'
      }
      if (running) return 'busy'
      running = true
      try {
        if (downloaded) return await offerRestart(downloaded)
        let result: UpdateCheckResult | null | undefined
        try {
          result = await o.updater.checkForUpdates()
        } catch (e) {
          if (manual) await o.ui.notifyError(messageOf(e))
          return 'error'
        }
        if (!result || !result.isUpdateAvailable) {
          if (manual) await o.ui.notifyUpToDate(o.currentVersion)
          return 'up-to-date'
        }
        const version = result.updateInfo.version
        if (!manual && declined.has(version)) return 'declined'
        if (o.canInstall === false) {
          if (await o.ui.offerDownloadPage(version, o.currentVersion)) return 'notified'
          declined.add(version)
          return 'declined'
        }
        if (!(await o.ui.confirmDownload(version, o.currentVersion))) {
          declined.add(version)
          return 'declined'
        }
        try {
          o.ui.progress(0)
          await o.updater.downloadUpdate()
        } catch (e) {
          await o.ui.notifyError(messageOf(e))
          return 'error'
        } finally {
          o.ui.progress(null)
        }
        downloaded = version
        return await offerRestart(version)
      } finally {
        running = false
      }
    }
  }
}
