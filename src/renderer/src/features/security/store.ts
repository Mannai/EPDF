import { create } from 'zustand'
import type { ProtectSettings } from '@shared/features/security'
import type { SecurityInfo } from './logic'

/** UI state of the Security feature's three dialogs. Nothing here is persisted; passwords live only while a dialog is open. */

export interface PasswordRequest {
  title: string
  /** Sentence shown above the field. */
  message: string
  incorrect: boolean
  confirmLabel: string
  resolve: (pw: string | null) => void
}

interface PasswordPromptState {
  request: PasswordRequest | null
  ask(opts: Omit<PasswordRequest, 'resolve'>): Promise<string | null>
  answer(pw: string | null): void
}

export const usePasswordPrompt = create<PasswordPromptState>((set, get) => ({
  request: null,
  ask: (opts) =>
    new Promise((resolve) => {
      // A newer prompt replaces an older unanswered one (which counts as cancelled).
      get().request?.resolve(null)
      set({ request: { ...opts, resolve } })
    }),
  answer: (pw) => {
    const r = get().request
    set({ request: null })
    r?.resolve(pw)
  }
}))

export interface ProtectRequest {
  docId: string
  fileName: string
  /** The document is already protected and being changed. */
  changing: boolean
  initial: ProtectSettings
  resolve: (settings: ProtectSettings | null) => void
}

interface ProtectDialogState {
  request: ProtectRequest | null
  ask(opts: Omit<ProtectRequest, 'resolve'>): Promise<ProtectSettings | null>
  answer(s: ProtectSettings | null): void
}

export const useProtectDialog = create<ProtectDialogState>((set, get) => ({
  request: null,
  ask: (opts) =>
    new Promise((resolve) => {
      get().request?.resolve(null)
      set({ request: { ...opts, resolve } })
    }),
  answer: (s) => {
    const r = get().request
    set({ request: null })
    r?.resolve(s)
  }
}))

interface InfoState {
  info: SecurityInfo | null
  show(i: SecurityInfo): void
  close(): void
}

export const useInfoDialog = create<InfoState>((set) => ({
  info: null,
  show: (info) => set({ info }),
  close: () => set({ info: null })
}))
