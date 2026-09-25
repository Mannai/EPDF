import { useEffect, useId, useState, type ReactNode } from 'react'

/** Small labelled controls for the properties panel. Text-like ones commit on blur / Enter, Escape reverts. */

export function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }): JSX.Element {
  return (
    <details open={defaultOpen} className="border-b border-line px-3 py-2">
      <summary className="cursor-pointer select-none rounded text-xs font-semibold uppercase tracking-wide text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-accent">{title}</summary>
      <div className="mt-2 grid gap-2">{children}</div>
    </details>
  )
}

export function TextCommit({
  label,
  value,
  onCommit,
  validate,
  multiline,
  placeholder,
  disabled,
  inputProps
}: {
  label: string
  value: string
  onCommit(v: string): void
  /** A message when the draft is not acceptable (shown, and nothing is committed). */
  validate?: (v: string) => string | null
  multiline?: boolean
  placeholder?: string
  disabled?: boolean
  inputProps?: Record<string, string | number | boolean | undefined>
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(value)
    setError(null)
  }, [value])
  const commit = (): void => {
    if (draft === value) return setError(null)
    const problem = validate?.(draft) ?? null
    setError(problem)
    if (problem) return
    onCommit(draft)
  }
  const common = {
    id,
    value: draft,
    disabled,
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-err` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setDraft(e.target.value)
      if (error) setError(validate?.(e.target.value) ?? null)
    },
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        setDraft(value)
        setError(null)
        e.currentTarget.blur()
      }
    },
    ...inputProps
  }
  return (
    <div className="grid gap-1 text-xs">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea {...common} rows={4} className="field h-auto py-1 select-text" /> : <input {...common} type="text" className="field select-text" />}
      {error && (
        <p id={`${id}-err`} role="alert" className="text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

export function NumberCommit({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  emptyMeans,
  disabled
}: {
  label: string
  value: number | undefined
  onCommit(v: number | undefined): void
  min?: number
  max?: number
  step?: number
  /** What an empty box means (shown as a placeholder), e.g. "no limit" or "auto". */
  emptyMeans?: string
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  const commit = (): void => {
    const t = draft.trim()
    const n = t === '' ? undefined : Number(t)
    if (n !== undefined && (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max))) return setDraft(value === undefined ? '' : String(value))
    if (n !== value) onCommit(n)
  }
  return (
    <div className="grid gap-1 text-xs">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        className="field select-text"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={emptyMeans}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setDraft(value === undefined ? '' : String(value))
            e.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

export function CheckRow({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; hint?: string }): JSX.Element {
  const id = useId()
  return (
    <div className="flex items-start gap-2 text-xs">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--c-accent))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} onKeyDown={(e) => e.stopPropagation()} />
      <label htmlFor={id} className="min-w-0">
        {label}
        {hint && <span className="block text-ink-muted">{hint}</span>}
      </label>
    </div>
  )
}

export function SelectRow<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void; disabled?: boolean }): JSX.Element {
  const id = useId()
  return (
    <div className="grid gap-1 text-xs">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** A colour that may also be "none" (transparent / no border). */
export function ColorRow({ label, value, onChange, noneLabel }: { label: string; value: string | null; onChange(v: string | null): void; noneLabel?: string }): JSX.Element {
  const id = useId()
  return (
    <div className="grid gap-1 text-xs">
      <label htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          className="h-8 w-10 cursor-pointer rounded border border-line bg-surface p-0.5 disabled:opacity-40"
          value={value ?? '#ffffff'}
          disabled={value === null}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <CheckRow label={noneLabel ?? 'None'} checked={value === null} onChange={(none) => onChange(none ? null : '#000000')} />
      </div>
    </div>
  )
}
