import { BatchPickRequestSchema, BatchReadRequestSchema, BatchWriteRequestSchema, COMPRESS_CHANNELS } from '../../../shared/features/compress'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, type MainContext } from '../api'
import { pickFiles, readPicked, writeReduced } from './batch'

/**
 * Main-process half of "Reduce File Size". The single-document mode needs nothing here but the menu items: compression runs in a
 * renderer Web Worker on bytes the renderer already holds (the document's current edit state). Batch mode reads and writes files
 * from disk, so its channels live here, behind native dialogs and opaque tokens.
 */
export function register(_ctx: MainContext): void {
  registerFeatureChannel(COMPRESS_CHANNELS.batchPick, BatchPickRequestSchema, (_req, call) => pickFiles(call))
  registerFeatureChannel(COMPRESS_CHANNELS.batchRead, BatchReadRequestSchema, ({ token }) => readPicked(token))
  registerFeatureChannel(COMPRESS_CHANNELS.batchWrite, BatchWriteRequestSchema, ({ token, bytes }) => writeReduced(token, bytes))

  contributeMenu({
    menu: 'File',
    position: 'end',
    items: () => [{ type: 'separator' }, commandItem('Reduce File Size…', 'compress.open'), commandItem('Reduce Several Files…', 'compress.batch')]
  })
}
