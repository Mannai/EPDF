import { PDFDocument, degrees } from 'pdf-lib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PurgeSummary } from '@shared/features/redact'
import type { EpdfApi } from '@shared/ipc'
import type { OpenedDoc } from '@shared/types'

/**
 * Save, Save As and the purge offers, with the real edit session, tabs store, save flow and purge/protection
 * listeners. Only PDF.js (docCache), the annotation reader behind Fill & sign and the main process (`window.epdf`)
 * are faked.
 */

const h = vi.hoisted(() => ({ fillItems: false }))

vi.mock('../../src/renderer/src/pdf/docCache', () => ({
  destroyDoc: async () => undefined,
  getAcceptedPassword: () => undefined,
  getLoaded: () => undefined
}))
vi.mock('../../src/renderer/src/features/markup/data', () => ({
  refreshAnnots: async () => undefined,
  useAnnots: { getState: () => ({ byDoc: new Proxy({}, { get: () => ({ annots: h.fillItems ? [{ fillSign: true }] : [] }) }) }) }
}))
vi.mock('../../src/renderer/src/features/markup/pdf/flatten', () => ({
  flattenFillItems: (pdf: PDFDocument) => pdf.setSubject('locked fill items')
}))

import { useTabs } from '../../src/renderer/src/state/tabs'
import { useConfirm } from '../../src/renderer/src/state/confirm'
import { useToasts } from '../../src/renderer/src/state/notify'
import { canUndo, discardEdits, editPdf, isDirty, redo, undo, whenEditsSettled } from '../../src/renderer/src/edit/session'
import { onSaveCompleted, saveDoc, saveDocAs, type SaveCompleted } from '../../src/renderer/src/features/core/save'
import { REDACTION_TAG, watchSaves } from '../../src/renderer/src/features/redact/purge'
import { protectionSaved } from '../../src/renderer/src/features/security/saved'
import { protectFlow, removeFlow } from '../../src/renderer/src/features/security/session'
import { DEFAULT_SETTINGS as PROTECT_DEFAULTS } from '../../src/renderer/src/features/security/logic'
import { useProtectDialog } from '../../src/renderer/src/features/security/store'
import '../../src/renderer/src/features/forms/fillSignSave'

// ---------------------------------------------------------------- fake main process

interface HeldSave {
  release(): void
  fail(err: Error): void
}

const fake = {
  disk: new Map<string, Uint8Array>(),
  holdSaves: false,
  held: [] as HeldSave[],
  saveFileCalls: 0,
  /** Version-history snapshots main keeps; each save of an existing file adds one. */
  versions: 0,
  recovery: false,
  snapshotOnSave: true,
  purgeResults: [] as (PurgeSummary | Error)[],
  calls: [] as string[],
  saveAsPath: ''
}

const pathOf = (docId: string): string => useTabs.getState().tabs.find((t) => t.docId === docId)!.path
const baseName = (p: string): string => p.split('/').pop()!

const api = {
  getAppInfo: async () => ({ docBaseUrl: 'epdf-doc://' }),
  saveFile: (docId: string, bytes: Uint8Array) =>
    new Promise((resolve, reject) => {
      fake.saveFileCalls++
      const path = pathOf(docId)
      const done = (): void => {
        fake.disk.set(path, bytes)
        if (fake.snapshotOnSave) fake.versions++
        resolve({ path, name: baseName(path) })
      }
      if (fake.holdSaves) fake.held.push({ release: done, fail: reject })
      else done()
    }),
  saveFileAs: async (_docId: string, bytes: Uint8Array) => {
    fake.disk.set(fake.saveAsPath, bytes)
    return { path: fake.saveAsPath, name: baseName(fake.saveAsPath) }
  },
  call: async (channel: string) => {
    fake.calls.push(channel)
    if (channel === 'redact:historyInfo') return { versions: fake.versions, recovery: fake.recovery }
    if (channel === 'redact:purgeHistory') {
      const r = fake.purgeResults.shift() ?? { versions: fake.versions, deleted: fake.versions, recovery: fake.recovery }
      if (r instanceof Error) throw r
      fake.versions = r.failed ?? Math.max(0, r.versions - r.deleted)
      fake.recovery = false
      return r
    }
    throw new Error(`unexpected channel ${channel}`)
  },
  closeDoc: async () => undefined,
  setSetting: async () => undefined
}

let original: Uint8Array
const messages: string[] = []
const saves: SaveCompleted[] = []

