import type {
  CollectionCreated,
  FolderSuggestion,
  LibraryFilter,
  LibrarySettings,
  LibraryState,
  ListResult,
  OpenResult,
  RootTree,
  Scope,
  SearchResult,
  SortKey,
  ThumbSource
} from '@shared/features/library'

type Result = { ok: true; id?: number; message?: string } | { ok: false; error: string }

const call = <T>(channel: string, payload: unknown = {}): Promise<T> => window.epdf.call<T>(channel, payload)

/** Typed wrappers for the `library:*` channels of the main process. Paths never appear here: only refs and ids. */
export const libraryApi = {
  state: (): Promise<LibraryState> => call('library:state'),
  suggestions: (): Promise<FolderSuggestion[]> => call('library:suggestions'),
  addFolder: (): Promise<Result> => call('library:addFolder'),
  addSuggested: (key: string): Promise<Result> => call('library:addSuggested', { key }),
  removeFolder: (rootId: number): Promise<void> => call('library:removeFolder', { rootId }),
  rescan: (rootId?: number): Promise<void> => call('library:rescan', { rootId }),
  cancel: (): Promise<void> => call('library:cancel'),
  forget: (keepFolders: boolean): Promise<void> => call('library:forget', { keepFolders }),
  settings: (patch: Partial<LibrarySettings>): Promise<LibrarySettings> => call('library:settings', patch),
  indexAnyway: (ref: string): Promise<void> => call('library:indexAnyway', { ref }),
  list: (req: { scope: Scope; name?: string; sort: SortKey; descending: boolean; filter: LibraryFilter; offset: number; limit: number }): Promise<ListResult> => call('library:list', req),
  tree: (rootId: number): Promise<RootTree> => call('library:tree', { rootId }),
  search: (req: { query: string; scope: Scope; offset: number; limit: number }): Promise<SearchResult> => call('library:search', req),
  open: (refs: string[]): Promise<OpenResult> => call('library:open', { refs }),
  reveal: (ref: string): Promise<void> => call('library:reveal', { ref }),
  removeFiles: (refs: string[]): Promise<void> => call('library:removeFile', { refs }),
  favorite: (refs: string[], value: boolean): Promise<void> => call('library:favorite', { refs, value }),
  createCollection: (name: string, parentId?: number | null): Promise<Result & Partial<CollectionCreated>> => call('library:createCollection', { name, parentId }),
  renameCollection: (id: number, name: string): Promise<Result> => call('library:renameCollection', { id, name }),
  deleteCollection: (id: number): Promise<Result> => call('library:deleteCollection', { id }),
  addToCollection: (collectionId: number, refs: string[]): Promise<Result> => call('library:addToCollection', { collectionId, refs }),
  removeFromCollection: (collectionId: number, refs: string[]): Promise<Result> => call('library:removeFromCollection', { collectionId, refs }),
  thumbs: (refs: string[]): Promise<Record<string, string>> => call('library:thumbs', { refs }),
  thumbSource: (ref: string): Promise<ThumbSource | null> => call('library:thumbSource', { ref }),
  saveThumb: (ref: string, png: Uint8Array, pages?: number): Promise<boolean> => call('library:saveThumb', { ref, png, pages })
}
