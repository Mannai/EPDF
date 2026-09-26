import { useId, useRef } from 'react'
import type { FontSettings, HeaderFooterSettings, OverlaySettings, PageSelection, Slot } from '@shared/features/headerfooter'
import { Check, ColorField, ErrorText, NumberField, Section, SelectField } from './Fields'

/** The settings forms of the page-marks dialog: headers/footers (also Bates) and watermarks/backgrounds. */

export const FONT_FAMILIES: readonly (readonly [string, string])[] = [
  ['Noto Sans', 'Noto Sans'],
  ['Liberation Sans', 'Liberation Sans (Arial metrics)'],
  ['Liberation Serif', 'Liberation Serif (Times metrics)'],
  ['Liberation Mono', 'Liberation Mono'],
  ['Carlito', 'Carlito (Calibri metrics)'],
  ['Caladea', 'Caladea (Cambria metrics)'],
  ['Noto Naskh Arabic', 'Noto Naskh Arabic'],
  ['Noto Sans Arabic', 'Noto Sans Arabic'],
  ['Noto Nastaliq Urdu', 'Noto Nastaliq Urdu'],
  ['Noto Sans Hebrew', 'Noto Sans Hebrew'],
  ['Great Vibes', 'Great Vibes (script)']
]

export function FontFields({ value, onChange, sizeMax = 200 }: { value: FontSettings; onChange(v: FontSettings): void; sizeMax?: number }): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField label="Font" value={value.family} onChange={(family) => onChange({ ...value, family })} options={FONT_FAMILIES.some(([f]) => f === value.family) ? FONT_FAMILIES : [...FONT_FAMILIES, [value.family, value.family] as const]} className="w-44" />
      <NumberField label="Size" value={value.size} min={1} max={sizeMax} step={1} suffix="pt" className="w-16" onChange={(size) => onChange({ ...value, size })} />
      <ColorField label="Color" value={value.color} onChange={(color) => onChange({ ...value, color })} />
      <div className="flex flex-col gap-1 pb-1">
        <Check label="Bold" checked={value.bold} onChange={(bold) => onChange({ ...value, bold })} />
        <Check label="Italic" checked={value.italic} onChange={(italic) => onChange({ ...value, italic })} />
      </div>
    </div>
  )
}

export function PagesFields({ value, onChange, error }: { value: PageSelection; onChange(v: PageSelection): void; error: string }): JSX.Element {
  const id = useId()
  return (
    <Section title="Pages">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col">
          <label htmlFor={id} className="text-xs text-ink-muted">
            Page range (empty = all)
          </label>
          <input id={id} className="field w-44" value={value.range} placeholder="For example 1-3, 7, 9-" aria-invalid={!!error} aria-describedby={`${id}-err`} onChange={(e) => onChange({ ...value, range: e.target.value })} />
        </div>
        <SelectField
          label="Which pages"
          value={value.subset}
          onChange={(subset) => onChange({ ...value, subset })}
          options={[
            ['all', 'All pages in range'],
            ['odd', 'Odd pages only'],
            ['even', 'Even pages only']
          ]}
        />
      </div>
      <ErrorText id={`${id}-err`}>{error}</ErrorText>
    </Section>
  )
}

const SLOT_ROWS: { band: string; slots: { slot: Slot; label: string }[] }[] = [
  {
    band: 'Header',
    slots: [
      { slot: 'topLeft', label: 'Header left' },
      { slot: 'topCenter', label: 'Header center' },
      { slot: 'topRight', label: 'Header right' }
    ]
  },
  {
    band: 'Footer',
    slots: [
      { slot: 'bottomLeft', label: 'Footer left' },
      { slot: 'bottomCenter', label: 'Footer center' },
      { slot: 'bottomRight', label: 'Footer right' }
    ]
  }
]

const TOKENS: { label: string; text: string }[] = [
  { label: 'Page number', text: '{page}' },
  { label: 'Total pages', text: '{pages}' },
  { label: 'Page 1 of N', text: 'Page {page} of {pages}' },
  { label: 'صفحة ١ من N', text: 'صفحة {page} من {pages}' },
  { label: 'Date', text: '{date}' },
  { label: 'File name', text: '{file}' },
  { label: 'Bates number', text: '{bates}' }
]

