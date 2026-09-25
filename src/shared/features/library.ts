import { z } from 'zod'
import type { DocHandle } from '../types'
import type { SnippetPart } from './library/text'

/**
 * Contract between the Library UI (renderer) and its main-process half. The renderer never supplies a file
 * path: files are addressed by an opaque `ref` ("f12" = library file 12, "r7" = recent file 7) that main
 * validates on every use, and folders by numeric id.
 */

export type { SnippetPart }

export const INDEX_STATES = ['pending', 'indexed', 'no_text', 'unindexable', 'cloud', 'too_large'] as const
export type IndexState = (typeof INDEX_STATES)[number]

export const LIBRARY_LIMITS = {
  /** Files larger than this are not indexed unless the user asks (MB; adjustable in the Library settings). */
  defaultMaxFileMb: 200,
  defaultMaxDepth: 24,
  defaultMaxFilesPerFolder: 50_000,
  /** Pages are numbered inside a file's FTS rowid, so a file may contribute at most this many pages. */
  maxPagesPerFile: 20_000,
  pageSize: 100
} as const

export interface LibrarySettings {
  maxFileMb: number
  maxDepth: number
  maxFilesPerFolder: number
  /** Watch folders for changes (recursive `fs.watch`, with a periodic rescan as fallback). */
  watch: boolean
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  maxFileMb: LIBRARY_LIMITS.defaultMaxFileMb,
  maxDepth: LIBRARY_LIMITS.defaultMaxDepth,
  maxFilesPerFolder: LIBRARY_LIMITS.defaultMaxFilesPerFolder,
  watch: true
}

export type RootKind = 'folder' | 'onedrive' | 'gdrive' | 'dropbox' | 'icloud' | 'box' | 'documents' | 'downloads' | 'desktop'

export interface LibraryRoot {
  id: number
  path: string
  label: string
  kind: RootKind
  /** ok | missing (folder gone or drive not mounted) | unreadable */
  status: 'ok' | 'missing' | 'unreadable'
  /** Scan messages, e.g. "Stopped after 50,000 files" or "3 folders could not be read". */
  note: string
  lastScanAt: number | null
  files: number
  indexed: number
}

export interface LibraryCollection {
  id: number
  parentId: number | null
  name: string
  files: number
}

export interface LibraryItem {
  /** "f<id>" library file, "r<id>" a recent file that is not inside any watched folder. */
  ref: string
  name: string
  /** Absolute folder path, for display only. */
  dir: string
  size: number
  mtime: number | null
  pages: number | null
  favorite: boolean
  state: IndexState
  note: string
  /** Content is in the cloud only (not downloaded); opening it downloads it. */
  cloud: boolean
  hasThumb: boolean
  lastOpenedAt: number | null
  /** The watched folder's label ("OneDrive"), if the file belongs to one. */
  rootLabel: string | null
  inLibrary: boolean
}

export interface ContentHit {
  ref: string
  name: string
  dir: string
  page: number
  snippet: SnippetPart[]
  /** Text to pass to the in-document search when the hit is opened. */
  term: string
  favorite: boolean
  cloud: boolean
}

export interface LibraryStatus {
  running: boolean
  jobId: string | null
  phase: 'idle' | 'scanning' | 'indexing'
  rootLabel: string | null
  done: number
  total: number
  message: string
  /** Files that could not be read during the current or last run. */
  problems: number
}

export interface LibraryCounts {
  all: number
  recent: number
  favorites: number
  indexed: number
  pagesIndexed: number
  words: number
  notIndexable: number
  cloudOnly: number
  noText: number
  tooLarge: number
  pending: number
  dbBytes: number
}

export interface LibraryState {
  roots: LibraryRoot[]
  collections: LibraryCollection[]
  counts: LibraryCounts
  status: LibraryStatus
  settings: LibrarySettings
  fts: boolean
  /** A message the user should see (e.g. folder watching was switched off after a crash). */
  notice: string
}

export interface FolderSuggestion {
  key: string
  label: string
  path: string
  kind: RootKind
  /** True for cloud-sync folders (files may be online-only). */
  cloud: boolean
  added: boolean
}

export type Scope =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'favorites' }
  | { kind: 'root'; rootId: number; dir?: string }
  | { kind: 'collection'; id: number }

// ---- request schemas ------------------------------------------------------------------------------------------------

