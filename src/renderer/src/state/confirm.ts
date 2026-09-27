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
  /** An unticked checkbox under the message (e.g. "Don't ask again"); its state comes back with the choice. */
  checkbox?: string
  resolve(value: string, checked?: boolean): void
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
  return askConfirmChecked(req).then((r) => r.value)
}

/** askConfirm() that also says whether the request's `checkbox` was ticked. */
export function askConfirmChecked(req: Omit<ConfirmRequest, 'resolve'>): Promise<{ value: string; checked: boolean }> {
  return new Promise((resolve) => {
    const run = (): void => {
      useConfirm.setState({
        request: {
          ...req,
          resolve: (v, checked) => {
            useConfirm.setState({ request: null })
            resolve({ value: v, checked: !!checked })
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
