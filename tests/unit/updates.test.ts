import { describe, expect, it, vi } from 'vitest'
import { createUpdateFlow, type UpdateUi, type UpdaterLike } from '../../src/main/features/updates/flow'
import { AUTO_CHECK_INTERVAL_MS, autoAnswerPrompts, feedOverride, msUntilNextAutoCheck } from '../../src/main/features/updates/policy'

describe('update policy', () => {
  it('only a test build may redirect the update feed', () => {
    const env = { EPDF_UPDATE_URL: 'http://127.0.0.1:9/feed' }
    expect(feedOverride(env, {})).toBeNull()
    expect(feedOverride(env, { epdfTestBuild: false })).toBeNull()
    expect(feedOverride(env, { epdfTestBuild: true })).toBe('http://127.0.0.1:9/feed')
  })

  it('ignores a feed override that is not http(s)', () => {
    expect(feedOverride({ EPDF_UPDATE_URL: 'file:///c:/evil' }, { epdfTestBuild: true })).toBeNull()
    expect(feedOverride({ EPDF_UPDATE_URL: '' }, { epdfTestBuild: true })).toBeNull()
    expect(feedOverride({}, { epdfTestBuild: true })).toBeNull()
  })

  it('auto-answering prompts needs both the test build and the env flag', () => {
    expect(autoAnswerPrompts({ EPDF_UPDATE_TEST_ACCEPT: '1' }, {})).toBe(false)
    expect(autoAnswerPrompts({}, { epdfTestBuild: true })).toBe(false)
    expect(autoAnswerPrompts({ EPDF_UPDATE_TEST_ACCEPT: '1' }, { epdfTestBuild: true })).toBe(true)
  })

  it('schedules the next background check a day after the last one', () => {
    const now = 1_000_000_000
    expect(msUntilNextAutoCheck(now, null)).toBe(0)
    expect(msUntilNextAutoCheck(now, now - AUTO_CHECK_INTERVAL_MS - 1)).toBe(0)
    expect(msUntilNextAutoCheck(now, now - 1000)).toBe(AUTO_CHECK_INTERVAL_MS - 1000)
    expect(msUntilNextAutoCheck(now, now + 5000)).toBe(0) // clock went backwards: don't wait a day
  })
})

function harness(over: { check?: UpdaterLike['checkForUpdates']; download?: UpdaterLike['downloadUpdate']; canUpdate?: boolean; yes?: boolean } = {}) {
  const updater: UpdaterLike = {
    checkForUpdates: vi.fn(over.check ?? (async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }))),
    downloadUpdate: vi.fn(over.download ?? (async () => ['x']))
  }
  const yes = over.yes ?? true
  const ui: UpdateUi = {
    confirmDownload: vi.fn(async () => yes),
    confirmRestart: vi.fn(async () => yes),
    notifyUpToDate: vi.fn(async () => undefined),
    notifyError: vi.fn(async () => undefined),
    notifyUnavailable: vi.fn(async () => undefined),
    progress: vi.fn()
  }
  const requestQuit = vi.fn()
  const flow = createUpdateFlow({ updater, ui, currentVersion: '0.1.0', canUpdate: over.canUpdate ?? true, requestQuit })
  return { updater, ui, requestQuit, flow }
}

describe('update flow', () => {
  it('check → download → restart asks in that order and quits through the normal flow', async () => {
    const h = harness()
    expect(await h.flow.check(true)).toBe('restarting')
    expect(h.ui.confirmDownload).toHaveBeenCalledWith('0.2.0', '0.1.0')
    expect(h.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(h.ui.confirmRestart).toHaveBeenCalledWith('0.2.0')
    expect(h.requestQuit).toHaveBeenCalledOnce()
    expect(h.ui.progress).toHaveBeenLastCalledWith(null) // progress bar always cleared
  })

  it('downloads nothing unless the user agrees', async () => {
    const h = harness({ yes: false })
    expect(await h.flow.check(true)).toBe('declined')
    expect(h.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(h.requestQuit).not.toHaveBeenCalled()
  })

  it('"Later" on the restart prompt leaves the update to install on the next quit', async () => {
    const h = harness()
    ;(h.ui.confirmRestart as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    expect(await h.flow.check(true)).toBe('ready')
    expect(h.requestQuit).not.toHaveBeenCalled()
    // asking again does not download twice, it just offers the restart again
    expect(await h.flow.check(true)).toBe('ready')
    expect(h.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('a background check is silent when there is nothing new or the network fails', async () => {
    const none = harness({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }) })
    expect(await none.flow.check(false)).toBe('up-to-date')
    expect(none.ui.notifyUpToDate).not.toHaveBeenCalled()
    const bad = harness({ check: async () => Promise.reject(new Error('ENOTFOUND')) })
    expect(await bad.flow.check(false)).toBe('error')
    expect(bad.ui.notifyError).not.toHaveBeenCalled()
  })

  it('a manual check always reports the result', async () => {
    const none = harness({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }) })
    await none.flow.check(true)
    expect(none.ui.notifyUpToDate).toHaveBeenCalledWith('0.1.0')
    const bad = harness({ check: async () => Promise.reject(new Error('ENOTFOUND')) })
    await bad.flow.check(true)
    expect(bad.ui.notifyError).toHaveBeenCalledWith('ENOTFOUND')
  })

  it('a failed download is reported even for a background check, and clears the progress bar', async () => {
    const h = harness({ download: async () => Promise.reject(new Error('checksum mismatch')) })
    expect(await h.flow.check(false)).toBe('error')
    expect(h.ui.notifyError).toHaveBeenCalledWith('checksum mismatch')
    expect(h.ui.progress).toHaveBeenLastCalledWith(null)
    expect(h.requestQuit).not.toHaveBeenCalled()
  })

  it('does not nag again in the same session about a version that was declined in the background', async () => {
    const h = harness({ yes: false })
    await h.flow.check(false)
    expect(await h.flow.check(false)).toBe('declined')
    expect(h.ui.confirmDownload).toHaveBeenCalledOnce()
    await h.flow.check(true) // but asking explicitly still offers it
    expect(h.ui.confirmDownload).toHaveBeenCalledTimes(2)
  })

  it('never overlaps two checks', async () => {
    let release: (r: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void = () => undefined
    const h = harness({ check: () => new Promise((r) => (release = r)) })
    const first = h.flow.check(true)
    expect(await h.flow.check(true)).toBe('busy')
    release({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    expect(await first).toBe('up-to-date')
  })

  it('an unpackaged run says updates are unavailable and never touches the updater', async () => {
    const h = harness({ canUpdate: false })
    expect(await h.flow.check(true)).toBe('unavailable')
    expect(h.ui.notifyUnavailable).toHaveBeenCalledOnce()
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    const quiet = harness({ canUpdate: false })
    await quiet.flow.check(false)
    expect(quiet.ui.notifyUnavailable).not.toHaveBeenCalled()
  })
})
