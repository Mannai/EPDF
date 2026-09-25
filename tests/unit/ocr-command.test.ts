import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS } from '../../src/shared/features/ocr'

/** The `ocr.run` command other features call (Scanning: `runCommand('ocr.run', { docId, silent: true })`). */

const h = vi.hoisted(() => ({
  tabs: [] as { docId: string; numPages: number; view: { page: number } }[],
  active: undefined as undefined | { docId: string; numPages: number; view: { page: number } },
  toasts: [] as { kind: string; message: string }[],
  runOcr: vi.fn(async (_o: unknown) => ({ status: 'done' })),
  show: vi.fn(async (_d: string, _n: number, _p: number) => undefined),
  call: vi.fn(async (_c: string, _p: unknown): Promise<unknown> => ({ languages: [], prefs: { languages: ['eng'], dpi: 300, contrast: true, deskew: true, force: false } }))
}))

vi.mock('../../src/renderer/src/state/actions', () => ({ activeTab: () => h.active }))
vi.mock('../../src/renderer/src/state/tabs', () => ({ useTabs: { getState: () => ({ tabs: h.tabs }) } }))
vi.mock('../../src/renderer/src/state/notify', () => ({
  notify: (kind: string, message: string) => h.toasts.push({ kind, message }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
vi.mock('../../src/renderer/src/features/ocr/flow', () => ({ runOcr: h.runOcr, clean: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))
vi.mock('../../src/renderer/src/features/ocr/store', () => ({ useOcrUi: { getState: () => ({ show: h.show }) } }))

const { runOcrCommand: run } = await import('../../src/renderer/src/features/ocr/command')

beforeEach(() => {
  h.tabs = [
    { docId: 'a', numPages: 3, view: { page: 2 } },
    { docId: 'b', numPages: 8, view: { page: 5 } }
  ]
  h.active = h.tabs[0]
  h.toasts = []
  h.runOcr.mockClear()
  h.show.mockClear()
  h.call.mockClear()
  h.call.mockImplementation(async () => ({ languages: [], prefs: { ...DEFAULT_PREFS, languages: ['deu', 'eng'], dpi: 200 } }))
  ;(globalThis as unknown as { window: unknown }).window = { epdf: { call: h.call } }
})

describe('command ocr.run', () => {
  it('opens the dialog for the active document', async () => {
    await run()
    expect(h.show).toHaveBeenCalledWith('a', 3, 2)
    expect(h.runOcr).not.toHaveBeenCalled()
  })

  it('{ docId, dialog: true } opens the dialog for that document', async () => {
    await run({ docId: 'b', dialog: true })
    expect(h.show).toHaveBeenCalledWith('b', 8, 5)
    expect(h.runOcr).not.toHaveBeenCalled()
  })

  it('{ docId } alone (what Scanning sends) recognizes ALL pages of that document now, without a dialog', async () => {
    await run({ docId: 'b' })
    expect(h.show).not.toHaveBeenCalled()
    expect(h.runOcr.mock.calls[0][0]).toMatchObject({ docId: 'b', pages: 'all', languages: ['deu', 'eng'], silent: false, prefs: { dpi: 200 } })
  })

  it('tells the user to open a document first when there is none', async () => {
    h.active = undefined
    await run()
    expect(h.toasts).toEqual([{ kind: 'info', message: expect.stringMatching(/Open a document first/) }])
    await run({ docId: 'nope' })
    expect(h.toasts).toHaveLength(2)
    expect(h.show).not.toHaveBeenCalled()
  })

  it('silent: no success toast; all pages, the saved languages and options', async () => {
    await run({ docId: 'b', silent: true })
    expect(h.show).not.toHaveBeenCalled()
    expect(h.runOcr).toHaveBeenCalledTimes(1)
    expect(h.runOcr.mock.calls[0][0]).toMatchObject({
      docId: 'b',
      pages: 'all',
      languages: ['deu', 'eng'],
      silent: true,
      prefs: { dpi: 200, contrast: true, deskew: true, force: false }
    })
  })

  it('explicit languages are used instead of the saved ones (an empty list falls back to them)', async () => {
    await run({ docId: 'a', languages: ['fra'] })
    expect(h.runOcr.mock.calls[0][0]).toMatchObject({ docId: 'a', languages: ['fra'], pages: 'all' })
    await run({ docId: 'a', languages: [] })
    expect(h.runOcr.mock.calls[1][0]).toMatchObject({ docId: 'a', languages: ['deu', 'eng'] })
  })

  it('ignores junk arguments', async () => {
    await run('nonsense')
    await run(42)
    await run(null)
    expect(h.show).toHaveBeenCalledTimes(3)
  })

  it('reports a failure to read the saved options', async () => {
    h.call.mockRejectedValueOnce(new Error("Error invoking remote method 'feature:call': Error: boom"))
    await run({ docId: 'a' })
    expect(h.runOcr).not.toHaveBeenCalled()
    expect(h.toasts.at(-1)!.kind).toBe('error')
  })
})
