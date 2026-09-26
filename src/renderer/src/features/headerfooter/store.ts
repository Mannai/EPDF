import { create } from 'zustand'
import type { MarkGroup } from '@shared/features/headerfooter'

/** Which page-marks dialog is open, for which document, on which tab. */
interface HfUi {
  open: { docId: string; group: MarkGroup; page: number } | null
  show(docId: string, group: MarkGroup, page: number): void
  close(): void
}

export const useHfUi = create<HfUi>((set) => ({
  open: null,
  show: (docId, group, page) => set({ open: { docId, group, page } }),
  close: () => set({ open: null })
}))

export const GROUP_LABEL: Record<MarkGroup, string> = {
  headerfooter: 'Header and footer',
  bates: 'Bates numbering',
  watermark: 'Watermark',
  background: 'Background'
}

/** Plural nouns for messages. */
export const GROUP_NOUN: Record<MarkGroup, string> = {
  headerfooter: 'headers and footers',
  bates: 'Bates numbers',
  watermark: 'watermarks',
  background: 'backgrounds'
}
