import { useEffect, useMemo, useState } from 'react'
import type { LibraryCollection, LibraryRoot, RootTree, Scope } from '@shared/features/library'
import { notify, errorMessage } from '../../state/notify'
import { libraryApi } from './api'
import { DRAG_TYPE } from './FileGrid'
import { formatCount } from './format'
import { ChevronIcon, ClockIcon, CloudIcon, FileIcon, FolderIcon, LibraryIcon, StarIcon, WarnIcon } from './icons'
import { addFolder, addSuggested, loadTree, refreshState, setFolderDialog, setScope, toggleExpanded, useLibrary } from './store'

const sameScope = (a: Scope, b: Scope): boolean => JSON.stringify(a) === JSON.stringify(b)
const CLOUD_KINDS = new Set(['onedrive', 'gdrive', 'dropbox', 'icloud', 'box'])

function NavButton({ scope, icon, label, count, indent = 0, onDropRefs }: { scope: Scope; icon: JSX.Element; label: string; count?: number; indent?: number; onDropRefs?: (refs: string[]) => void }): JSX.Element {
  const current = useLibrary((s) => sameScope(s.scope, scope))
  const [over, setOver] = useState(false)
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={() => setScope(scope)}
      onDragOver={
        onDropRefs
          ? (e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setOver(true)
            }
          : undefined
      }
      onDragLeave={onDropRefs ? () => setOver(false) : undefined}
      onDrop={
        onDropRefs
          ? (e) => {
              setOver(false)
              const raw = e.dataTransfer.getData(DRAG_TYPE)
              if (!raw) return
              e.preventDefault()
              try {
                const refs = JSON.parse(raw) as string[]
                if (Array.isArray(refs)) onDropRefs(refs.filter((r) => typeof r === 'string'))
              } catch {
                /* not ours */
              }
            }
          : undefined
      }
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-accent ${current ? 'bg-accent/15 font-semibold' : ''} ${over ? 'ring-2 ring-accent' : ''}`}
      style={{ paddingLeft: 8 + indent * 14 }}
    >
      <span className="shrink-0 text-ink-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-xs tabular-nums text-ink-muted">{formatCount(count)}</span>}
    </button>
  )
}

interface DirNode {
  name: string
  path: string
  files: number
  children: DirNode[]
}

/** Builds the sub-folder tree of a watched folder from the flat list of folders that contain files. */
export function buildDirTree(dirs: RootTree['dirs']): DirNode[] {
  const top: DirNode[] = []
  const index = new Map<string, DirNode>()
  for (const { dir, files } of dirs) {
    if (!dir) continue
    let parentList = top
    let path = ''
    for (const seg of dir.split('/')) {
      path = path ? `${path}/${seg}` : seg
      let node = index.get(path)
      if (!node) {
        node = { name: seg, path, files: 0, children: [] }
        index.set(path, node)
        parentList.push(node)
      }
      parentList = node.children
    }
    index.get(dir)!.files = files
  }
  return top
}

function DirTree({ rootId, nodes, depth }: { rootId: number; nodes: DirNode[]; depth: number }): JSX.Element {
  const expanded = useLibrary((s) => s.expanded)
  return (
    <ul>
      {nodes.map((n) => {
        const key = `d${rootId}/${n.path}`
        const open = expanded[key] ?? false
        return (
          <li key={n.path}>
            <div className="flex items-center">
              {n.children.length > 0 ? (
                <button type="button" className="btn-icon h-6 w-6 shrink-0" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${n.name}`} onClick={() => toggleExpanded(key, false)}>
                  <ChevronIcon open={open} />
                </button>
              ) : (
                <span className="w-6 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <NavButton scope={{ kind: 'root', rootId, dir: n.path }} icon={<FolderIcon />} label={n.name} indent={depth} />
              </div>
            </div>
            {open && n.children.length > 0 && <DirTree rootId={rootId} nodes={n.children} depth={depth + 1} />}
          </li>
        )
      })}
    </ul>
  )
}

