import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CombineRunPayloadSchema } from '../../../shared/features/combine'
import {
  CreateConvertPayloadSchema,
  CreatePrefsSchema,
  CreateWebPayloadSchema,
  PickRequestSchema,
  SOURCE_EXTENSIONS,
  fileNameForUrl,
  normalizeWebUrl,
  type CreateEnvironment,
  type CreateResult,
  type PickResult
} from '../../../shared/features/create'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { runInWorker } from '../../jobs/workerRunner'
import type { JobContext } from '../../jobs/JobManager'
import { atomicWrite } from '../../services/fileService'
import { resolveTool } from '../../services/tools'
import type { MainContext } from '../api'
import { registerFeatureChannel, sendFeatureEvent } from '../api'
import createWorker from './worker?nodeWorker'
import { extractVerb, type Verb } from './argv'
import { heicToJpeg } from './heic'
import { convertWithLibreOffice, discoverSoffice, SOFFICE_HELP } from './libreoffice'
import { CreatePrefsStore } from './prefs'
import {
  SourceRegistry,
  baseNameOf,
  convertAll,
  convertSource,
  dirOf,
  describeFile,
  toPicked,
  uniquePdfPath,
  type PipelineDeps,
  type Source
} from './pipeline'
import type { PdfResult, ProbeResult } from './workerOps'
import { defaultPaper, renderWebPage } from './webPage'

/** Main half of Create PDF + Combine Files (File menu, jobs, command-line verbs). Export lives in ../export. */

const CAN_CREATE = [...SOURCE_EXTENSIONS.image, ...SOURCE_EXTENSIONS.tiff, ...SOURCE_EXTENSIONS.heic, ...SOURCE_EXTENSIONS.office]