export function HeaderFooterForm({ value, onChange, bates, rangeError }: { value: HeaderFooterSettings; onChange(v: HeaderFooterSettings): void; bates: boolean; rangeError: string }): JSX.Element {
  const inputs = useRef(new Map<Slot, HTMLInputElement>())
  const lastSlot = useRef<Slot>(bates ? 'bottomRight' : 'bottomCenter')
  const set = <K extends keyof HeaderFooterSettings>(k: K, v: HeaderFooterSettings[K]): void => onChange({ ...value, [k]: v })

  const insert = (text: string): void => {
    const slot = lastSlot.current
    const el = inputs.current.get(slot)
    const cur = value.slots[slot]
    const start = el?.selectionStart ?? cur.length
    const end = el?.selectionEnd ?? cur.length
    const next = cur.slice(0, start) + text + cur.slice(end)
    onChange({ ...value, slots: { ...value.slots, [slot]: next } })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
  }
  const usesBates = bates || Object.values(value.slots).some((t) => t.includes('{bates}'))
  const usesDate = Object.values(value.slots).some((t) => t.includes('{date}'))

  return (
    <div>
      <div className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-1">
        <span />
        <span className="text-xs text-ink-muted">Left</span>
        <span className="text-xs text-ink-muted">Center</span>
        <span className="text-xs text-ink-muted">Right</span>
        {SLOT_ROWS.map((row) => (
          <SlotRow key={row.band} row={row} value={value} onChange={onChange} inputs={inputs.current} onFocusSlot={(s) => (lastSlot.current = s)} />
        ))}
      </div>
      <div role="group" aria-label="Insert into the last text box used" className="mt-2 flex flex-wrap gap-1">
        {TOKENS.map((t) => (
          <button key={t.text} type="button" className="btn h-7 px-2 text-xs" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t.text)}>
            <span dir="auto">+ {t.label}</span>
          </button>
        ))}
      </div>
      <Section title="Text">
        <FontFields value={value.font} onChange={(font) => set('font', font)} sizeMax={144} />
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <SelectField
            label="Text direction"
            value={value.direction}
            onChange={(d) => set('direction', d)}
            options={[
              ['auto', 'Automatic (from the text)'],
              ['ltr', 'Left to right'],
              ['rtl', 'Right to left']
            ]}
          />
          <SelectField
            label="Page numbers"
            value={value.numberStyle}
            onChange={(v) => set('numberStyle', v)}
            options={[
              ['decimal', '1, 2, 3'],
              ['roman-upper', 'I, II, III'],
              ['roman-lower', 'i, ii, iii'],
              ['arabic-indic', '١، ٢، ٣ (Arabic-Indic)'],
              ['persian', '۱، ۲، ۳ (Persian)']
            ]}
          />
          <NumberField label="Start at" value={value.startNumber} min={0} max={1_000_000} integer className="w-20" onChange={(v) => set('startNumber', v)} />
        </div>
        {usesDate && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <SelectField
              label="Date format"
              value={value.date.format}
              onChange={(format) => set('date', { ...value.date, format })}
              options={[
                ['d/m/yyyy', '26/9/2026'],
                ['m/d/yyyy', '9/26/2026'],
                ['yyyy-mm-dd', '2026-09-26'],
                ['dd.mm.yyyy', '26.09.2026'],
                ['d mmmm yyyy', '26 September 2026'],
                ['mmmm d, yyyy', 'September 26, 2026']
              ]}
            />
            <SelectField
              label="Month names"
              value={value.date.months}
              onChange={(months) => set('date', { ...value.date, months })}
              options={[
                ['en', 'English'],
                ['ar', 'Arabic (سبتمبر)']
              ]}
            />
            <SelectField
              label="Date digits"
              value={value.date.digits}
              onChange={(digits) => set('date', { ...value.date, digits })}
              options={[
                ['latin', '0123'],
                ['arabic-indic', '٠١٢٣'],
                ['persian', '۰۱۲۳']
              ]}
            />
          </div>
        )}
      </Section>
      {usesBates && (
        <Section title="Bates number">
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Prefix" value={value.bates.prefix} onChange={(prefix) => set('bates', { ...value.bates, prefix })} />
            <NumberField label="Digits" value={value.bates.digits} min={1} max={15} integer className="w-14" onChange={(digits) => set('bates', { ...value.bates, digits })} />
            <NumberField label="Start number" value={value.bates.start} min={0} max={999_999_999_999} integer className="w-28" onChange={(start) => set('bates', { ...value.bates, start })} />
            <TextField label="Suffix" value={value.bates.suffix} onChange={(suffix) => set('bates', { ...value.bates, suffix })} />
          </div>
        </Section>
      )}
      <Section title="Margins (points from the edge of the visible page)">
        <div className="flex flex-wrap gap-2">
          {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
            <NumberField key={k} label={k[0]!.toUpperCase() + k.slice(1)} value={value.margins[k]} min={0} max={2000} className="w-16" onChange={(v) => set('margins', { ...value.margins, [k]: v })} />
          ))}
        </div>
      </Section>
      <PagesFields value={value.pages} onChange={(pages) => set('pages', pages)} error={rangeError} />
    </div>
  )
}

