import { shell } from 'electron'
import { SplitJobSchema, PickFolderRequestSchema, PickPdfRequestSchema, SaveBytesRequestSchema, TokenRequestSchema, type SplitResult } from '../../../shared/features/pages'
import { PrepareJobSchema } from '../../../shared/features/print'
import { runInWorker } from '../../jobs/workerRunner'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, type MainContext } from '../api'
import { pickFolder, pickPdf, saveBytesWithDialog, writeSplitFiles } from './files'
import createPdfWorker from './pdfWorker?nodeWorker'
import type { WorkerResult } from './pdfWorker'
import { issueToken, resolveToken } from './tokens'

/**
 * Main-process half of the page tools. Everything that touches the file system lives here behind validated
 * channels: the renderer only ever passes bytes and opaque tokens, never paths.
 */
export function register(ctx: MainContext): void {
  registerFeatureChannel('pages:pickPdf', PickPdfRequestSchema, (_req, call) => pickPdf(call))
  registerFeatureChannel('pages:pickFolder', PickFolderRequestSchema, (_req, call) => pickFolder(call))
  registerFeatureChannel('pages:saveExtract', SaveBytesRequestSchema, (req, call) => saveBytesWithDialog(ctx, call, req))

  registerFeatureChannel('pages:openSaved', TokenRequestSchema, async ({ token }, call) => {
    const entry = resolveToken(token)
    if (!entry || entry.kind !== 'file') throw new Error('That file is no longer available.')
    await ctx.controller.openPaths([entry.path], call.window)
  })

  registerFeatureChannel('pages:reveal', TokenRequestSchema, async ({ token }) => {
    const entry = resolveToken(token)
    if (!entry) throw new Error('That location is no longer available.')
    if (entry.kind === 'file') shell.showItemInFolder(entry.path)
    else await shell.openPath(entry.path)
  })

  // Extracting pages into a new document is the "prepare" task without scaling: same worker, its own title.
  ctx.jobs.register('pages:extract', 'Extracting pages', PrepareJobSchema, async (p, job): Promise<Uint8Array> => {
    const res = await runInWorker<WorkerResult>(createPdfWorker, { task: 'prepare', ...p }, job)
    if (res.task !== 'prepare') throw new Error('Unexpected result from the extract worker.')
    return res.bytes
  })

  ctx.jobs.register('pages:split', 'Splitting document', SplitJobSchema, async (p, job): Promise<SplitResult> => {
    const folder = resolveToken(p.folderToken)
    if (!folder || folder.kind !== 'folder') throw new Error('The output folder is no longer available. Choose it again.')
    const res = await runInWorker<WorkerResult>(createPdfWorker, { task: 'split', bytes: p.bytes, spec: p.spec }, job)
    if (res.task !== 'split') throw new Error('Unexpected result from the split worker.')
    job.progress(0.97, 'Saving files')
    const written = await writeSplitFiles(folder.path, p.baseName, res.parts, job.signal)
    return {
      folderToken: p.folderToken,
      warnings: res.warnings,
      files: written.map((w, i) => ({
        name: w.name,
        size: w.size,
        token: issueToken({ path: w.path, kind: 'file' }),
        label: res.parts[i].label,
        pages: res.parts[i].pages,
        oversized: res.parts[i].oversized
      }))
    }
  })

  contributeMenu({
    menu: 'Document',
    position: 'end',
    items: () => [
      { type: 'separator' },
      commandItem('Organize Pages…', 'pages.organize'),
      commandItem('Insert Pages…', 'pages.insert'),
      commandItem('Extract Pages…', 'pages.extract'),
      commandItem('Delete Pages…', 'pages.delete'),
      commandItem('Split Document…', 'pages.split'),
      { type: 'separator' },
      commandItem('Rotate Page Clockwise', 'page.rotateCW', 'CmdOrCtrl+]'),
      commandItem('Rotate Page Counterclockwise', 'page.rotateCCW', 'CmdOrCtrl+['),
      commandItem('Rotate Pages…', 'pages.rotate')
    ]
  })
}
