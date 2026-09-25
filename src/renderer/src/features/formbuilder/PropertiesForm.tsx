import { useEffect, useRef } from 'react'
import { patchFields } from './actions'
import { CheckRow, ColorRow, NumberCommit, SelectRow, Section, TextCommit } from './controls'
import { isSafeRegex } from './logic/actions'
import { deleteRadioButtonAction, addRadioButtonAction } from './radio'
import { nameProblem } from './logic/names'
import {
  DATE_FORMATS,
  FONT_CHOICES,
  KIND_LABEL,
  type Align,
  type BorderStyle,
  type FieldInfo,
  type FieldPatch,
  type FieldStyle,
  type FontName,
  type FormatSpec
} from './logic/spec'
import { selectedWidgets, useBuilder, type DocBuilder } from './store'

/** The properties of the selected field(s). Every change is one undo step. */

type FormatChoice = 'none' | 'number' | 'percent' | 'date' | 'time' | 'zip' | 'zip4' | 'phone' | 'ssn' | 'email' | 'regex'

const FORMAT_OPTIONS: { value: FormatChoice; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'number', label: 'Number' },
  { value: 'percent', label: 'Percentage' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'zip', label: 'ZIP code' },
  { value: 'zip4', label: 'ZIP+4 code' },
  { value: 'phone', label: 'Phone number' },
  { value: 'ssn', label: 'Social security number' },
  { value: 'email', label: 'Email address' },
  { value: 'regex', label: 'Custom pattern (regular expression)' }
]

const choiceOf = (f: FormatSpec): FormatChoice => (f.type === 'special' ? f.special : f.type)

function formatFor(choice: FormatChoice, prev: FormatSpec): FormatSpec {
  switch (choice) {
    case 'none':
      return { type: 'none' }
    case 'number':
      return prev.type === 'number' ? prev : { type: 'number', decimals: 2, sep: 0, neg: 0, currency: '', prepend: true }
    case 'percent':
      return prev.type === 'percent' ? prev : { type: 'percent', decimals: 2, sep: 0 }
    case 'date':
      return prev.type === 'date' ? prev : { type: 'date', format: 'dd/mm/yyyy' }
    case 'time':
      return prev.type === 'time' ? prev : { type: 'time', format: 0 }
    case 'zip':
    case 'zip4':
    case 'phone':
    case 'ssn':
      return { type: 'special', special: choice }
    case 'email':
      return { type: 'email' }
    case 'regex':
      return prev.type === 'regex' ? prev : { type: 'regex', pattern: '^[A-Za-z0-9]+$', message: 'The value is not in the expected format.' }
  }
}

