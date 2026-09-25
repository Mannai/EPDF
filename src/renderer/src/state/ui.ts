import { create } from 'zustand'

interface PasswordRequest {
  fileName: string
  incorrect: boolean
  resolve: (pw: string | null) => void
}

interface UiState {
  darkMode: boolean
  setDarkMode(v: boolean): void
  sidebarOpen: boolean
  setSidebarOpen(v: boolean): void
  dragging: boolean
  setDragging(v: boolean): void
  goToPageOpen: boolean
  setGoToPageOpen(v: boolean): void
  passwordRequest: PasswordRequest | null
  askPassword(fileName: string, incorrect: boolean): Promise<string | null>
  answerPassword(pw: string | null): void
  announcement: string
  announce(msg: string): void
}

export const useUi = create<UiState>((set, get) => ({
  darkMode: false,
  setDarkMode: (darkMode) => set({ darkMode }),
  sidebarOpen: true,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  dragging: false,
  setDragging: (dragging) => set({ dragging }),
  goToPageOpen: false,
  setGoToPageOpen: (goToPageOpen) => set({ goToPageOpen }),
  passwordRequest: null,
  askPassword: (fileName, incorrect) =>
    new Promise((resolve) => set({ passwordRequest: { fileName, incorrect, resolve } })),
  answerPassword: (pw) => {
    get().passwordRequest?.resolve(pw)
    set({ passwordRequest: null })
  },
  announcement: '',
  announce: (announcement) => set({ announcement })
}))