function RootNode({ root }: { root: LibraryRoot }): JSX.Element {
  const key = `r${root.id}`
  const open = useLibrary((s) => s.expanded[key] ?? false)
  const dirs = useLibrary((s) => s.dirs[root.id])
  const tree = useMemo(() => buildDirTree(dirs ?? []), [dirs])
  useEffect(() => {
    if (open) void loadTree(root.id)
  }, [open, root.id, root.files])
  const cloud = CLOUD_KINDS.has(root.kind)
  return (
    <li>
      <div className="flex items-center">
        <button type="button" className="btn-icon h-6 w-6 shrink-0" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${root.label}`} onClick={() => toggleExpanded(key, false)}>
          <ChevronIcon open={open} />
        </button>
        <div className="min-w-0 flex-1">
          <NavButton scope={{ kind: 'root', rootId: root.id }} icon={cloud ? <CloudIcon /> : <FolderIcon />} label={root.label} count={root.files} />
        </div>
        {root.status !== 'ok' && (
          <span className="mr-1 shrink-0 text-ink-muted" title={root.note || 'This folder is not available'}>
            <WarnIcon label={root.status === 'missing' ? 'Folder not available' : 'Folder cannot be read'} />
          </span>
        )}
      </div>
      {open && tree.length > 0 && <DirTree rootId={root.id} nodes={tree} depth={1} />}
    </li>
  )
}

function CollectionTree({ parentId, all, depth }: { parentId: number | null; all: LibraryCollection[]; depth: number }): JSX.Element | null {
  const expanded = useLibrary((s) => s.expanded)
  const kids = all.filter((c) => c.parentId === parentId)
  if (kids.length === 0) return null
  return (
    <ul>
      {kids.map((c) => {
        const key = `c${c.id}`
        const hasKids = all.some((x) => x.parentId === c.id)
        const open = expanded[key] ?? true
        return (
          <li key={c.id}>
            <div className="flex items-center">
              {hasKids ? (
                <button type="button" className="btn-icon h-6 w-6 shrink-0" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${c.name}`} onClick={() => toggleExpanded(key, true)}>
                  <ChevronIcon open={open} />
                </button>
              ) : (
                <span className="w-6 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <NavButton
                  scope={{ kind: 'collection', id: c.id }}
                  icon={<FolderIcon />}
                  label={c.name}
                  count={c.files}
                  indent={depth}
                  onDropRefs={(refs) => {
                    void libraryApi
                      .addToCollection(c.id, refs)
                      .then((r) => {
                        if (!r.ok) notify('error', r.error)
                        else notify('success', `Added to “${c.name}”.`)
                        void refreshState()
                      })
                      .catch((e) => notify('error', errorMessage(e)))
                  }}
                />
              </div>
            </div>
            {hasKids && open && <CollectionTree parentId={c.id} all={all} depth={depth + 1} />}
          </li>
        )
      })}
    </ul>
  )
}

const H = 'px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-muted'

export function Sidebar(): JSX.Element {
  const state = useLibrary((s) => s.state)
  const suggestions = useLibrary((s) => s.suggestions).filter((s) => !s.added)
  const counts = state?.counts
  return (
    <nav aria-label="Library locations" className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-alt">
      <ul className="p-2">
        <li>
          <NavButton scope={{ kind: 'all' }} icon={<LibraryIcon />} label="All files" count={counts?.all} />
        </li>
        <li>
          <NavButton scope={{ kind: 'recent' }} icon={<ClockIcon />} label="Recent" count={counts?.recent} />
        </li>
        <li>
          <NavButton scope={{ kind: 'favorites' }} icon={<StarIcon filled={false} />} label="Favorites" count={counts?.favorites} />
        </li>
      </ul>

      <div className="flex items-center justify-between pr-2">
        <h2 className={H} id="lib-h-collections">
          Folders
        </h2>
        <button type="button" className="btn h-6 px-2 text-xs" onClick={() => setFolderDialog({ kind: 'new', parentId: null })} aria-label="New library folder">
          New
        </button>
      </div>
      <div className="px-2" role="group" aria-labelledby="lib-h-collections">
        {state && state.collections.length > 0 ? (
          <CollectionTree parentId={null} all={state.collections} depth={0} />
        ) : (
          <p className="px-2 pb-1 text-xs text-ink-muted">Group files your own way. Drag files here, or use “Add to folder…”.</p>
        )}
      </div>

      <h2 className={H} id="lib-h-roots">
        Watched folders
      </h2>
      <div className="px-2" role="group" aria-labelledby="lib-h-roots">
        {state && state.roots.length > 0 ? (
          <ul>
            {state.roots.map((r) => (
              <RootNode key={r.id} root={r} />
            ))}
          </ul>
        ) : (
          <p className="px-2 pb-1 text-xs text-ink-muted">No folders yet. Add one to search everything in it.</p>
        )}
      </div>

      <div className="p-3">
        <button type="button" className="btn-primary w-full" onClick={() => void addFolder()}>
          Add folder…
        </button>
      </div>

      {suggestions.length > 0 && (
        <>
          <h2 className={H} id="lib-h-suggest">
            Suggested folders
          </h2>
          <ul className="px-2 pb-3" aria-labelledby="lib-h-suggest">
            {suggestions.map((s) => (
              <li key={s.key} className="flex items-center gap-1 px-1 py-1">
                <span className="shrink-0 text-ink-muted">{s.cloud ? <CloudIcon /> : <FileIcon />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.label}</span>
                  <span className="block truncate text-xs text-ink-muted" title={s.path}>
                    {s.path}
                  </span>
                </span>
                <button type="button" className="btn h-7 px-2 text-xs" aria-label={`Add ${s.label} (${s.path}) to the library`} onClick={() => void addSuggested(s.key)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  )
}