beforeAll(async () => {
  ;(globalThis as unknown as { window: { epdf: EpdfApi } }).window = { epdf: api as unknown as EpdfApi }
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 300])
  pdf.addPage([300, 300])
  original = await pdf.save()
  vi.stubGlobal('fetch', async () => new Response(original.slice()))
  useToasts.subscribe((s, prev) => {
    for (const t of s.toasts) if (!prev.toasts.some((p) => p.id === t.id)) messages.push(t.message)
  })
  watchSaves()
  onSaveCompleted(protectionSaved)
  onSaveCompleted((e) => void saves.push(e))
})

let n = 0
let doc = ''

beforeEach(() => {
  Object.assign(fake, { holdSaves: false, held: [], saveFileCalls: 0, versions: 0, recovery: false, snapshotOnSave: true, purgeResults: [], calls: [], saveAsPath: '' })
  messages.length = 0
  saves.length = 0
  h.fillItems = false
  doc = `doc${++n}`
  useTabs.getState().addDocs([{ handle: { docId: doc, path: `C:/docs/${doc}.pdf`, name: `${doc}.pdf` } } as unknown as OpenedDoc])
})

afterEach(async () => {
  // never leave a question open for the next test
  for (let i = 0; i < 20 && useConfirm.getState().request; i++) {
    const r = useConfirm.getState().request!
    r.resolve(r.cancelValue ?? r.buttons[r.buttons.length - 1].value)
    await tick()
  }
  useTabs.getState().closeTab(doc)
})

// ---------------------------------------------------------------- helpers

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Waits for a question whose title matches, checks it, and answers it. Returns its message. */
async function answer(title: string, value: string): Promise<string> {
  await waitFor(() => useConfirm.getState().request?.title === title, `the question “${title}”`)
  const r = useConfirm.getState().request!
  r.resolve(value)
  await tick()
  return r.message
}

/** Nothing is being asked (after giving any pending offer the time to show up). */
async function expectNoQuestion(): Promise<void> {
  await tick(30)
  expect(useConfirm.getState().request?.title).toBeUndefined()
}

const rotate = (docId = doc): Promise<void> => editPdf(docId, 'Rotate page', (pdf) => void pdf.getPage(0).setRotation(degrees(90)))
const annotate = (docId = doc): Promise<void> => editPdf(docId, 'Add note', (pdf) => pdf.setKeywords(['note']))
const redact = (docId = doc, title = 'redacted'): Promise<void> => editPdf(docId, 'Apply redactions', (pdf) => pdf.setTitle(title), { tags: [REDACTION_TAG] })

async function onDisk(path = pathOf(doc)): Promise<{ rotation: number; title?: string; keywords?: string; subject?: string }> {
  const bytes = fake.disk.get(path)
  if (!bytes) throw new Error(`nothing written to ${path}`)
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return { rotation: pdf.getPage(0).getRotation().angle, title: pdf.getTitle(), keywords: pdf.getKeywords(), subject: pdf.getSubject() }
}

async function settled(): Promise<void> {
  await whenEditsSettled(doc)
  await tick()
  await whenEditsSettled(doc)
}

// ---------------------------------------------------------------- tests

describe('save marks exactly the state it wrote', () => {
  it('an edit made while the save is running stays unsaved', async () => {
    await rotate()
    fake.holdSaves = true
    const saving = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    await annotate()
    fake.held[0].release()
    expect(await saving).toBe(false) // something is still unsaved
    expect(isDirty(doc)).toBe(true)
    expect(await onDisk()).toMatchObject({ rotation: 90, keywords: undefined })

    fake.holdSaves = false
    expect(await saveDoc(doc)).toBe(true)
    expect(isDirty(doc)).toBe(false)
    expect(await onDisk()).toMatchObject({ rotation: 90, keywords: 'note' })
  })

  it('an undo made while the save is running leaves the document unsaved; redo returns to the saved state', async () => {
    await rotate()
    fake.holdSaves = true
    const saving = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    await undo(doc)
    fake.held[0].release()
    expect(await saving).toBe(false)
    expect(isDirty(doc)).toBe(true)
    expect((await onDisk()).rotation).toBe(90)
    await redo(doc)
    expect(isDirty(doc)).toBe(false)
  })

  it('overlapping saves run one after the other and the second writes what the first did not', async () => {
    await rotate()
    fake.holdSaves = true
    const first = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the first write')
    await annotate()
    const second = saveDoc(doc)
    await tick(20)
    expect(fake.held.length).toBe(1) // the second waits for the first
    fake.held[0].release()
    await waitFor(() => fake.held.length === 2, 'the second write')
    fake.held[1].release()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(isDirty(doc)).toBe(false)
    expect(fake.saveFileCalls).toBe(2)
    expect(await onDisk()).toMatchObject({ rotation: 90, keywords: 'note' })
  })

  it('a second save with nothing new to save does not write again', async () => {
    await rotate()
    fake.holdSaves = true
    const first = saveDoc(doc)
    const second = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    fake.held[0].release()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(fake.saveFileCalls).toBe(1)
  })

  it('a save of edits that were discarded meanwhile does not mark the new session saved', async () => {
    await rotate()
    fake.holdSaves = true
    const saving = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    discardEdits(doc)
    await annotate() // a new session, with its own edit
    fake.held[0].release()
    await saving
    expect(isDirty(doc)).toBe(true)
  })

  it('a failed write leaves everything unsaved', async () => {
    await rotate()
    fake.holdSaves = true
    const saving = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    fake.held[0].fail(new Error('disk full'))
    expect(await saving).toBe(false)
    expect(isDirty(doc)).toBe(true)
    expect(messages.some((m) => m.includes('disk full'))).toBe(true)
    expect(saves).toEqual([])
  })
})

