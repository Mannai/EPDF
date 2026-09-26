import { useEffect, useId, useState } from 'react'

/** Small labelled form controls used by the page-marks dialog (keyboard operable, labelled, theme tokens only). */

export function ErrorText({ id, children }: { id?: string; children: React.ReactNode }): JSX.Element | null {
  return children ? (
    <p id={id} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
      {children}
    </p>
  ) : null
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className = 'w-20',
  integer
}: {
  label: string
  value: number
  onChange(v: number): void
  min: number
  max: number
  step?: number
  suffix?: string
  className?: string
  integer?: boolean
}): JSX.Element {
  const id = useId()
  const [text, setText] = useState(String(value))
  useEffect(() => {
    // Follow outside changes (a preset was loaded) without fighting what the user is typing.
    setText((t) => (Number(t.replace(',', '.')) === value ? t : String(value)))
  }, [value])
  const n = Number(text.replace(',', '.'))
  const bad = text.trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-xs text-ink-muted">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={id}
          className={`field ${className}`}
          inputMode="decimal"
          value={text}
          aria-invalid={bad}
          onChange={(e) => {
            setText(e.target.value)
            const v = Number(e.target.value.replace(',', '.'))
            if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))) onChange(v)
          }}
          onBlur={() => {
            if (bad) setText(String(value))
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const v = Math.min(max, Math.max(min, (Number.isFinite(n) ? n : value) + (e.key === 'ArrowUp' ? step : -step)))
              const r = Math.round(v * 1000) / 1000
              setText(String(r))
              onChange(r)
            }
          }}
        />
        {suffix && <span className="text-xs text-ink-muted">{suffix}</span>}
      </div>
    </div>
  )
}

export function SelectField<T extends string>({ label, value, onChange, options, className = '' }: { label: string; value: T; onChange(v: T): void; options: readonly (readonly [T, string])[]; className?: string }): JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-xs text-ink-muted">
        {label}
      </label>
      <select id={id} className={`field ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }): JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center gap-1.5">
      <input id={id} type="checkbox" className="h-4 w-4 accent-[rgb(var(--c-accent))]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  )
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }): JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="text-xs text-ink-muted">
        {label}
      </label>
      <input id={id} type="color" className="h-8 w-12 cursor-pointer rounded-md border border-line bg-surface p-0.5" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <fieldset className="mt-3 rounded-md border border-line p-2">
      <legend className="px-1 text-xs font-semibold">{title}</legend>
      {children}
    </fieldset>
  )
}
