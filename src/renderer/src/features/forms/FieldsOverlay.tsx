import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import type { PageOverlayProps } from '../api'
import './forms.css'
import { geometryOf, type PageGeometry } from './geometry'
import type { FieldModel, FieldValue, WidgetModel } from './model'
import { stepStop, tabStops, type Stop } from './tabOrder'
import { isolateViewerKeys } from './keys'
import { commitField, effectiveValue, useForms } from './store'

/**
 * Interactive HTML inputs drawn over each form widget of a page. PDF.js does not paint the widgets while
 * the forms annotation mode is on, so these inputs ARE the form the user sees: they copy the widget's
 * position (also on rotated pages and at any zoom), font size, color, alignment, background and border.
 * A completed edit (blur / Enter / change) is committed through `editPdf` as one undo step.
 */

const escapeSel = (s: string): string => s.replace(/["\\]/g, '\\$&')

/** Focuses a widget; when its page isn't rendered yet, scrolls there and focuses it as soon as it appears. */
export function focusWidget(docId: string, stop: Stop): void {
  const el = document.querySelector<HTMLElement>(`[data-widget-key="${escapeSel(stop.key)}"]`)
  if (el) {
    el.focus()
    return
  }
  useForms.getState().setPendingFocus({ docId, key: stop.key })
  useTabs.getState().goToPage(docId, stop.pageIndex + 1)
}

/** Moves focus to the next/previous tab stop. Returns false when there is none (focus then leaves the form). */
function moveFocus(docId: string, currentKey: string, dir: 1 | -1): boolean {
  const model = useForms.getState().docs[docId]?.model
  if (!model) return false
  const next = stepStop(tabStops(model), model, currentKey, dir)
  if (!next) return false
  focusWidget(docId, next)
  return true
}

function useFocusOnRequest(docId: string, key: string, ref: React.RefObject<HTMLElement | null>): void {
  const pending = useForms((s) => s.pendingFocus)
  useEffect(() => {
    if (pending && pending.docId === docId && pending.key === key && ref.current) {
      ref.current.focus()
      useForms.getState().setPendingFocus(null)
    }
  }, [pending, docId, key, ref])
}

interface WidgetProps {
  docId: string
  field: FieldModel
  widget: WidgetModel
  value: FieldValue
  geom: PageGeometry
  highlight: boolean
  inert: boolean
}

function boxStyle(p: WidgetProps): { style: CSSProperties; scale: number; heightPt: number } {
  const scale = p.geom.scaleX()
  const box = p.geom.rectToCss(p.widget.rect)
  const bw = p.widget.borderWidth * scale
  const heightPt = Math.abs(p.widget.rect.y2 - p.widget.rect.y1)
  const fits = Math.max(4, (heightPt - 2 * p.widget.borderWidth - 2) * 0.72)
  let fontPt = p.widget.fontSize && p.widget.fontSize > 0 ? p.widget.fontSize : p.field.multiline ? 12 : Math.min(12, fits)
  // Text can never be bigger than the box it lives in (some files declare a huge size for tiny fields).
  if (!p.field.multiline) fontPt = Math.min(fontPt, Math.max(4, heightPt - 2 * p.widget.borderWidth - 1))
  const style: CSSProperties = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    fontSize: fontPt * scale,
    lineHeight: p.field.multiline ? 1.2 : undefined,
    color: p.widget.color ?? '#000',
    textAlign: p.widget.align,
    padding: `${p.field.multiline ? 1 * scale : 0}px ${2 * scale}px`,
    border: bw > 0 && p.widget.borderColor ? `${bw}px solid ${p.widget.borderColor}` : undefined
  }
  if (!p.highlight && p.widget.background) style.backgroundColor = p.widget.background
  return { style, scale, heightPt }
}

const cls = (p: WidgetProps, extra = ''): string =>
  `epdf-field ${p.inert ? '' : 'pointer-events-auto'} ${p.highlight ? 'epdf-field-hl' : ''} ${extra}`.replace(/\s+/g, ' ').trim()

const labelOf = (f: FieldModel): string => (f.required ? `${f.label} (required)` : f.label)

function TextWidget(p: WidgetProps): JSX.Element {
  const { docId, field, widget } = p
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const abandon = useRef(false) // Escape: the blur that follows must not commit
  useFocusOnRequest(docId, widget.key, ref)
  const shown = draft ?? (typeof p.value === 'string' ? p.value : '')
  const { style } = boxStyle(p)

  const finish = (): void => {
    if (abandon.current) {
      abandon.current = false
      setDraft(null)
      return
    }
    if (draft === null) return
    const v = draft
    setDraft(null)
    void commitField(docId, field, v)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    isolateViewerKeys(e)
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (moveFocus(docId, widget.key, e.shiftKey ? -1 : 1)) e.preventDefault()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      abandon.current = true
      ;(e.currentTarget as HTMLElement).blur()
    } else if (e.key === 'Enter' && (!field.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).blur() // blur commits
    }
  }
  const common = {
    ref,
    className: cls(p),
    style,
    value: shown,
    readOnly: field.readOnly,
    maxLength: field.maxLength,
    tabIndex: field.readOnly || p.inert ? -1 : 0,
    'aria-label': labelOf(field),
    'aria-required': field.required || undefined,
    'aria-readonly': field.readOnly || undefined,
    'data-widget-key': widget.key,
    'data-field': field.name,
    autoComplete: 'off',
    spellCheck: field.password ? false : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: finish,
    onKeyDown
  }
  return field.multiline ? (
    <textarea {...common} style={{ ...style, resize: 'none' }} />
  ) : (
    <input {...common} type={field.password ? 'password' : 'text'} />
  )
}