export function register(ctx: MainContext): void {
  const registry = new SourceRegistry()
  const prefs = new CreatePrefsStore(app.getPath('userData'))
  const fontsDir = app.isPackaged ? join(process.resourcesPath, 'fonts') : join(app.getAppPath(), 'resources', 'fonts')
  const findSoffice = (): string | null => discoverSoffice({ resolveTool })
  const paper = defaultPaper() === 'Letter' ? { width: 612, height: 792 } : { width: 595.28, height: 841.89 }

  const deps: PipelineDeps = {
    fontsDir,
    page: paper,
    run: (req, jobCtx) => runInWorker<PdfResult | ProbeResult>(createWorker, req, jobCtx),
    heicToJpeg: ({ path, name }, jobCtx) => heicToJpeg({ inputPath: path, inputName: name, ctx: jobCtx }),
    findSoffice,
    convertWithLibreOffice: (job, jobCtx) => convertWithLibreOffice({ ...job, ctx: jobCtx })
  }

  const parentWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? ctx.windows.focused()?.win

  // ---- environment / preferences ----------------------------------------------------------------------
  const environment = (): CreateEnvironment => ({
    soffice: findSoffice(),
    engine: prefs.get().engine,
    sofficeHelp: SOFFICE_HELP,
    platform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
  })
  registerFeatureChannel('create:environment', z.object({}), () => environment())
  registerFeatureChannel('create:setEngine', CreatePrefsSchema, async (p) => (await prefs.set(p)).engine)

  // ---- picking files -----------------------------------------------------------------------------------
  async function describePaths(paths: string[], purpose: 'create' | 'combine', jobCtx?: JobContext): Promise<PickResult> {
    const files: PickResult['files'] = []
    const skipped: PickResult['skipped'] = []
    const pdfs: Source[] = []
    for (const p of paths) {
      const d = await describeFile(p)
      const name = p.split(/[\\/]/).pop() ?? p
      if ('skip' in d) {
        skipped.push({ name, reason: d.skip })
        continue
      }
      if (d.kind === 'pdf' && purpose === 'create') {
        skipped.push({ name, reason: 'This file is already a PDF. Use Combine Files to merge PDFs.' })
        continue
      }
      const src = registry.register(d)
      if (src.kind === 'pdf') pdfs.push(src)
      files.push(toPicked(src))
    }
    if (pdfs.length) {
      const ac = new AbortController()
      const probe = (await runInWorker<ProbeResult>(createWorker, { op: 'probe', files: pdfs.map((s) => ({ path: s.path, name: s.name })) }, jobCtx ?? { signal: ac.signal, progress: () => undefined }).catch(() => [])) as ProbeResult
      pdfs.forEach((s, i) => {
        const r = probe[i]
        const picked = files.find((f) => f.id === s.id)!
        if (r && 'pages' in r) {
          s.pages = r.pages
          picked.pages = r.pages
        } else if (r) {
          s.problem = r.problem
          picked.problem = r.problem
        }
      })
    }
    return { files, skipped }
  }

  registerFeatureChannel('create:pick', PickRequestSchema, async ({ purpose }): Promise<PickResult> => {
    const exts = purpose === 'combine' ? [...SOURCE_EXTENSIONS.pdf, ...CAN_CREATE] : CAN_CREATE
    const opts: Electron.OpenDialogOptions = {
      title: purpose === 'combine' ? 'Choose files to combine' : 'Choose files to convert to PDF',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported files', extensions: exts },
        ...(purpose === 'combine' ? [{ name: 'PDF documents', extensions: SOURCE_EXTENSIONS.pdf as unknown as string[] }] : []),
        { name: 'Images', extensions: [...SOURCE_EXTENSIONS.image, ...SOURCE_EXTENSIONS.tiff, ...SOURCE_EXTENSIONS.heic] },
        { name: 'Office documents', extensions: SOURCE_EXTENSIONS.office as unknown as string[] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const parent = parentWindow()
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { files: [], skipped: [] }
    return describePaths(res.filePaths, purpose)
  })

  // ---- saving ------------------------------------------------------------------------------------------
  const saveDialog = async (defaultPath: string): Promise<string | null> => {
    const opts: Electron.SaveDialogOptions = { title: 'Save PDF', defaultPath, filters: [{ name: 'PDF documents', extensions: ['pdf'] }] }
    const parent = parentWindow()
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    return /\.pdf$/i.test(res.filePath) ? res.filePath : `${res.filePath}.pdf`
  }
  const folderDialog = async (): Promise<string | null> => {
    const opts: Electron.OpenDialogOptions = { title: 'Choose a folder for the PDFs', properties: ['openDirectory', 'createDirectory'] }
    const parent = parentWindow()
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  }
  const openSaved = async (paths: string[]): Promise<void> => {
    if (paths.length) await ctx.controller.openPaths(paths)
  }

  // ---- Create PDF from files --------------------------------------------------------------------------
  ctx.jobs.register('create:convert', 'Creating PDF', CreateConvertPayloadSchema, async (p, jobCtx): Promise<CreateResult> => {
    const sources = p.ids.map((id) => registry.require(id))
    const batch = await convertAll(sources, deps, { images: p.images, engine: p.engine }, { signal: jobCtx.signal, progress: (f, m) => jobCtx.progress(f * 0.9, m) })
    const notes = batch.ok.flatMap((o) => o.converted.warnings.map((w) => `${o.converted.source.name}: ${w}`))
    if (batch.ok.length === 0) throw new Error(batch.failed.length === 1 ? batch.failed[0].error : batch.failed.map((f) => `${f.name}: ${f.error}`).join('\n'))

    jobCtx.progress(0.92, 'Saving')
    const saved: CreateResult['saved'] = []
    if (p.saveMode === 'beside') {
      const taken = new Set<string>()
      for (const o of batch.ok) {
        const target = uniquePdfPath(dirOf(o.converted.source.path), baseNameOf(o.converted.source.name), existsSync, taken)
        await atomicWrite(target, o.bytes)
        saved.push({ path: target, name: target.split(/[\\/]/).pop()!, pages: o.converted.pages ?? 0 })
      }
    } else if (batch.ok.length === 1) {
      const o = batch.ok[0]
      const target = await saveDialog(uniquePdfPath(dirOf(o.converted.source.path), baseNameOf(o.converted.source.name), existsSync))
      if (!target) return { saved: [], failed: batch.failed, cancelled: true, notes }
      await atomicWrite(target, o.bytes)
      saved.push({ path: target, name: target.split(/[\\/]/).pop()!, pages: o.converted.pages ?? 0 })
    } else {
      const dir = await folderDialog()
      if (!dir) return { saved: [], failed: batch.failed, cancelled: true, notes }
      const taken = new Set<string>()
      for (const o of batch.ok) {
        const target = uniquePdfPath(dir, baseNameOf(o.converted.source.name), existsSync, taken)
        await atomicWrite(target, o.bytes)
        saved.push({ path: target, name: target.split(/[\\/]/).pop()!, pages: o.converted.pages ?? 0 })
      }
    }
    if (p.openInApp) await openSaved(saved.map((s) => s.path))
    return { saved, failed: batch.failed, notes }
  })

  // ---- Create PDF from a web page ---------------------------------------------------------------------
  ctx.jobs.register('create:web', 'Creating PDF from web page', CreateWebPayloadSchema, async (p, jobCtx): Promise<CreateResult> => {
    const check = normalizeWebUrl(p.url)
    if (!check.ok) throw new Error(check.error)
    jobCtx.progress(0.05, 'Loading page')
    const r = await renderWebPage({ url: check.url, javascript: p.javascript, signal: jobCtx.signal })
    const notes: string[] = []
    if (r.status !== null && r.status >= 400) notes.push(`The website answered with status ${r.status}, so the PDF shows the page it sent back (probably an error page).`)
    const pages = ((await deps.run({ op: 'pageCount', bytes: r.bytes }, jobCtx)) as PdfResult).pages
    jobCtx.progress(0.9, 'Saving')
    const base = r.title && r.title.trim() ? r.title.trim().slice(0, 60) : fileNameForUrl(check.url)
    const target = await saveDialog(uniquePdfPath(app.getPath('documents'), base, existsSync))
    if (!target) return { saved: [], failed: [], cancelled: true, notes }
    await atomicWrite(target, r.bytes)
    if (p.openInApp) await openSaved([target])
    return { saved: [{ path: target, name: target.split(/[\\/]/).pop()!, pages }], failed: [], notes }
  })

  // ---- Combine ------------------------------------------------------------------------------------------
  ctx.jobs.register('combine:run', 'Combining files', CombineRunPayloadSchema, async (p, jobCtx): Promise<CreateResult> => {
    const items = p.items.map((it) => ({ src: registry.require(it.id), range: it.range?.trim() || undefined }))
    const engine = p.engine
    const merged: { name: string; path?: string; bytes?: Uint8Array; range?: string }[] = []
    const notes: string[] = []
    for (let i = 0; i < items.length; i++) {
      if (jobCtx.signal.aborted) throw new Error('Cancelled')
      const { src, range } = items[i]
      if (src.problem) throw new Error(src.problem)
      const sub: JobContext = { signal: jobCtx.signal, progress: (f, m) => jobCtx.progress(((i + f) / items.length) * 0.7, m ?? `Converting ${src.name}`) }
      sub.progress(0, `Converting ${src.name}`)
      let conv
      try {
        conv = await convertSource(src, deps, { images: p.images, engine }, sub)
      } catch (err) {
        if (err instanceof Error && err.message === 'Cancelled') throw err
        throw new Error(`${err instanceof Error ? err.message : String(err)} Remove “${src.name}” from the list or fix the file, then try again.`)
      }
      notes.push(...conv.warnings.map((w) => `${src.name}: ${w}`))
      merged.push('path' in conv.pdf ? { name: src.name, path: conv.pdf.path, range } : { name: src.name, bytes: conv.pdf.bytes, range })
    }
    jobCtx.progress(0.72, 'Merging')
    const r = (await runInWorker<PdfResult>(createWorker, { op: 'merge', items: merged, bookmarks: p.bookmarks }, { signal: jobCtx.signal, progress: (f, m) => jobCtx.progress(0.72 + f * 0.24, m) })) as PdfResult
    notes.push(...r.warnings)
    jobCtx.progress(0.97, 'Saving')
    const first = items[0].src
    const target = await saveDialog(uniquePdfPath(dirOf(first.path), 'Combined', existsSync))
    if (!target) return { saved: [], failed: [], cancelled: true, notes }
    await atomicWrite(target, r.bytes)
    if (p.openInApp) await openSaved([target])
    return { saved: [{ path: target, name: target.split(/[\\/]/).pop()!, pages: r.pages }], failed: [], notes }
  })

  // ---- command-line verbs ------------------------------------------------------------------------------
  let pendingCombine: PickResult | null = null
  registerFeatureChannel('combine:takePending', z.object({}), () => {
    const p = pendingCombine
    pendingCombine = null
    return p
  })

  const waitForWindow = async (): Promise<void> => {
    for (let i = 0; i < 100 && ctx.windows.all().length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    if (ctx.windows.all().length === 0) ctx.controller.newWindow()
  }

  async function handleVerb(v: Verb): Promise<void> {
    if (v.files.length === 0) return
    await waitForWindow()
    if (v.verb === 'convert') {
      const picked = await describePaths(v.files, 'create')
      if (picked.skipped.length) {
        void dialog.showMessageBox({ type: 'warning', title: 'Epdf', message: 'Some files were not converted', detail: picked.skipped.map((s) => `${s.name}: ${s.reason}`).join('\n') })
      }
      if (picked.files.length === 0) return
      const engine = prefs.get().engine === 'libreoffice' && findSoffice() ? 'libreoffice' : 'builtin'
      ctx.jobs.start('create:convert', { ids: picked.files.map((f) => f.id), saveMode: 'beside', openInApp: true, engine })
    } else {
      // Explorer starts one process per selected file: every call adds to the screen that is (or is about to be) open.
      const more = await describePaths(v.files, 'combine')
      pendingCombine = { files: [...(pendingCombine?.files ?? []), ...more.files], skipped: [...(pendingCombine?.skipped ?? []), ...more.skipped] }
      const w = ctx.windows.focused()
      if (w) {
        w.win.show()
        w.win.focus()
        sendFeatureEvent(w, 'combine:pending', {})
      }
    }
  }

  // The app's own argv handling (src/main/index.ts) opens every `.pdf` in argv as a tab, so verbs and their
  // files are removed from argv first. Feature modules load before that code reads process.argv and their
  // 'second-instance' listener is registered before the core one.
  const startup = extractVerb(process.argv)
  if (startup) void handleVerb(startup)
  app.on('second-instance', (_e, argv, cwd) => {
    const v = extractVerb(argv, cwd)
    if (v) void handleVerb(v)
  })

  contributeMenu({
    menu: 'File',
    position: 'start',
    items: () => [
      commandItem('Create PDF from File…', 'create.fromFiles'),
      commandItem('Create PDF from Web Page…', 'create.fromWeb'),
      commandItem('Combine Files…', 'combine.open')
    ]
  })
}
