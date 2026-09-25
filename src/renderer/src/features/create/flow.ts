import { create } from 'zustand'
import { KIND_LABEL, normalizeWebUrl, type CreateEnvironment, type CreateResult, type Engine, type ImageOptions, type PickResult, type PickedFile } from '@shared/features/create'
import { startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { finishJob, loadEnvironment, reportJobError, saveEngine } from './shared'

/** State + actions of the "Create PDF from File…" and "Create PDF from Web Page…" dialogs. */

interface CreateUi {
  mode: 'closed' | 'files' | 'web'
  files: PickedFile[]
  env: CreateEnvironment | null
  images: ImageOptions
  engine: Engine
  url: string
  javascript: boolean
  setImages(o: ImageOptions): void
  setEngine(e: Engine): void
  setUrl(u: string): void
  setJavascript(b: boolean): void
  remove(id: string): void
  close(): void
}

export const useCreateUi = create<CreateUi>((set) => ({
  mode: 'closed',
  files: [],
  env: null,
  images: { pageSize: 'image' },
  engine: 'builtin',
  url: '',
  javascript: true,
  setImages: (images) => set({ images }),
  setEngine: (engine) => {
    set({ engine })
    void saveEngine(engine).catch(() => undefined)
  },
  setUrl: (url) => set({ url }),
  setJavascript: (javascript) => set({ javascript }),
  remove: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  close: () => set({ mode: 'closed', files: [] })
}))

export const isOffice = (f: PickedFile): boolean => f.kind === 'office'
export const isImageLike = (f: PickedFile): boolean => f.kind === 'image' || f.kind === 'tiff' || f.kind === 'heic'

export const describeKind = (f: PickedFile): string => KIND_LABEL[f.kind]

/** Reports files main refused (unsupported type, already a PDF, unreadable). */
export function reportSkipped(r: PickResult): void {
  if (r.skipped.length === 0) return
  const list = r.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')
  notify('error', r.skipped.length === 1 ? `Skipped ${list}` : `Skipped ${r.skipped.length} files: ${list}`)
}

export async function startCreateFromFiles(): Promise<void> {
  let picked: PickResult
  try {
    picked = await window.epdf.call<PickResult>('create:pick', { purpose: 'create' })
  } catch (err) {
    return void notify('error', errorMessage(err))
  }
  reportSkipped(picked)
  if (picked.files.length === 0) return
  let env: CreateEnvironment | null = null
  try {
    env = await loadEnvironment()
  } catch {
    /* the dialog works without it: LibreOffice just shows as unavailable */
  }
  useCreateUi.setState({ mode: 'files', files: picked.files, env, engine: env?.engine === 'libreoffice' && env.soffice ? 'libreoffice' : 'builtin', images: { pageSize: 'image' } })
}

export function startCreateFromWeb(): void {
  useCreateUi.setState({ mode: 'web', url: '', javascript: true })
}

export function runCreateFiles(): void {
  const s = useCreateUi.getState()
  if (s.files.length === 0) return
  const ids = s.files.map((f) => f.id)
  const approximate = s.engine === 'builtin' && s.files.some((f) => f.kind === 'office')
  useCreateUi.getState().close()
  const { promise } = startJob<CreateResult>('create:convert', { ids, images: s.images, engine: s.engine, saveMode: 'ask', openInApp: false })
  promise.then((r) => finishJob(r, 'Create PDF', approximate)).catch((err) => reportJobError(err, 'Creating the PDF'))
}

export function urlProblem(url: string): string | null {
  if (!url.trim()) return null
  const c = normalizeWebUrl(url)
  return c.ok ? null : c.error
}

export function runCreateWeb(): void {
  const s = useCreateUi.getState()
  const check = normalizeWebUrl(s.url)
  if (!check.ok) return
  useCreateUi.getState().close()
  const { promise } = startJob<CreateResult>('create:web', { url: check.url, javascript: s.javascript, openInApp: false })
  promise.then((r) => finishJob(r, 'Create PDF from web page', false)).catch((err) => reportJobError(err, 'Creating the PDF from the web page'))
}