function CheckWidget(p: WidgetProps): JSX.Element {
  const { docId, field, widget } = p
  const ref = useRef<HTMLInputElement>(null)
  useFocusOnRequest(docId, widget.key, ref)
  const isRadio = field.kind === 'radio'
  const checked = isRadio ? widget.onValue !== undefined && p.value === widget.onValue : p.value === true
  const { style } = boxStyle(p)
  return (
    <input
      ref={ref}
      type={isRadio ? 'radio' : 'checkbox'}
      name={isRadio ? `${docId}:${field.name}` : undefined}
      className={cls(p, 'epdf-field-check')}
      style={{ ...style, padding: 0, backgroundColor: p.highlight ? undefined : style.backgroundColor }}
      checked={checked}
      tabIndex={field.readOnly || p.inert ? -1 : 0}
      aria-label={isRadio ? `${labelOf(field)}: ${widget.onValue ?? ''}` : labelOf(field)}
      aria-required={field.required || undefined}
      aria-readonly={field.readOnly || undefined}
      data-widget-key={widget.key}
      data-field={field.name}
      onChange={(e) => {
        if (field.readOnly) return
        if (isRadio) void commitField(docId, field, widget.onValue ?? '')
        else void commitField(docId, field, e.target.checked)
      }}
      onClick={(e) => {
        if (field.readOnly) e.preventDefault()
      }}
      onKeyDown={(e) => {
        isolateViewerKeys(e)
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && moveFocus(docId, widget.key, e.shiftKey ? -1 : 1)) e.preventDefault()
      }}
    />
  )
}

