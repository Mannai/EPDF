import { runCommand } from '../api'
import { useTabs } from '../../state/tabs'
import { borderOf, deleteLinkAction, removeLinksAction, restyleLinkAction, styleOfBorder } from './actions'
import { useDocLinks } from './data'
import { describeTarget } from './pdf/model'
import { openEdit } from './Overlay'
import { useLinkUi, type BorderStyle } from './store'

/** Extra controls shown in the Tools ribbon while a link tool is active. */

const BORDERS: { value: BorderStyle; label: string }[] = [
  { value: 'none', label: 'No border' },
  { value: 'thin', label: 'Thin outline' },
  { value: 'dashed', label: 'Dashed outline' }
]

function ShowLinks(): JSX.Element {
  const highlight = useLinkUi((s) => s.highlight)
  return (
    <label className="flex items-center gap-1 text-xs">
      <input type="checkbox" checked={highlight} onChange={(e) => useLinkUi.getState().setHighlight(e.target.checked)} />
      <span>Show all links</span>
    </label>
  )
}

/** Keeps the text selection when a button is pressed with the mouse (a click on a button would otherwise not matter, but focus moves). */
const keepSelection = (e: React.MouseEvent): void => e.preventDefault()

export function AddLinkOptions({ docId }: { docId: string }): JSX.Element {
  const border = useLinkUi((s) => s.newBorder)
  const color = useLinkUi((s) => s.newColor)
  const page = useTabs((s) => s.tabs.find((t) => t.docId === docId)?.view.page ?? 1)
  return (
    <>
      <label className="flex items-center gap-1 text-xs">
        <span>New links</span>
        <select aria-label="Appearance of new links" value={border} onChange={(e) => useLinkUi.getState().setNewBorder(e.target.value as BorderStyle)} className="field h-7 text-xs">
          {BORDERS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      {border !== 'none' && <input type="color" aria-label="Colour of new links" value={color} onChange={(e) => useLinkUi.getState().setNewColor(e.target.value)} className="h-7 w-8 cursor-pointer rounded border border-line bg-transparent p-0" />}
      <button className="btn h-7 px-2 text-xs" title="Make the selected text a link" onMouseDown={keepSelection} onClick={() => void runCommand('links.fromSelection')}>
        Link selected text
      </button>
      <button className="btn h-7 px-2 text-xs" title="Add a link box on the visible part of the current page, then move or resize it with the keyboard" onClick={() => void runCommand('links.addHere')}>
        Add link on page {page}
      </button>
      <button className="btn h-7 px-2 text-xs" onClick={() => void runCommand('links.detect')}>
        Find addresses…
      </button>
      <button className="btn h-7 px-2 text-xs" onClick={() => void runCommand('links.removePage')}>
        Remove links on page {page}
      </button>
      <button className="btn h-7 px-2 text-xs" onClick={() => void runCommand('links.removeAll')}>
        Remove all links
      </button>
      <ShowLinks />
    </>
  )
}

export function EditLinkOptions({ docId }: { docId: string }): JSX.Element {
  const data = useDocLinks(docId, true)
  const selection = useLinkUi((s) => s.selection)
  const links = data?.links ?? []
  const selected = selection?.docId === docId ? links.find((l) => l.id === selection.id) : undefined
  const style = selected ? styleOfBorder(selected.border) : null

  if (data?.error) {
    return <span className="text-xs">{data.error.kind === 'encrypted' ? 'Unlock the document to edit its links.' : 'The links of this document could not be read.'}</span>
  }
  return (
    <>
      <label className="flex items-center gap-1 text-xs">
        <span>Link</span>
        <select
          aria-label="Choose a link"
          value={selected?.id ?? ''}
          className="field h-7 max-w-64 text-xs"
          dir="auto"
          onChange={(e) => {
            const l = links.find((x) => x.id === e.target.value)
            if (!l) return useLinkUi.getState().select(docId, null)
            useLinkUi.getState().select(docId, l.id)
            useTabs.getState().goToPage(docId, l.pageIndex + 1)
          }}
        >
          <option value="">{links.length ? `${links.length} links: click one on the page or choose…` : 'No links in this document'}</option>
          {links.slice(0, 500).map((l) => (
            <option key={l.id} value={l.id}>
              {`Page ${l.pageIndex + 1}: ${describeTarget(l.target)}`.slice(0, 90)}
            </option>
          ))}
        </select>
      </label>
      <button className="btn h-7 px-2 text-xs" disabled={!selected} onClick={() => selected && openEdit(docId, selected)}>
        Edit target…
      </button>
      {selected && style && (
        <>
          <label className="flex items-center gap-1 text-xs">
            <span>Border</span>
            <select
              aria-label="Border of the selected link"
              value={style.style}
              className="field h-7 text-xs"
              onChange={(e) => void restyleLinkAction(docId, selected.id, borderOf(e.target.value as BorderStyle, style.color))}
            >
              {BORDERS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          {style.style !== 'none' && (
            <input
              type="color"
              aria-label="Colour of the selected link"
              value={style.color}
              onChange={(e) => void restyleLinkAction(docId, selected.id, borderOf(style.style, e.target.value))}
              className="h-7 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
          )}
        </>
      )}
      <button className="btn h-7 px-2 text-xs" disabled={!selected} onClick={() => selected && void deleteLinkAction(docId, selected.id)}>
        Delete link
      </button>
      <button className="btn h-7 px-2 text-xs" onClick={() => void removeLinksAction(docId)}>
        Remove all links
      </button>
    </>
  )
}
