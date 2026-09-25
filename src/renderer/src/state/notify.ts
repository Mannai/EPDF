import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: { label: string; run(): void }
}

interface ToastState {
  toasts: Toast[]
  dismiss(id: number): void
}

let nextId = 1
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/**
 * Shows a non-blocking message. Errors are announced assertively to screen readers and stay longer.
 *   notify('error', 'Could not save: disk is full')
 */
export function notify(kind: ToastKind, message: string, action?: Toast['action']): void {
  const id = nextId++
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, action }] }))
  setTimeout(() => useToasts.getState().dismiss(id), kind === 'error' ? 12000 : 5000)
}

/** A user-presentable string for anything thrown. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
