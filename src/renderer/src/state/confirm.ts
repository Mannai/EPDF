import { create } from 'zustand'

export interface ConfirmButton {
  label: string
  value: string
  /** Visual emphasis: the default action, or a destructive one. */
  variant?: 'primary' | 'danger'
}

export interface ConfirmRequest {
  title: string
  message: string
  buttons: ConfirmButton[]
  /** Value returned for Escape / clicking outside. Default: the last button's value. */
  cancelValue?: string
  resolve(value: string): void
}

interface ConfirmState {
  request: ConfirmRequest | null
}

export const useConfirm = create<ConfirmState>(() => ({ request: null }))

/**
 * Asks the user to choose. Resolves with the chosen button's `value`. Requests are queued one at a time.
 *
 *   const r = await askConfirm({ title: 'Save changes?', message: '…',
 *     buttons: [{ label: 'Save', value: 'save', variant: 'primary' }, { label: 'Cancel', value: 'cancel' }] })
 */
export function askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<string> {
  return new Promise((resolve) => {
    const run = (): void => {
      useConfirm.setState({
        request: {
          ...req,
          resolve: (v) => {
            useConfirm.setState({ request: null })
            resolve(v)
            // Let the next queued request (if any) show.
            queueMicrotask(() => queue.shift()?.())
          }
        }
      })
    }
    if (useConfirm.getState().request) queue.push(run)
    else run()
  })
}

const queue: (() => void)[] = []
