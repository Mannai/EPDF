import type { CreateEnvironment, Engine } from '@shared/features/create'

/**
 * "Office conversion engine" radio group shared by the Create PDF and Combine dialogs. The built-in converter is
 * the default and always available; LibreOffice is an optional, higher-fidelity engine that is only selectable
 * when it is installed.
 */
export function EngineChoice({ env, engine, onChange, idPrefix }: { env: CreateEnvironment | null; engine: Engine; onChange(e: Engine): void; idPrefix: string }): JSX.Element {
  const hasLo = !!env?.soffice
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-sm font-medium">Office document engine</legend>
      <label className="mb-1 flex items-start gap-2">
        <input type="radio" name={`${idPrefix}-engine`} className="mt-1 accent-accent" checked={engine === 'builtin'} onChange={() => onChange('builtin')} />
        <span>
          Built-in converter (recommended)
          <span className="block text-sm text-ink-muted">Works on any computer with nothing else installed. The layout is approximate.</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="radio"
          name={`${idPrefix}-engine`}
          className="mt-1 accent-accent"
          checked={engine === 'libreoffice'}
          disabled={!hasLo}
          aria-describedby={`${idPrefix}-lo-help`}
          onChange={() => onChange('libreoffice')}
        />
        <span>
          LibreOffice (if installed)
          <span id={`${idPrefix}-lo-help`} className="block text-sm text-ink-muted" data-testid="lo-status">
            {hasLo ? 'Found on this computer. Higher fidelity for complex documents.' : (env?.sofficeHelp ?? 'Not installed.')}
          </span>
        </span>
      </label>
    </fieldset>
  )
}
