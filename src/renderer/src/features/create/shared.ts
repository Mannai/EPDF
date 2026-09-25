import { create } from 'zustand'
import type { CreateEnvironment, CreateResult, Engine } from '@shared/features/create'
import { useTabs } from '../../state/tabs'
import { errorMessage, notify } from '../../state/notify'
import { JobCancelledError } from '../../state/jobs'

export const fmtSize = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// ---- environment (LibreOffice availability, saved engine) ---------------------------------------------

export async function loadEnvironment(): Promise<CreateEnvironment> {
  return window.epdf.call<CreateEnvironment>('create:environment', {})
}

export async function saveEngine(engine: Engine): Promise<void> {
  await window.epdf.call('create:setEngine', { engine })
}

// ---- result report ----------------------------------------------------------------------------------------

export interface ResultReport {
  title: string
  result: CreateResult
  /** Shown when the built-in engine made the file, so users know what "approximate" means. */
  approximate: boolean
}

export const useResultReport = create<{ report: ResultReport | null; show(r: ResultReport): void; close(): void }>((set) => ({
  report: null,
  show: (report) => set({ report }),
  close: () => set({ report: null })
}))

/** Opens saved PDFs in tabs (main returns the paths it wrote; the renderer asks main to register them). */
export async function openSaved(paths: string[]): Promise<void> {
  const handles = []
  for (const p of paths) {
    const h = await window.epdf.openPath(p)
    if (h) handles.push(h)
  }
  if (handles.length) useTabs.getState().addHandles(handles)
}

/** Common follow-up for every job that produces PDFs: open them, tell the user, and list any notes. */
export async function finishJob(result: CreateResult, title: string, approximate: boolean): Promise<void> {
  if (result.cancelled) {
    notify('info', 'Nothing was saved.')
    return
  }
  await openSaved(result.saved.map((s) => s.path))
  const first = result.saved[0]
  if (result.saved.length === 1 && first) notify('success', `Created “${first.name}”${first.pages ? ` (${plural(first.pages, 'page')})` : ''}.`)
  else if (result.saved.length > 1) notify('success', `Created ${result.saved.length} PDFs.`)
  if (result.notes.length || result.failed.length) useResultReport.getState().show({ title, result, approximate })
}

export function reportJobError(err: unknown, what: string): void {
  if (err instanceof JobCancelledError) return void notify('info', `${what} was cancelled.`)
  notify('error', errorMessage(err))
}
