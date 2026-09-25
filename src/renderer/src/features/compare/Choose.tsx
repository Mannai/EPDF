import { useId } from 'react'
import type { PickedCompareFile } from '@shared/features/compare'
import { errorMessage, notify } from '../../state/notify'
import { useTabs, type Tab } from '../../state/tabs'
import { useCompare, type Entry } from './store'
import type { Source } from './session'

const same = (a: Source | null, b: Source | null): boolean => !!a && !!b && a.kind === 'tab' && b.kind === 'tab' && a.docId === b.docId

interface SlotProps {
  docId: string
  side: 'old' | 'new'
  title: string
  source: Source | null
  tabs: Tab[]
  hint: string
}

/** One of the two inputs: shows what is chosen and lets the user pick a file or an open tab. */
function Slot({ docId, side, title, source, tabs, hint }: SlotProps): JSX.Element {
  const id = useId()
  const setSource = useCompare((s) => s.setSource)

  const pickFile = async (): Promise<void> => {
    try {
      const picked = await window.epdf.call<PickedCompareFile | null>('compare:pickFile', { side })
      if (picked) setSource(docId, side, { kind: 'file', name: picked.name, bytes: picked.bytes })
    } catch (err) {
      notify('error', `Couldn’t open that file: ${errorMessage(err)}`)
    }
  }

  const tabValue = source?.kind === 'tab' ? source.docId : ''
  return (
    <section role="group" aria-labelledby={`${id}-title`} className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-line bg-raised p-4" data-testid={`compare-${side}`}>
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {title}
      </h3>
      <p className="text-xs text-ink-muted">{hint}</p>
      <p className="min-h-[2.5rem] break-words rounded-md bg-surface-alt px-2 py-1.5 font-medium" data-testid={`compare-${side}-name`}>
        {source ? source.name : 'Nothing chosen yet'}
        {source?.kind === 'tab' && <span className="ml-2 text-xs font-normal text-ink-muted">(open tab)</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => void pickFile()}>
          Choose file…
        </button>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-ink-muted">or open tab</span>
          <select
            className="field max-w-[14rem]"
            aria-label={`Use an open tab as the ${side} version`}
            value={tabValue}
            onChange={(e) => {
              const t = tabs.find((x) => x.docId === e.target.value)
              if (t) setSource(docId, side, { kind: 'tab', docId: t.docId, name: t.name })
            }}
          >
            <option value="">Choose…</option>
            {tabs.map((t) => (
              <option key={t.docId} value={t.docId}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

export function Choose({ tab, entry }: { tab: Tab; entry: Entry }): JSX.Element {
  // Every open document that did not fail to load (a background tab has not been rendered yet, but can still be read).
  const tabs = useTabs((s) => s.tabs).filter((t) => t.status !== 'error')
  const patch = useCompare((s) => s.patch)
  const swap = useCompare((s) => s.swap)
  const start = useCompare((s) => s.start)
  const { docId } = tab
  const ready = !!entry.oldSource && !!entry.newSource
  const identical = same(entry.oldSource, entry.newSource)
  const setOpt = (k: keyof Entry['opts'], v: boolean): void => patch(docId, { opts: { ...entry.opts, [k]: v } })

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6" data-testid="compare-choose">
      <div>
        <h2 className="text-lg font-semibold">Compare files</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Choose the older and the newer version of a document. Epdf lines up their pages, compares the text word by word and shows every difference side by side.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-3 md:flex-row">
        <Slot docId={docId} side="old" title="Old version" source={entry.oldSource} tabs={tabs} hint="The earlier version. Removed text is marked here." />
        <div className="flex items-center justify-center">
          <button className="btn" onClick={() => swap(docId)} aria-label="Swap old and new" title="Swap old and new">
            <span aria-hidden="true">⇄</span> Swap
          </button>
        </div>
        <Slot docId={docId} side="new" title="New version" source={entry.newSource} tabs={tabs} hint="The later version. Added text is marked here. Defaults to the document you have open." />
      </div>

      <fieldset className="rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-semibold">What counts as a difference</legend>
        <div className="mt-1 flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={entry.opts.ignoreCase} onChange={(e) => setOpt('ignoreCase', e.target.checked)} />
            <span>
              Ignore upper and lower case <span className="text-ink-muted">(“Report” equals “report”)</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={entry.opts.ignorePunctuation} onChange={(e) => setOpt('ignorePunctuation', e.target.checked)} />
            <span>
              Ignore punctuation <span className="text-ink-muted">(commas, full stops, quotes and dashes are not compared)</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={entry.opts.ignoreWhitespace} onChange={(e) => setOpt('ignoreWhitespace', e.target.checked)} />
            <span>
              Ignore spacing <span className="text-ink-muted">(compares letter by letter, so different word spacing or line breaks are not differences)</span>
            </span>
          </label>
        </div>
      </fieldset>

      {entry.error && (
        <p role="alert" data-testid="compare-error" className="rounded-md border border-line bg-surface-alt px-3 py-2 text-sm font-medium">
          <span aria-hidden="true">⚠ </span>
          {entry.error}
        </p>
      )}
      {identical && <p className="text-sm text-ink-muted">Both sides are the same open document, so nothing will differ.</p>}

      <div className="flex items-center gap-2">
        <button className="btn-primary" disabled={!ready} onClick={() => void start(docId)} data-testid="compare-start">
          Compare
        </button>
        {!ready && <span className="text-sm text-ink-muted">Choose both versions to continue.</span>}
      </div>
    </div>
  )
}
