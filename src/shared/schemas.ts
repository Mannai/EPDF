import { z } from 'zod'

export const ZoomModeSchema = z.enum(['custom', 'fit-width', 'fit-page'])
export const ViewModeSchema = z.enum(['continuous', 'single', 'two'])
export const ThemeSchema = z.enum(['system', 'light', 'dark'])

export const DocIdSchema = z.string().min(1).max(64)
export const FilePathSchema = z.string().min(1).max(4096)

export const DocViewStateSchema = z.object({
  page: z.number().int().min(1).max(1_000_000),
  zoom: z.number().min(0.05).max(16),
  zoomMode: ZoomModeSchema,
  viewMode: ViewModeSchema
})

export const DocHandleSchema = z.object({
  docId: DocIdSchema,
  path: FilePathSchema,
  name: z.string(),
  size: z.number(),
  mtime: z.number(),
  lastPage: z.number().int().min(1).optional(),
  /** An autosaved copy with unsaved edits exists (crash recovery). */
  hasRecovery: z.boolean().optional()
})

/** Settings whitelist: the only keys the renderer may read or write. */
export const SettingsSchema = z.object({
  theme: ThemeSchema,
  defaultViewMode: ViewModeSchema,
  defaultZoomMode: ZoomModeSchema,
  restoreOnLaunch: z.boolean(),
  sidebarOpen: z.boolean(),
  /** Delete / Backspace on something selected on a page (comment, shape, link, field...) asks first. */
  confirmDelete: z.boolean(),
  /** Saving a document with editable Fill & sign items: ask, lock them into the page, or keep them editable. */
  fillSignOnSave: z.enum(['ask', 'lock', 'keep'])
})
export const SettingKeySchema = SettingsSchema.keyof()

export const TabReportSchema = z.object({
  tabs: z
    .array(
      z.object({
        docId: DocIdSchema,
        path: FilePathSchema,
        view: DocViewStateSchema,
        /** Unsaved edits: main uses this to guard window close / app quit. */
        dirty: z.boolean().default(false)
      })
    )
    .max(500),
  activeDocId: DocIdSchema.nullable()
})

const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Expected bytes')

export const SaveRequestSchema = z.object({ docId: DocIdSchema, bytes: BytesSchema })
export const SaveAsRequestSchema = z.object({ docId: DocIdSchema, bytes: BytesSchema, suggestedName: z.string().max(255).optional() })
export const RecoveryWriteRequestSchema = z.object({ docId: DocIdSchema, bytes: BytesSchema })
export const VersionReadRequestSchema = z.object({ docId: DocIdSchema, versionId: z.number().int() })

/** Generic call into a feature-registered channel; main validates the payload with that feature's schema. */
export const FeatureCallRequestSchema = z.object({
  channel: z.string().regex(/^[a-z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*$/).max(80),
  payload: z.unknown()
})
export const CloseAckRequestSchema = z.undefined().optional()
/** `discard`: close now (the renderer already asked). `cancel`: the user backed out of closing/quitting. */
export const ForceCloseRequestSchema = z.object({ discard: z.boolean().optional(), cancel: z.boolean().optional() }).optional()

export const OpenDialogRequestSchema = z.object({ multi: z.boolean().optional() }).optional()
export const OpenPathRequestSchema = z.object({ path: FilePathSchema })
export const DocIdRequestSchema = z.object({ docId: DocIdSchema })
export const RecentRemoveRequestSchema = z.object({ path: FilePathSchema })
export const SettingsGetRequestSchema = z.object({ key: SettingKeySchema })
export const DetachTabRequestSchema = z.object({ docId: DocIdSchema, view: DocViewStateSchema })
export const DroppedPathsRequestSchema = z.object({ paths: z.array(FilePathSchema).max(200) })
export const SetDefaultRequestSchema = z.undefined().optional()
export const SetSettingRequestSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('theme'), value: ThemeSchema }),
  z.object({ key: z.literal('defaultViewMode'), value: ViewModeSchema }),
  z.object({ key: z.literal('defaultZoomMode'), value: ZoomModeSchema }),
  z.object({ key: z.literal('restoreOnLaunch'), value: z.boolean() }),
  z.object({ key: z.literal('sidebarOpen'), value: z.boolean() }),
  z.object({ key: z.literal('confirmDelete'), value: z.boolean() }),
  z.object({ key: z.literal('fillSignOnSave'), value: z.enum(['ask', 'lock', 'keep']) })
])
