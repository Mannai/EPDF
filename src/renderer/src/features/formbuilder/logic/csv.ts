import { describeFormat } from './actions'
import { KIND_LABEL, type FieldInfo } from './spec'

/** CSV export of the form's field list (RFC 4180: comma separated, CRLF, quotes doubled). Pure TypeScript. */

const esc = (v: string | number | boolean | undefined): string => {
  const s = v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const CSV_HEADER = ['Name', 'Type', 'Page', 'Required', 'Read-only', 'Tooltip', 'Options', 'Default value', 'Max length', 'Format']

export function fieldsToCsv(fields: FieldInfo[]): string {
  const rows = fields.map((f) => {
    const pages = [...new Set(f.widgets.map((w) => w.pageIndex + 1))].sort((a, b) => a - b).join(' ')
    const options = f.kind === 'radio' ? f.widgets.map((w) => w.value ?? '').join('; ') : f.kind === 'checkbox' ? f.onValue : f.options.join('; ')
    return [f.name, KIND_LABEL[f.kind], pages, f.required ? 'Yes' : 'No', f.readOnly ? 'Yes' : 'No', f.tooltip, options, f.defaultValue, f.maxLength ?? '', describeFormat(f.format)]
  })
  return [CSV_HEADER, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
}