function SlotRow({
  row,
  value,
  onChange,
  inputs,
  onFocusSlot
}: {
  row: (typeof SLOT_ROWS)[number]
  value: HeaderFooterSettings
  onChange(v: HeaderFooterSettings): void
  inputs: Map<Slot, HTMLInputElement>
  onFocusSlot(s: Slot): void
}): JSX.Element {
  const base = useId()
  return (
    <>
      <span className="pr-1 text-xs font-medium">{row.band}</span>
      {row.slots.map(({ slot, label }) => (
        <div key={slot}>
          <label htmlFor={`${base}-${slot}`} className="sr-only">
            {label}
          </label>
          <input
            id={`${base}-${slot}`}
            ref={(el) => {
              if (el) inputs.set(slot, el)
            }}
            className="field w-full min-w-0"
            dir="auto"
            value={value.slots[slot]}
            onFocus={() => onFocusSlot(slot)}
            onChange={(e) => onChange({ ...value, slots: { ...value.slots, [slot]: e.target.value } })}
          />
        </div>
      ))}
    </>
  )
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }): JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-xs text-ink-muted">
        {label}
      </label>
      <input id={id} className="field w-24" dir="auto" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ overlays

export type SourceState = { kind: 'file'; name: string; fileKind: 'png' | 'jpeg' | 'pdf'; bytes: Uint8Array } | { kind: 'existing'; name: string } | null

