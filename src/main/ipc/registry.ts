import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { INVOKE, type InvokeChannel, type InvokeRequest, type InvokeResponses } from '../../shared/ipc'
import { isTrustedUrl } from '../security'

export type Handler<C extends InvokeChannel> = (
  req: InvokeRequest<C>,
  event: IpcMainInvokeEvent
) => Promise<InvokeResponses[C]> | InvokeResponses[C]

/**
 * Registers an IPC handler that (1) rejects calls from anything but our own top-level frame and
 * (2) validates the payload against its zod schema before the handler ever sees it.
 */
export function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !isTrustedUrl(frame.url)) {
      throw new Error(`Rejected IPC call to ${channel} from untrusted sender`)
    }
    const parsed = INVOKE[channel].req.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid request for ${channel}`)
    return fn(parsed.data as InvokeRequest<C>, event)
  })
}
