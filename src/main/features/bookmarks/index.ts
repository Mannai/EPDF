import { runInWorker } from '../../jobs/workerRunner'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { DETECT_JOB, DetectJobSchema, type DetectJobResult } from '../../../shared/features/bookmarks'
import type { MainContext } from '../api'
import createHeadingsWorker from './headingsWorker?nodeWorker'

/**
 * Main-process half of bookmarks: the heading-detection job (runs in a worker thread, with progress and Cancel
 * in the jobs tray) and the menu items. Reading and writing the outline itself happens in the renderer through
 * the edit pipeline.
 */
export function register(ctx: MainContext): void {
  ctx.jobs.register(DETECT_JOB, 'Finding headings for bookmarks', DetectJobSchema, (payload, job) => runInWorker<DetectJobResult>(createHeadingsWorker, payload, job))

  contributeMenu({
    menu: 'View',
    position: 'end',
    items: () => [{ type: 'separator' }, commandItem('Bookmarks Panel', 'bookmarks.toggle')]
  })
  contributeMenu({
    menu: 'Tools',
    position: 'end',
    items: () => [
      { type: 'separator' },
      commandItem('Add Bookmark Here', 'bookmarks.addHere'),
      commandItem('Generate Bookmarks from Headings…', 'bookmarks.generate')
    ]
  })
}