describe('saving a redaction', () => {
  it('redaction then rotation: undo steps are cleared and the purge is offered', async () => {
    await redact()
    await rotate()
    expect(await saveDoc(doc)).toBe(true)
    const msg = await answer('Purge the version history?', 'keep')
    expect(msg).toContain('unredacted content')
    await settled()
    expect(canUndo(doc)).toBe(false)
    expect(isDirty(doc)).toBe(false)
    expect(messages).toContain('The redaction is saved and permanent. The undo history for this document was cleared.')
    expect(messages).toContain('The version history was kept: it still contains the unredacted content.')
    expect(await onDisk()).toMatchObject({ title: 'redacted', rotation: 90 })
  })

  it('redaction then annotation: purging deletes the earlier versions', async () => {
    await redact()
    await annotate()
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    await waitFor(() => messages.some((m) => m.startsWith('Purged')), 'the purge result')
    expect(messages).toContain('Purged 1 earlier version.')
    expect(fake.calls).toContain('redact:purgeHistory')
    await settled()
    expect(canUndo(doc)).toBe(false)
  })

  it('Fill & sign locking its items during the save does not hide the redaction', async () => {
    h.fillItems = true
    const st = useTabs.getState()
    st.setSettings({ ...st.settings, fillSignOnSave: 'lock' })
    try {
      await redact()
      await saveDoc(doc)
      expect(await onDisk()).toMatchObject({ title: 'redacted', subject: 'locked fill items' })
      await answer('Purge the version history?', 'keep')
      await settled()
      expect(canUndo(doc)).toBe(false)
      expect(isDirty(doc)).toBe(false)
    } finally {
      st.setSettings({ ...st.settings, fillSignOnSave: 'ask' })
    }
  })

  it('an edit made while the redaction is being saved survives the clearing of the undo steps, unsaved', async () => {
    await redact()
    fake.holdSaves = true
    const saving = saveDoc(doc)
    await waitFor(() => fake.held.length === 1, 'the write')
    await rotate()
    fake.held[0].release()
    await saving
    await answer('Purge the version history?', 'keep')
    await settled()
    expect(canUndo(doc)).toBe(false)
    expect(isDirty(doc)).toBe(true)
    fake.holdSaves = false
    await saveDoc(doc)
    expect(await onDisk()).toMatchObject({ title: 'redacted', rotation: 90 })
    await expectNoQuestion() // the redaction was handled already
  })

  it('a redaction undone before saving is not treated as saved', async () => {
    await redact()
    await undo(doc)
    await rotate()
    await saveDoc(doc)
    await expectNoQuestion()
    expect(fake.calls).toEqual([])
    expect(canUndo(doc)).toBe(true)
  })

  it('a redaction undone and redone before saving is', async () => {
    await redact()
    await undo(doc)
    await redo(doc)
    await saveDoc(doc)
    await answer('Purge the version history?', 'keep')
    await settled()
    expect(canUndo(doc)).toBe(false)
  })

  it('Save As: says the original file is unchanged, offers no purge, and clears the undo steps', async () => {
    await redact()
    fake.saveAsPath = 'C:/out/redacted-copy.pdf'
    const oldName = `${doc}.pdf`
    expect(await saveDocAs(doc)).toBe(true)
    await expectNoQuestion()
    expect(messages).toContain(`The redacted copy was saved as “redacted-copy.pdf”. The original file “${oldName}” is unchanged and still contains the unredacted content.`)
    expect(pathOf(doc)).toBe('C:/out/redacted-copy.pdf')
    expect(saves.at(-1)).toMatchObject({ saveAs: true, oldPath: `C:/docs/${oldName}`, newPath: 'C:/out/redacted-copy.pdf' })
    await settled()
    expect(canUndo(doc)).toBe(false)
    expect(fake.calls).toEqual([])
  })

  it('each redaction is offered once, however many saves follow', async () => {
    await redact(doc, 'first')
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    await waitFor(() => messages.includes('Purged 1 earlier version.'), 'the purge result')
    await rotate()
    await saveDoc(doc)
    await expectNoQuestion()
    await redact(doc, 'second')
    await saveDoc(doc)
    await answer('Purge the version history?', 'keep')
    await annotate()
    await saveDoc(doc)
    await expectNoQuestion()
    expect(await onDisk()).toMatchObject({ title: 'second', keywords: 'note' })
  })

  it('nothing in the version history: nothing is asked', async () => {
    fake.snapshotOnSave = false
    await redact()
    await saveDoc(doc)
    await waitFor(() => fake.calls.includes('redact:historyInfo'), 'the history check')
    await expectNoQuestion()
    await settled()
    expect(canUndo(doc)).toBe(false)
  })
})