function FormatEditor({ format, onChange }: { format: FormatSpec; onChange(f: FormatSpec): void }): JSX.Element {
  return (
    <>
      <SelectRow label="Format / validation" value={choiceOf(format)} options={FORMAT_OPTIONS} onChange={(c) => onChange(formatFor(c, format))} />
      {format.type === 'number' && (
        <>
          <NumberCommit label="Decimal places" value={format.decimals} min={0} max={10} onCommit={(v) => onChange({ ...format, decimals: v ?? 0 })} />
          <SelectRow
            label="Separators"
            value={String(format.sep) as '0' | '1' | '2' | '3'}
            options={[
              { value: '0', label: '1,234.56' },
              { value: '1', label: '1234.56' },
              { value: '2', label: '1.234,56' },
              { value: '3', label: '1234,56' }
            ]}
            onChange={(v) => onChange({ ...format, sep: Number(v) as 0 | 1 | 2 | 3 })}
          />
          <TextCommit label="Currency symbol" value={format.currency} onCommit={(v) => onChange({ ...format, currency: v.slice(0, 4) })} />
          <NumberCommit label="Minimum value" value={format.min} emptyMeans="no minimum" onCommit={(v) => onChange({ ...format, min: v })} />
          <NumberCommit label="Maximum value" value={format.max} emptyMeans="no maximum" onCommit={(v) => onChange({ ...format, max: v })} />
        </>
      )}
      {format.type === 'percent' && <NumberCommit label="Decimal places" value={format.decimals} min={0} max={10} onCommit={(v) => onChange({ ...format, decimals: v ?? 0 })} />}
      {format.type === 'date' && (
        <SelectRow
          label="Date format"
          value={format.format}
          options={(DATE_FORMATS.includes(format.format) ? DATE_FORMATS : [format.format, ...DATE_FORMATS]).map((f) => ({ value: f, label: f }))}
          onChange={(v) => onChange({ type: 'date', format: v })}
        />
      )}
      {format.type === 'time' && (
        <SelectRow
          label="Time format"
          value={String(format.format) as '0' | '1' | '2' | '3'}
          options={[
            { value: '0', label: '24 hours (14:30)' },
            { value: '1', label: '12 hours (2:30 pm)' },
            { value: '2', label: '24 hours with seconds' },
            { value: '3', label: '12 hours with seconds' }
          ]}
          onChange={(v) => onChange({ type: 'time', format: Number(v) as 0 | 1 | 2 | 3 })}
        />
      )}
      {format.type === 'regex' && (
        <>
          <TextCommit label="Pattern" value={format.pattern} validate={(v) => (isSafeRegex(v) ? null : 'Enter a valid, simple regular expression (no nested repeats).')} onCommit={(v) => onChange({ ...format, pattern: v })} />
          <TextCommit label="Message when it does not match" value={format.message} onCommit={(v) => onChange({ ...format, message: v })} />
        </>
      )}
      {format.type !== 'none' && (
        <p className="text-[11px] leading-snug text-ink-muted">
          Saved as standard form scripts so other PDF readers check the value too. Epdf checks it while you fill the form but never runs PDF scripts.
        </p>
      )}
    </>
  )
}

const ALIGNS: { value: Align; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' }
]
const BORDERS: { value: BorderStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'beveled', label: 'Beveled' },
  { value: 'inset', label: 'Inset' },
  { value: 'underline', label: 'Underline' }
]

function AppearanceEditor({ field, onStyle }: { field: FieldInfo; onStyle(s: Partial<FieldStyle>): void }): JSX.Element {
  const s = field.style
  const textual = field.kind === 'text' || field.kind === 'dropdown' || field.kind === 'list' || field.kind === 'button'
  return (
    <>
      {textual && (
        <>
          <SelectRow label="Font" value={s.fontName} options={FONT_CHOICES.map((f) => ({ value: f.name, label: f.label }))} onChange={(v: FontName) => onStyle({ fontName: v })} />
          <NumberCommit label="Font size (points)" value={s.fontSize} min={0} max={144} emptyMeans="0 = automatic" onCommit={(v) => onStyle({ fontSize: v ?? 0 })} />
        </>
      )}
      <div className="grid gap-1 text-xs">
        <ColorRow label={field.kind === 'checkbox' || field.kind === 'radio' ? 'Mark colour' : 'Text colour'} value={s.textColor} onChange={(v) => onStyle({ textColor: v ?? '#000000' })} noneLabel="Black" />
      </div>
      {field.kind === 'text' && <SelectRow label="Alignment" value={s.align} options={ALIGNS} onChange={(v) => onStyle({ align: v })} />}
      <ColorRow label="Border colour" value={s.borderColor} onChange={(v) => onStyle({ borderColor: v })} noneLabel="No border" />
      {s.borderColor !== null && (
        <>
          <NumberCommit label="Border width" value={s.borderWidth} min={0.25} max={12} step={0.25} onCommit={(v) => onStyle({ borderWidth: v ?? 1 })} />
          <SelectRow label="Border style" value={s.borderStyle} options={BORDERS} onChange={(v) => onStyle({ borderStyle: v })} />
        </>
      )}
      <ColorRow label="Fill colour" value={s.backgroundColor} onChange={(v) => onStyle({ backgroundColor: v })} noneLabel="No fill (transparent)" />
    </>
  )
}

