import { currentBytes } from '../../edit/session'
import { getAcceptedPassword, getLoaded } from '../../pdf/docCache'
import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { getCommand } from '../api'
import { inspectEncryption } from './crypto/document'
import { authenticate } from './crypto/handler'
import { isAllowed, type Restricted } from './logic'
import { forgetAccess, getAccess, setAccess } from './session'

/**
 * Enforcing the document's permissions in the parts of Epdf that print or extract content, without editing those
 * features: when a document was opened with a USER password and its /P forbids printing or copying, the print and
 * export commands and the clipboard "copy" of page text politely refuse. (Editing is enforced in the unlock hook.)
 * Opened with the owner password, everything is allowed. These flags are advisory in other software.
 */

const PDFJS_PRINT = 0x04
const PDFJS_COPY = 0x10

type What = Restricted

const MESSAGES: Record<What, string> = {
  print: 'Printing is not allowed by this document’s permissions. Open it with the owner password to print.',
  copy: 'Copying is not allowed by this document’s permissions. Open it with the owner password to copy.'
}

const allowed = (docId: string | undefined, what: What): boolean => !docId || isAllowed(getAccess(docId), what)

/** Refuses politely (a toast) when `what` is not allowed for the active document. Returns whether it is allowed. */
export function checkAllowed(what: What): boolean {
  const t = activeTab()
  if (allowed(t?.docId, what)) return true
  notify('info', MESSAGES[what])
  return false
}

const probed = new Set<string>()

/**
 * For a freshly opened, restricted document, work out whether the password used was the owner's. PDF.js already
 * opened the document; here we only need the /Encrypt parameters and the password it accepted (both in memory).
 */
async function probeOpened(docId: string, loadSeq: number): Promise<void> {
  const key = `${docId}:${loadSeq}`
  if (probed.has(key)) return
  probed.add(key)
  forgetAccess(docId)
  const doc = getLoaded(docId)?.doc
  if (!doc) return
  const raw = (await doc.getPermissions().catch(() => null)) as Iterable<number> | null // an array or a Set, depending on the PDF.js version
  if (!raw) return // not encrypted
  const allowed = new Set<number>(raw)
  if (allowed.has(PDFJS_PRINT) && allowed.has(PDFJS_COPY)) return // nothing to enforce here
  try {
    const probe = await inspectEncryption(await currentBytes(docId))
    if (!probe) return
    const pw = getAcceptedPassword(docId) ?? ''
    const access = (await authenticate(probe.info, pw)) ?? (await authenticate(probe.info, ''))
    if (access) setAccess(docId, { kind: access.kind, P: probe.info.P, R: probe.info.R })
  } catch (err) {
    console.warn('could not read the document permissions', err)
  }
}

function patch(id: string, what: What): void {
  const c = getCommand(id)
  if (!c) return
  const run = c.run
  c.run = (args) => {
    if (!checkAllowed(what)) return
    return run(args)
  }
}

export function installGates(): void {
  // Other features register their commands at start-up; wrap them once everything has loaded.
  setTimeout(() => {
    for (const id of ['print.open', 'print.toPdf']) patch(id, 'print')
    for (const id of ['export.docx', 'export.xlsx', 'export.pptx']) patch(id, 'copy')
  }, 0)

  // Copying page text (Ctrl+C / Edit ▸ Copy while a selection in the page is active).
  document.addEventListener(
    'copy',
    (e) => {
      const t = activeTab()
      if (!t || allowed(t.docId, 'copy')) return
      const node = window.getSelection()?.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!el?.closest('.epdf-page, .textLayer')) return // a search box or form field: not document content
      e.preventDefault()
      e.stopPropagation()
      notify('info', MESSAGES.copy)
    },
    true
  )

  let last = new Map<string, number>()
  useTabs.subscribe((state) => {
    const now = new Map<string, number>()
    for (const t of state.tabs) {
      now.set(t.docId, t.loadSeq)
      if (t.status === 'ready' && t.loadSeq >= 0) void probeOpened(t.docId, t.loadSeq)
    }
    for (const id of last.keys()) {
      if (!now.has(id)) {
        forgetAccess(id)
        for (const k of [...probed]) if (k.startsWith(`${id}:`)) probed.delete(k)
      }
    }
    last = now
  })
}