describe('purge failures', () => {
  it('reports what could not be deleted and retries until it is gone', async () => {
    fake.versions = 2 // becomes 3 with this save
    fake.purgeResults = [
      { versions: 3, deleted: 1, recovery: false },
      { versions: 2, deleted: 1, recovery: false, failed: 1 },
      { versions: 1, deleted: 1, recovery: false }
    ]
    await redact()
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    let msg = await answer('The version history was not fully purged', 'retry')
    expect(msg).toContain('2 earlier versions could not be deleted (1 was)')
    msg = await answer('The version history was not fully purged', 'retry')
    expect(msg).toContain('1 earlier version could not be deleted (2 were)')
    await waitFor(() => messages.some((m) => m.startsWith('Purged')), 'the purge result')
    expect(messages).toContain('Purged 3 earlier versions.')
    expect(messages).not.toContain('There was no earlier version to purge.')
  })

  it('an error is reported with a retry, and giving up says what is left', async () => {
    fake.purgeResults = [new Error('access denied'), { versions: 1, deleted: 0, recovery: false }]
    await redact()
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    let msg = await answer('The version history was not fully purged', 'retry')
    expect(msg).toContain('access denied')
    msg = await answer('The version history was not fully purged', 'keep')
    expect(msg).toContain('1 earlier version could not be deleted')
    await waitFor(() => messages.some((m) => m.includes('could not be deleted')), 'the final report')
    expect(messages.some((m) => m.startsWith('Purged') || m.startsWith('There was no'))).toBe(false)
  })

  it('“no earlier version” only when nothing was there to delete', async () => {
    fake.purgeResults = [{ versions: 0, deleted: 0, recovery: false }]
    await redact()
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    await waitFor(() => messages.includes('There was no earlier version to purge.'), 'the purge result')
  })
})

describe('saving new password protection', () => {
  async function protect(): Promise<void> {
    const flow = protectFlow(doc)
    await waitFor(() => !!useProtectDialog.getState().request, 'the protect dialog')
    useProtectDialog.getState().answer({ ...PROTECT_DEFAULTS, userPassword: 'open-me' })
    await flow
  }

  it('offers to purge the unprotected earlier versions, once', async () => {
    await protect()
    await saveDoc(doc)
    const msg = await answer('Purge the version history?', 'purge')
    expect(msg).toContain('password protection')
    await waitFor(() => messages.includes('Purged 1 earlier version.'), 'the purge result')
    await rotate()
    await saveDoc(doc)
    await expectNoQuestion()
  })

  it('protection added and removed again before saving: nothing to offer', async () => {
    await protect()
    const removing = removeFlow(doc)
    await answer('Remove password protection?', 'remove')
    await removing
    await saveDoc(doc)
    await expectNoQuestion()
    expect(fake.calls).toEqual([])
  })

  it('Save As with new protection does not touch the original file’s history', async () => {
    await protect()
    fake.saveAsPath = 'C:/out/protected.pdf'
    await saveDocAs(doc)
    await expectNoQuestion()
    expect(fake.calls).toEqual([])
  })

  it('a redaction and new protection in one save ask one after the other; the second looks again first', async () => {
    await redact()
    await protect()
    await saveDoc(doc)
    await answer('Purge the version history?', 'purge')
    await waitFor(() => messages.includes('Purged 1 earlier version.'), 'the purge result')
    // the history is empty now, so the second offer has nothing to ask about
    await expectNoQuestion()
    expect(fake.calls.filter((c) => c === 'redact:historyInfo')).toHaveLength(2)
  })
})
