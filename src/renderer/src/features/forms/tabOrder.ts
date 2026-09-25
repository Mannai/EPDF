import type { FieldModel, FormModel, WidgetModel } from './model'
import { FILLABLE_KINDS } from './model'

/**
 * Keyboard order between form fields: page by page, then reading order on the page as the reader sees it
 * (top to bottom, left to right — also on rotated pages). Read-only fields and push buttons are skipped;
 * a radio group is a single stop (arrow keys move inside it, as in every browser).
 */

export interface Stop {
  field: string
  /** The widget to focus when the stop is entered from another field. */
  key: string
  pageIndex: number
}

/** Visual sort keys of a widget: smaller `top` is higher on screen, smaller `left` further left. */
export function visualKeys(w: WidgetModel): { top: number; left: number } {
  const { x1, y1, x2, y2 } = w.rect
  switch (w.pageRotation) {
    case 90:
      return { top: x1, left: y1 }
    case 180:
      return { top: y1, left: -x2 }
    case 270:
      return { top: -x2, left: -y2 }
    default:
      return { top: -y2, left: x1 }
  }
}

const ROW_TOLERANCE = 3

/**
 * `pageTabs` = the pages' /Tabs entries (see `FormModel.pageTabs`): `S` follows the page's /Annots array (the
 * order the form builder's tab-order editor writes), `C` walks column by column, anything else (`R` or no
 * entry) is reading order, row by row.
 */
export function compareWidgets(a: WidgetModel, b: WidgetModel, pageTabs?: FormModel['pageTabs']): number {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex
  const mode = pageTabs?.[a.pageIndex]
  if (mode === 'S' && a.annotOrder !== undefined && b.annotOrder !== undefined) return a.annotOrder - b.annotOrder
  const ka = visualKeys(a)
  const kb = visualKeys(b)
  if (mode === 'C') {
    if (Math.abs(ka.left - kb.left) > ROW_TOLERANCE) return ka.left - kb.left
    return ka.top - kb.top
  }
  if (Math.abs(ka.top - kb.top) > ROW_TOLERANCE) return ka.top - kb.top
  return ka.left - kb.left
}

const tabbable = (f: FieldModel): boolean => FILLABLE_KINDS.includes(f.kind) && !f.readOnly

/** The tab stops of a form, in order. */
export function tabStops(model: FormModel): Stop[] {
  const entries: { widget: WidgetModel; field: FieldModel }[] = []
  const cmp = (a: WidgetModel, b: WidgetModel): number => compareWidgets(a, b, model.pageTabs)
  for (const field of model.fields) {
    if (!tabbable(field)) continue
    if (field.kind === 'radio') {
      // One stop per group: the checked button if there is one, otherwise the first.
      const sorted = [...field.widgets].sort(cmp)
      const checked = sorted.find((w) => w.onValue !== undefined && w.onValue === field.value)
      const first = sorted[0]
      if (first) entries.push({ widget: { ...first, key: (checked ?? first).key }, field })
    } else {
      for (const widget of field.widgets) entries.push({ widget, field })
    }
  }
  entries.sort((a, b) => cmp(a.widget, b.widget))
  return entries.map((e) => ({ field: e.field.name, key: e.widget.key, pageIndex: e.widget.pageIndex }))
}

/** The stop after/before the one that contains `currentKey` (null past either end). */
export function stepStop(stops: Stop[], model: FormModel, currentKey: string, dir: 1 | -1): Stop | null {
  const currentField = model.fields.find((f) => f.widgets.some((w) => w.key === currentKey))
  let idx = stops.findIndex((s) => s.key === currentKey)
  if (idx < 0 && currentField?.kind === 'radio') idx = stops.findIndex((s) => s.field === currentField.name)
  if (idx < 0) return null
  return stops[idx + dir] ?? null
}
