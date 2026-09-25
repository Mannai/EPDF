import type { SaveSignatureRequest, SaveSignatureResult, SignatureKind, SignatureRecord, SignatureStatus } from '@shared/features/sign'
import { create } from 'zustand'

export interface SignatureItem extends SignatureRecord {
  /** `data:` URL for <img> previews. */
  url: string
}

const toDataUrl = (png: Uint8Array): string => {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < png.length; i += chunk) bin += String.fromCharCode(...png.subarray(i, i + chunk))
  return `data:image/png;base64,${btoa(bin)}`
}

interface SignState {
  items: SignatureItem[]
  loaded: boolean
  /** Null until known. */
  encryptionAvailable: boolean | null
  selected: Record<SignatureKind, number | null>
  dialogOpen: boolean
  /** Which kind the dialog should start creating. */
  dialogKind: SignatureKind
  withDate: boolean
  refresh(): Promise<void>
  save(req: SaveSignatureRequest): Promise<SaveSignatureResult>
  remove(id: number): Promise<void>
  select(kind: SignatureKind, id: number | null): void
  openDialog(kind?: SignatureKind): void
  closeDialog(): void
  setWithDate(v: boolean): void
}

export const useSignatures = create<SignState>((set, get) => ({
  items: [],
  loaded: false,
  encryptionAvailable: null,
  selected: { signature: null, initials: null },
  dialogOpen: false,
  dialogKind: 'signature',
  withDate: false,

  refresh: async () => {
    const [records, status] = await Promise.all([
      window.epdf.call<SignatureRecord[]>('sign:list', {}),
      window.epdf.call<SignatureStatus>('sign:status', {})
    ])
    const items = records.map((r) => ({ ...r, png: new Uint8Array(r.png), url: toDataUrl(r.png) }))
    set((s) => {
      const selected = { ...s.selected }
      for (const kind of ['signature', 'initials'] as const) {
        const cur = selected[kind]
        if (cur === null || !items.some((i) => i.id === cur)) selected[kind] = items.find((i) => i.kind === kind)?.id ?? null
      }
      return { items, loaded: true, encryptionAvailable: status.encryptionAvailable, selected }
    })
  },

  save: async (req) => {
    const res = await window.epdf.call<SaveSignatureResult>('sign:save', req)
    if (res.ok) {
      await get().refresh()
      set((s) => ({ selected: { ...s.selected, [req.kind]: res.id } }))
    } else if (res.code === 'encryption-unavailable') {
      set({ encryptionAvailable: false })
    }
    return res
  },

  remove: async (id) => {
    await window.epdf.call('sign:delete', { id })
    await get().refresh()
  },

  select: (kind, id) => set((s) => ({ selected: { ...s.selected, [kind]: id } })),
  openDialog: (kind) => set((s) => ({ dialogOpen: true, dialogKind: kind ?? s.dialogKind })),
  closeDialog: () => set({ dialogOpen: false }),
  setWithDate: (withDate) => set({ withDate })
}))

export const selectedItem = (s: SignState, kind: SignatureKind): SignatureItem | undefined => s.items.find((i) => i.id === s.selected[kind])