export function OverlayForm({
  group,
  value,
  onChange,
  source,
  onPick,
  rangeError
}: {
  group: 'watermark' | 'background'
  value: OverlaySettings
  onChange(v: OverlaySettings): void
  source: SourceState
  onPick(kind: 'image' | 'pdf'): void
  rangeError: string
}): JSX.Element {
  const set = <K extends keyof OverlaySettings>(k: K, v: OverlaySettings[K]): void => onChange({ ...value, [k]: v })
  const textId = useId()
  const src = value.source
  const kinds: [OverlaySettings['source']['kind'], string][] = group === 'background' ? [['color', 'Color'], ['image', 'Picture'], ['pdf', 'PDF page']] : [['text', 'Text'], ['image', 'Picture'], ['pdf', 'PDF page']]
  const setKind = (k: OverlaySettings['source']['kind']): void => {
    if (k === src.kind) return
    if (k === 'text') set('source', { kind: 'text', text: group === 'watermark' ? 'CONFIDENTIAL' : '', font: { family: 'Noto Sans', size: 72, color: '#c00000', bold: true, italic: false }, direction: 'auto' })
    else if (k === 'image') set('source', { kind: 'image', name: source?.kind === 'file' && source.fileKind !== 'pdf' ? source.name : '' })
    else if (k === 'pdf') set('source', { kind: 'pdf', name: source?.kind === 'file' && source.fileKind === 'pdf' ? source.name : '', page: 1 })
    else set('source', { kind: 'color', color: '#fff4cc' })
  }
  return (
    <div>
      <fieldset>
        <legend className="text-xs font-semibold">Source</legend>
        <div role="radiogroup" className="mt-1 flex gap-3">
          {kinds.map(([k, l]) => (
            <RadioOption key={k} name={`${group}-source`} label={l} checked={src.kind === k} onChange={() => setKind(k)} />
          ))}
        </div>
      </fieldset>
      {src.kind === 'text' && (
        <div className="mt-2">
          <label htmlFor={textId} className="text-xs text-ink-muted">
            Watermark text (any language; new lines are kept)
          </label>
          <textarea id={textId} dir="auto" rows={2} className="field h-auto w-full py-1" value={src.text} onChange={(e) => set('source', { ...src, text: e.target.value })} />
          <FontFields value={src.font} onChange={(font) => set('source', { ...src, font })} sizeMax={500} />
          <div className="mt-2">
            <SelectField
              label="Text direction"
              value={src.direction}
              onChange={(direction) => set('source', { ...src, direction })}
              options={[
                ['auto', 'Automatic (from the text)'],
                ['ltr', 'Left to right'],
                ['rtl', 'Right to left']
              ]}
            />
          </div>
        </div>
      )}
      {(src.kind === 'image' || src.kind === 'pdf') && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <button type="button" className="btn" onClick={() => onPick(src.kind === 'image' ? 'image' : 'pdf')}>
            {src.kind === 'image' ? 'Choose picture…' : 'Choose PDF…'}
          </button>
          <span className="max-w-[12rem] truncate pb-1.5 text-sm text-ink-muted" data-testid="hf-source-name">
            {source ? (source.kind === 'existing' ? `${source.name || 'The picture used before'} (already in the document)` : source.name) : 'No file chosen'}
          </span>
          {src.kind === 'pdf' && <NumberField label="Page of that PDF" value={src.page} min={1} max={100000} integer className="w-16" onChange={(page) => set('source', { ...src, page })} />}
        </div>
      )}
      {src.kind === 'color' && (
        <div className="mt-2">
          <ColorField label="Background color" value={src.color} onChange={(color) => set('source', { kind: 'color', color })} />
        </div>
      )}
      <Section title="Appearance">
        <div className="flex flex-wrap items-end gap-2">
          {src.kind !== 'color' && <NumberField label="Rotation" value={value.rotation} min={-360} max={360} step={15} suffix="°" className="w-16" onChange={(v) => set('rotation', v)} />}
          <NumberField label="Opacity" value={Math.round(value.opacity * 100)} min={0} max={100} step={5} suffix="%" className="w-16" onChange={(v) => set('opacity', v / 100)} />
          {src.kind !== 'color' && (
            <>
              <SelectField
                label="Scale"
                value={value.scale.mode}
                onChange={(mode) => set('scale', { ...value.scale, mode })}
                options={[
                  ['relative', 'Relative to the page'],
                  ['absolute', 'Of its own size']
                ]}
              />
              <NumberField label="Percent" value={value.scale.percent} min={1} max={1000} step={5} suffix="%" className="w-16" onChange={(percent) => set('scale', { ...value.scale, percent })} />
            </>
          )}
        </div>
        {src.kind !== 'color' && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <SelectField
              label="Horizontal"
              value={value.position.h}
              onChange={(h) => set('position', { ...value.position, h })}
              options={[
                ['left', 'Left'],
                ['center', 'Center'],
                ['right', 'Right']
              ]}
            />
            <SelectField
              label="Vertical"
              value={value.position.v}
              onChange={(v) => set('position', { ...value.position, v })}
              options={[
                ['top', 'Top'],
                ['center', 'Center'],
                ['bottom', 'Bottom']
              ]}
            />
            <NumberField label="Move right" value={value.position.dx} min={-5000} max={5000} suffix="pt" className="w-16" onChange={(dx) => set('position', { ...value.position, dx })} />
            <NumberField label="Move up" value={value.position.dy} min={-5000} max={5000} suffix="pt" className="w-16" onChange={(dy) => set('position', { ...value.position, dy })} />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {group === 'watermark' && (
            <SelectField
              label="Layer"
              value={value.layer}
              onChange={(layer) => set('layer', layer)}
              options={[
                ['front', 'In front of the page content'],
                ['behind', 'Behind the page content']
              ]}
            />
          )}
          <div className="flex flex-col gap-1 pb-1">
            <Check label="Show on screen" checked={value.screen} onChange={(v) => set('screen', v)} />
            <Check label="Show when printing" checked={value.print} onChange={(v) => set('print', v)} />
          </div>
        </div>
        {!value.print && !value.screen && <ErrorText>Choose to show it on screen, when printing, or both.</ErrorText>}
      </Section>
      <PagesFields value={value.pages} onChange={(pages) => set('pages', pages)} error={rangeError} />
    </div>
  )
}

function RadioOption({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange(): void }): JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center gap-1">
      <input id={id} type="radio" name={name} className="h-4 w-4 accent-[rgb(var(--c-accent))]" checked={checked} onChange={onChange} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  )
}