export function PropertiesForm({ docId, doc }: { docId: string; doc: DocBuilder }): JSX.Element {
  const selection = useBuilder((s) => (s.selectionDoc === docId ? s.selection : []))
  const focusName = useBuilder((s) => s.focusName)
  const nameBox = useRef<HTMLDivElement>(null)
  const sel = selectedWidgets(doc, selection)

  // "Enter" on a frame (or a freshly drawn field) puts the cursor in the Name box.
  useEffect(() => {
    if (focusName === 0) return
    nameBox.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [focusName])

  if (sel.length === 0) {
    return (
      <p className="px-3 py-3 text-xs text-ink-muted">
        Select a field on the page or in the list to change its properties. Shift+click adds to the selection; drag on empty page area to select several.
      </p>
    )
  }
  const field = sel[0].field
  const names = [...new Set(sel.map((s) => s.field.name))]
  const patch = (p: FieldPatch, label?: string): void => void patchFields(docId, names, p, label)

  if (names.length > 1) {
    const all = sel.map((s) => s.field)
    return (
      <div>
        <p className="px-3 py-2 text-xs font-medium" data-testid="fb-multi">
          {names.length} fields selected
        </p>
        <Section title="Common properties">
          <CheckRow label="Required" checked={all.every((f) => f.required)} onChange={(v) => patch({ required: v })} />
          <CheckRow label="Read-only" checked={all.every((f) => f.readOnly)} onChange={(v) => patch({ readOnly: v })} />
          <CheckRow label="Hidden" checked={all.every((f) => f.hidden)} onChange={(v) => patch({ hidden: v })} />
        </Section>
        <Section title="Appearance">
          <AppearanceEditor field={field} onStyle={(style) => patch({ style })} />
        </Section>
      </div>
    )
  }

  const taken = doc.fields.filter((f) => f.name !== field.name).map((f) => f.name.toLowerCase())
  const validateName = (v: string): string | null => {
    const prefix = field.namePrefix
    const problem = nameProblem(v)
    if (problem) return problem
    return taken.includes((prefix + v).toLowerCase()) ? `A field named “${v}” already exists. Field names must be unique.` : null
  }
  const isText = field.kind === 'text'
  const partial = field.name.slice(field.namePrefix.length)

  return (
    <div data-testid="fb-properties" data-field={field.name}>
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2">
        <span className="truncate text-xs font-semibold" title={field.name}>
          {KIND_LABEL[field.kind]}
        </span>
        <span className="text-[11px] text-ink-muted">Page {field.widgets[0].pageIndex + 1}</span>
      </div>
      <Section title="General">
        <div ref={nameBox}>
          <TextCommit
            label={field.namePrefix ? `Name (inside “${field.namePrefix.slice(0, -1)}”)` : 'Name'}
            value={partial}
            validate={validateName}
            onCommit={(v) => patch({ name: v }, `Rename “${field.name}”`)}
            inputProps={{ 'data-fb-name-input': '' }}
          />
        </div>
        <TextCommit label="Tooltip (also read aloud by screen readers)" value={field.tooltip} onCommit={(v) => patch({ tooltip: v })} />
        <CheckRow label="Required" checked={field.required} onChange={(v) => patch({ required: v })} />
        <CheckRow label="Read-only" checked={field.readOnly} onChange={(v) => patch({ readOnly: v })} />
        <CheckRow label="Hidden" checked={field.hidden} onChange={(v) => patch({ hidden: v })} />
      </Section>

      {isText && (
        <Section title="Text">
          <TextCommit label="Default value" value={field.defaultValue} onCommit={(v) => patch({ defaultValue: v })} />
          <NumberCommit label="Maximum length" value={field.maxLength} min={1} max={5000} emptyMeans="no limit" onCommit={(v) => patch({ maxLength: v })} />
          <CheckRow label="Multi-line" checked={field.multiline} disabled={field.comb} onChange={(v) => patch({ multiline: v })} />
          <CheckRow label="Password (characters are hidden)" checked={field.password} disabled={field.comb} onChange={(v) => patch({ password: v })} />
          <CheckRow label="Comb (one box per character)" hint={field.maxLength ? `${field.maxLength} boxes` : 'Set a maximum length first: it is the number of boxes.'} checked={field.comb} disabled={!field.maxLength || field.multiline || field.password} onChange={(v) => patch({ comb: v })} />
        </Section>
      )}

      {isText && (
        <Section title="Format and validation" defaultOpen={field.format.type !== 'none'}>
          <FormatEditor format={field.format} onChange={(format) => patch({ format }, `Set format of “${field.name}”`)} />
        </Section>
      )}

      {field.kind === 'checkbox' && (
        <Section title="Check box">
          <TextCommit label="Export value (when checked)" value={field.onValue} validate={(v) => (v.trim() === '' ? 'Enter a value.' : null)} onCommit={(v) => patch({ onValue: v.trim() })} />
          <CheckRow label="Checked by default" checked={field.value === 'true'} onChange={(v) => patch({ value: v ? 'true' : '' })} />
        </Section>
      )}

      {field.kind === 'radio' && (
        <Section title="Radio buttons">
          <p className="text-[11px] text-ink-muted">Only one button of the group can be selected. Each button has an export value.</p>
          <ul className="grid gap-2" aria-label="Buttons of this radio group">
            {field.widgets.map((w, i) => (
              <li key={w.index} className="flex items-end gap-1">
                <div className="min-w-0 flex-1">
                  <TextCommit
                    label={`Button ${i + 1} export value`}
                    value={w.value ?? ''}
                    validate={(v) => (v.trim() === '' ? 'Enter a value.' : field.widgets.some((o, j) => j !== i && o.value === v.trim()) ? 'Values must be different.' : null)}
                    onCommit={(v) => patch({ radioValues: field.widgets.map((o, j) => (j === i ? v.trim() : (o.value ?? ''))) }, `Change export value of “${field.name}”`)}
                  />
                </div>
                <button type="button" className="btn h-8 px-2 text-xs" aria-label={`Remove button ${i + 1} (${w.value ?? ''})`} onClick={() => void deleteRadioButtonAction(docId, field, w.index)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn h-8 text-xs" onClick={() => addRadioButtonAction(docId, field)}>
            Add a button to this group
          </button>
          <SelectRow
            label="Selected by default"
            value={field.value}
            options={[{ value: '', label: '(none)' }, ...field.widgets.map((w) => ({ value: w.value ?? '', label: w.value ?? '' }))]}
            onChange={(v) => patch({ value: v })}
          />
        </Section>
      )}

      {(field.kind === 'dropdown' || field.kind === 'list') && (
        <Section title={field.kind === 'dropdown' ? 'Dropdown options' : 'List options'}>
          <TextCommit
            label="Options, one per line"
            multiline
            value={field.options.join('\n')}
            validate={(v) => (v.split('\n').map((x) => x.trim()).filter(Boolean).length === 0 ? 'Enter at least one option.' : null)}
            onCommit={(v) => patch({ options: [...new Set(v.split('\n').map((x) => x.trim()).filter(Boolean))] }, `Change options of “${field.name}”`)}
          />
          {field.kind === 'dropdown' && <CheckRow label="Allow the user to type another value" checked={field.editable} onChange={(v) => patch({ editable: v })} />}
          {field.kind === 'list' && <CheckRow label="Allow several selections" checked={field.multiSelect} onChange={(v) => patch({ multiSelect: v })} />}
          <SelectRow
            label="Selected by default"
            value={field.value.split('\n')[0] ?? ''}
            options={[{ value: '', label: '(none)' }, ...field.options.map((o) => ({ value: o, label: o }))]}
            onChange={(v) => patch({ value: v })}
          />
        </Section>
      )}

      {field.kind === 'button' && (
        <Section title="Button">
          <TextCommit label="Caption" value={field.caption} onCommit={(v) => patch({ caption: v })} />
        </Section>
      )}

      {field.kind === 'signature' && (
        <Section title="Signature">
          <p className="text-[11px] text-ink-muted">An empty signature field. Use the Sign tool or another PDF reader to sign it.</p>
        </Section>
      )}

      <Section title="Appearance" defaultOpen={false}>
        <AppearanceEditor field={field} onStyle={(style) => patch({ style }, `Change look of “${field.name}”`)} />
      </Section>
    </div>
  )
}
