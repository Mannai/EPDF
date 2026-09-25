import type { EpdfApi } from '../shared/ipc'

declare global {
  interface Window {
    epdf: EpdfApi
  }
}
