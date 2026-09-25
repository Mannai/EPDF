import { PrepareJobSchema, PrintAddPageRequestSchema, PrintBeginRequestSchema, PrintCancelRequestSchema, PrintRunRequestSchema } from '../../../shared/features/print'
import { SaveBytesRequestSchema } from '../../../shared/features/pages'
import { runInWorker } from '../../jobs/workerRunner'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, type MainContext } from '../api'
import { saveBytesWithDialog } from '../pages/files'
import createPdfWorker from '../pages/pdfWorker?nodeWorker'
import type { WorkerResult } from '../pages/pdfWorker'
import { addPage, beginJob, cancelJob, cancelJobsOf, runJob } from './printJobs'

/** Main-process half of printing: the "prepare" job, the job channels, and the File-menu items. */
export function register(ctx: MainContext): void {
  // Building the pages to print (range, annotations, scaling) is heavy for big documents, so it is a job.
  ctx.jobs.register('print:prepare', 'Preparing pages', PrepareJobSchema, async (p, job): Promise<Uint8Array> => {
    const res = await runInWorker<WorkerResult>(createPdfWorker, { task: 'prepare', ...p }, job)
    if (res.task !== 'prepare') throw new Error('Unexpected result from the print worker.')
    return res.bytes
  })

  registerFeatureChannel('print:begin', PrintBeginRequestSchema, ({ pageCount }, call) => {
    const owner = call.window?.win.id
    const jobId = beginJob(pageCount, owner)
    call.window?.win.once('closed', () => cancelJobsOf(owner!))
    return { jobId }
  })

  registerFeatureChannel('print:addPage', PrintAddPageRequestSchema, (req, call) => {
    addPage(req.jobId, call.window?.win.id, req.index, req.jpeg, req.widthPt, req.heightPt)
  })

  registerFeatureChannel('print:run', PrintRunRequestSchema, ({ jobId, ...rest }, call) => runJob(jobId, call.window?.win.id, rest))

  registerFeatureChannel('print:cancel', PrintCancelRequestSchema, ({ jobId }, call) => cancelJob(jobId, call.window?.win.id))

  // "Print to PDF": writes the prepared (vector) PDF chosen in the dialog.
  registerFeatureChannel('print:savePdf', SaveBytesRequestSchema, (req, call) => saveBytesWithDialog(ctx, call, req))

  contributeMenu({
    menu: 'File',
    position: 'end',
    items: () => [
      { type: 'separator' },
      commandItem('Print…', 'print.open', 'CmdOrCtrl+P'),
      commandItem('Print to PDF…', 'print.toPdf')
    ]
  })
}