function ChoiceWidget(p: WidgetProps): JSX.Element {
  const { docId, field, widget } = p
  const ref = useRef<HTMLSelectElement & HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const abandon = useRef(false)
  useFocusOnRequest(docId, widget.key, ref)
  const { style, scale } = boxStyle(p)
  const isList = field.kind === 'list'
  const listId = `${docId}-${field.name}-${widget.key}-opts`.replace(/[^A-Za-z0-9_-]/g, '_')
  const onKeyDown = (e: KeyboardEvent): void => {
    isolateViewerKeys(e)
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (moveFocus(docId, widget.key, e.shiftKey ? -1 : 1)) e.preventDefault()
    }
  }
  const aria = {
    'aria-label': labelOf(field),
    'aria-required': field.required || undefined,
    'aria-readonly': field.readOnly || undefined,
    'data-widget-key': widget.key,
    'data-field': field.name,
    tabIndex: field.readOnly || p.inert ? -1 : 0
  }

  if (field.kind === 'dropdown' && field.editable) {
    const shown = draft ?? (typeof p.value === 'string' ? p.value : '')
    return (
      <>
        <input
          ref={ref}
          className={cls(p)}
          style={style}
          list={listId}
          value={shown}
          readOnly={field.readOnly}
          autoComplete="off"
          {...aria}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (abandon.current) {
              abandon.current = false
              setDraft(null)
              return
            }
            if (draft === null) return
            const v = draft
            setDraft(null)
            void commitField(docId, field, v)
          }}
          onKeyDown={(e) => {
            isolateViewerKeys(e)
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              abandon.current = true
              e.currentTarget.blur()
            } else onKeyDown(e)
          }}
        />
        <datalist id={listId}>
          {field.options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </>
    )
  }

  const selected = Array.isArray(p.value) ? p.value : typeof p.value === 'string' && p.value ? [p.value] : []
  return (
    <select
      ref={ref}
      className={cls(p)}
      style={{ ...style, padding: `0 ${1 * scale}px` }}
      multiple={isList}
      size={isList ? Math.max(2, Math.floor(Math.abs(widget.rect.y2 - widget.rect.y1) / ((widget.fontSize || 12) * 1.25))) : undefined}
      value={isList ? selected : (selected[0] ?? '')}
      disabled={field.readOnly}
      {...aria}
      onChange={(e) => {
        const chosen = Array.from(e.target.selectedOptions).map((o) => o.value)
        void commitField(docId, field, isList ? chosen : (chosen[0] ?? ''))
      }}
      onKeyDown={onKeyDown}
    >
      {!isList && <option value="" />}
      {field.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

/**
 * Push buttons and signature fields can't be filled in: buttons only run PDF scripts (never executed here)
 * and real digital signatures need a certificate. PDF.js still paints their appearance on the page, so this
 * is just an invisible, labelled marker (outlined while "Highlight fields" is on).
 */
function UnsupportedWidget(p: WidgetProps): JSX.Element {
  const { field } = p
  const { style } = boxStyle(p)
  const why = field.kind === 'signature' ? 'signature field, not supported here (use the Sign tool for a visual signature)' : 'button, not supported'
  return (
    <div
      role="note"
      aria-label={`${field.label}: ${why}`}
      title={`${field.label}: ${why}`}
      className={`epdf-field-unsupported ${p.highlight ? 'epdf-field-unsupported-hl' : ''}`}
      data-field={field.name}
      style={{ left: style.left, top: style.top, width: style.width, height: style.height }}
    />
  )
}

export function FormFieldsOverlay({ docId, pageIndex, viewport }: PageOverlayProps): JSX.Element | null {
  const info = useForms((s) => s.docs[docId])
  const overrides = useForms((s) => s.overrides[docId])
  const highlight = useForms((s) => s.highlight)
  const activeTool = useWorkspace((s) => s.activeTool)
  const model = info?.model
  const items = useMemo(
    () => (model ? model.fields.flatMap((f) => f.widgets.filter((w) => w.pageIndex === pageIndex).map((w) => ({ field: f, widget: w }))) : []),
    [model, pageIndex]
  )
  const geom = useMemo(() => (viewport ? geometryOf(viewport) : null), [viewport])
  if (!geom || items.length === 0 || info?.encrypted) return null

  // While another Epdf tool owns the page (add text, stamps, signature), the inputs must not take clicks.
  const inert = !!activeTool && (activeTool.startsWith('forms.') || activeTool.startsWith('sign.'))

  return (
    <>
      {items.map(({ field, widget }) => {
        const props: WidgetProps = { docId, field, widget, value: effectiveValue(overrides, field), geom, highlight, inert }
        switch (field.kind) {
          case 'text':
            return <TextWidget key={widget.key} {...props} />
          case 'checkbox':
          case 'radio':
            return <CheckWidget key={widget.key} {...props} />
          case 'dropdown':
          case 'list':
            return <ChoiceWidget key={widget.key} {...props} />
          default:
            return <UnsupportedWidget key={widget.key} {...props} />
        }
      })}
    </>
  )
}
