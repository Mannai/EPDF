import { useEffect, useId, useRef, useState } from 'react'
import { hexToRgb, rgbToHex } from './pdf/basics'
import { capabilities, subtypeLabel, type AnnotInfo } from './pdf/model'
import { deleteAnnot, editAnnotation } from './actions'
import { useMarkup } from './store'
import { useWorkspace } from '../../state/workspace'

/** Small form controls shared by the ribbon options and the Comments panel. */

/** A colour input for tool options: applies immediately (nothing is written to the document). */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange(hex: string): void }): JSX.Element {
  return (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0" />
    </label>
  )
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange(v: number): void
  format?: (v: number) => string
}): JSX.Element {
  return (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-6 w-20 accent-[rgb(var(--c-accent))]" />
      <span className="w-9 tabular-nums text-ink-muted" aria-hidden="true">
        {format ? format(value) : value}
      </span>
    </label>
  )
}

export function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(v: number): void }): JSX.Element {
  return (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
        className="field w-16"
      />
    </label>
  )
}

export function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }): JSX.Element {
  return (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/**
 * An input whose value is committed on the native `change` event (colour picker closed, slider released,
 * Enter/blur in a number field) so dragging a slider never creates an undo step per pixel.
 */
export function CommitInput({
  type,
  value,
  onCommit,
  className,
  ...aria
}: {
  type: 'color' | 'range' | 'number'
  value: string | number
  onCommit(v: string): void
  className?: string
  min?: number
  max?: number
  step?: number
  'aria-label'?: string
  id?: string
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [local, setLocal] = useState(String(value))
  useEffect(() => setLocal(String(value)), [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = (): void => onCommit(el.value)
    el.addEventListener('change', h)
    return () => el.removeEventListener('change', h)
  })
  return <input ref={ref} type={type} value={local} onChange={(e) => setLocal(e.target.value)} className={className} {...aria} />
}

/**
 * Multi-line text that is committed on blur or Enter (Shift+Enter inserts a new line, Escape reverts):
 * typing never creates an undo step per keystroke.
 */
export function CommitTextarea({
  label,
  value,
  onCommit,
  focusOnRequest,
  rows = 3,
  hideLabel
}: {
  label: string
  value: string
  onCommit(v: string): void
  focusOnRequest?: boolean
  rows?: number
  hideLabel?: boolean
}): JSX.Element {
  const id = useId()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [local, setLocal] = useState(value)
  const focusSeq = useMarkup((s) => s.focusText)
  const handled = useRef(focusSeq)
  useEffect(() => setLocal(value), [value])
  useEffect(() => {
    if (focusOnRequest && focusSeq !== handled.current) {
      handled.current = focusSeq
      ref.current?.focus()
    }
  }, [focusSeq, focusOnRequest])

  const commit = (): void => {
    if (local !== value) onCommit(local)
  }
  return (
    <div>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'mb-0.5 block text-xs font-medium text-ink-muted'}>
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={rows}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setLocal(value)
            ref.current?.blur()
          }
        }}
        className="field h-auto w-full resize-y py-1"
      />
    </div>
  )
}

const DEFAULT_COLOR = '#ffd633'

/** Editable properties of one existing annotation, limited to what can be changed without destroying it. */
export function AnnotProperties({ docId, annot, variant }: { docId: string; annot: AnnotInfo; variant: 'panel' | 'ribbon' }): JSX.Element {
  const caps = capabilities(annot)
  const compact = variant === 'ribbon'
  const cls = compact ? 'flex flex-wrap items-center gap-2' : 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-2'
  const apply = (patch: Parameters<typeof editAnnotation>[2], label: string): void => void editAnnotation(docId, annot.id, patch, label)
  return (
    <div className={compact ? 'flex flex-wrap items-center gap-3' : ''}>
      {!compact && caps.text && (
        <CommitTextarea
          label={annot.subtype === 'FreeText' ? 'Text' : 'Comment'}
          value={annot.contents}
          rows={3}
          focusOnRequest
          onCommit={(v) => apply({ contents: v }, 'Edit comment')}
        />
      )}
      <div className={cls}>
        {caps.recolor && (
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
            <span>{annot.subtype === 'FreeText' ? 'Text color' : 'Color'}</span>
            <CommitInput
              type="color"
              value={rgbToHex(annot.color, DEFAULT_COLOR)}
              onCommit={(hex) => apply({ color: hexToRgb(hex) }, 'Change color')}
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
          </label>
        )}
        {caps.fill && (
          <div className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!annot.fill}
                onChange={(e) => apply({ fill: e.target.checked ? hexToRgb(annot.subtype === 'FreeText' ? '#fff8b0' : DEFAULT_COLOR) : null }, 'Change fill')}
              />
              <span>Fill</span>
            </label>
            {annot.fill && (
              <CommitInput
                type="color"
                aria-label="Fill color"
                value={rgbToHex(annot.fill, DEFAULT_COLOR)}
                onCommit={(hex) => apply({ fill: hexToRgb(hex) }, 'Change fill')}
                className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
              />
            )}
          </div>
        )}
        {caps.opacity && (
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
            <span>Opacity</span>
            <CommitInput
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(annot.opacity * 100)}
              onCommit={(v) => apply({ opacity: Number(v) / 100 }, 'Change opacity')}
              className="h-6 w-20 accent-[rgb(var(--c-accent))]"
            />
            <span className="w-9 tabular-nums text-ink-muted" aria-hidden="true">
              {Math.round(annot.opacity * 100)}%
            </span>
          </label>
        )}
        {caps.width && (
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
            <span>{annot.subtype === 'FreeText' ? 'Border' : 'Width'}</span>
            <CommitInput
              type="number"
              min={0}
              max={40}
              step={1}
              value={annot.borderWidth}
              onCommit={(v) => Number.isFinite(Number(v)) && apply({ borderWidth: Math.min(40, Math.max(0, Number(v))) }, 'Change line width')}
              className="field w-16"
            />
          </label>
        )}
        {annot.subtype === 'FreeText' && caps.recolor && (
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-ink">
            <span>Font size</span>
            <CommitInput
              type="number"
              min={4}
              max={96}
              step={1}
              value={annot.fontSize}
              onCommit={(v) => Number.isFinite(Number(v)) && apply({ fontSize: Math.min(96, Math.max(4, Number(v))) }, 'Change font size')}
              className="field w-16"
            />
          </label>
        )}
        <button type="button" className="btn text-xs" onClick={() => void deleteAnnot(docId, annot)}>
          Delete {subtypeLabel(annot.subtype).toLowerCase()}
        </button>
        {compact && (
          <button
            type="button"
            className="btn text-xs"
            onClick={() => {
              useWorkspace.getState().setRightPanel('markup.comments')
              setTimeout(() => useMarkup.getState().requestFocusText(), 120) // after the panel has mounted
            }}
          >
            Edit text…
          </button>
        )}
      </div>
    </div>
  )
}