export const RefSchema = z.string().regex(/^[fr][1-9][0-9]{0,11}$/, 'Invalid file reference')
export const RefsSchema = z.array(RefSchema).min(1).max(500)
const IdSchema = z.number().int().positive()

export const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('recent') }),
  z.object({ kind: z.literal('favorites') }),
  z.object({ kind: z.literal('root'), rootId: IdSchema, dir: z.string().max(1024).optional() }),
  z.object({ kind: z.literal('collection'), id: IdSchema })
])

export const SORT_KEYS = ['name', 'folder', 'size', 'modified', 'pages', 'added', 'opened'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export const FILTERS = ['all', 'cloud', 'notIndexable', 'noText', 'tooLarge'] as const
export type LibraryFilter = (typeof FILTERS)[number]

export const ListRequestSchema = z.object({
  scope: ScopeSchema,
  name: z.string().max(200).optional(),
  sort: z.enum(SORT_KEYS).default('name'),
  descending: z.boolean().default(false),
  filter: z.enum(FILTERS).default('all'),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  limit: z.number().int().min(1).max(500).default(LIBRARY_LIMITS.pageSize)
})
export type ListRequest = z.input<typeof ListRequestSchema>

export const SearchRequestSchema = z.object({
  query: z.string().max(400),
  scope: ScopeSchema.default({ kind: 'all' }),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(200).default(50)
})
export type SearchRequest = z.input<typeof SearchRequestSchema>

export interface ListResult {
  items: LibraryItem[]
  total: number
}

export type SearchResult =
  | { ok: true; hits: ContentHit[]; total: number; capped: boolean; tookMs: number; terms: string[] }
  | { ok: false; error: string }

export const OpenRequestSchema = z.object({ refs: RefsSchema })
export interface OpenResult {
  handles: DocHandle[]
  failed: { ref: string; name: string; reason: string }[]
  /** Files that are cloud-only and were downloaded by the sync client because the user opened them. */
  downloaded: number
}

export const RefRequestSchema = z.object({ ref: RefSchema })
export const RootRequestSchema = z.object({ rootId: IdSchema })
export const FavoriteRequestSchema = z.object({ refs: RefsSchema, value: z.boolean() })
export const AddSuggestedSchema = z.object({ key: z.string().max(80) })
export const SyncRequestSchema = z.object({ rootId: IdSchema.optional() })
export const IndexFileRequestSchema = z.object({ ref: RefSchema })
export const ForgetRequestSchema = z.object({ keepFolders: z.boolean() })
export const TreeRequestSchema = z.object({ rootId: IdSchema })
export const NameRequestSchema = z.object({ name: z.string().min(1).max(200), parentId: IdSchema.nullable().optional() })
export const RenameCollectionSchema = z.object({ id: IdSchema, name: z.string().min(1).max(200) })
export const CollectionIdSchema = z.object({ id: IdSchema })
export const AddToCollectionSchema = z.object({ collectionId: IdSchema, refs: RefsSchema })
export const RemoveFromCollectionSchema = z.object({ collectionId: IdSchema, refs: RefsSchema })
export const ThumbsRequestSchema = z.object({ refs: z.array(RefSchema).max(200) })
export const SaveThumbSchema = z.object({ ref: RefSchema, png: z.instanceof(Uint8Array), pages: z.number().int().min(1).max(1_000_000).optional() })
export const SettingsPatchSchema = z.object({
  maxFileMb: z.number().int().min(1).max(4096).optional(),
  maxDepth: z.number().int().min(1).max(64).optional(),
  maxFilesPerFolder: z.number().int().min(100).max(1_000_000).optional(),
  watch: z.boolean().optional()
})

export interface CollectionCreated {
  id: number
}

export interface ThumbSource {
  docId: string
}

/** Sub-folders of a watched folder that contain library files (relative paths with `/`). */
export interface RootTree {
  rootId: number
  dirs: { dir: string; files: number }[]
}

export const MAX_THUMB_BYTES = 400_000

/** Ref helpers (pure; used by both sides and unit tests). */
export const fileRef = (id: number): string => `f${id}`
export const recentRef = (id: number): string => `r${id}`
export function parseRef(ref: unknown): { kind: 'file' | 'recent'; id: number } | null {
  if (typeof ref !== 'string') return null
  const m = /^([fr])([1-9][0-9]{0,11})$/.exec(ref)
  if (!m) return null
  const id = Number(m[2])
  return Number.isSafeInteger(id) ? { kind: m[1] === 'f' ? 'file' : 'recent', id } : null
}
