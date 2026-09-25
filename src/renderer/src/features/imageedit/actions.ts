import type { PageViewport } from 'pdfjs-dist'
import { EditError, editPdf } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import type { PickedImage } from '@shared/features/imageedit'
import { addImage, deleteImage, replaceImage, transformImage, type ImageEditInfo, type Picture } from '../textedit/pdfcontent/imageEdit'
import { pictureSize } from '../textedit/pdfcontent/imageSize'
import type { Matrix, Rect } from '../textedit/pdfcontent/matrix'
import { EditRefusedError } from '../textedit/pdfcontent/write'
import { useImageEdit, type PendingImage, type SelectedImage } from './state'

/** The result of the native picker, or null when the user cancelled. */
export async function pickImage(): Promise<PickedImage | null> {
  try {
    const res = await window.epdf.call<PickedImage | null>('imageedit:pickImage', {})
    if (!res) return null
    return { ...res, bytes: new Uint8Array(res.bytes) }
  } catch (err) {
    notify('error', `Couldn’t open the image: ${errorMessage(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
    return null
  }
}

async function run(label: string, fn: (pdf: import('pdf-lib').PDFDocument) => ImageEditInfo | Promise<ImageEditInfo>, docId: string): Promise<boolean> {
  const st = useImageEdit.getState()
  if (st.busy) return false
  st.setBusy(true)
  try {
    let info: ImageEditInfo | undefined
    await editPdf(docId, label, async (pdf) => {
      info = await fn(pdf)
    })
    if (info) notify('success', info.message)
    return true
  } catch (err) {
    notify('error', err instanceof EditRefusedError || err instanceof EditError ? err.message : `Couldn’t change the image: ${errorMessage(err)}`)
    return false
  } finally {
    useImageEdit.getState().setBusy(false)
  }
}

const sizeOf = (r: Rect): [number, number] => [r.x1 - r.x0, r.y1 - r.y0]

/** Moves and/or resizes the selected image to `box` (user space). One undo step. */
export async function applyImageBox(sel: SelectedImage, box: Rect): Promise<boolean> {
  const [w0, h0] = sizeOf(sel.bbox)
  const [w1, h1] = sizeOf(box)
  const resized = Math.abs(w0 - w1) > 0.01 || Math.abs(h0 - h1) > 0.01
  const ok = await run(resized ? 'Resize image' : 'Move image', (pdf) => transformImage(pdf, sel.pageIndex, sel.id, box), sel.docId)
  if (ok) useImageEdit.getState().select({ ...sel, id: '', bbox: box })
  return ok
}

export async function removeImage(sel: SelectedImage): Promise<boolean> {
  const ok = await run('Delete image', (pdf) => deleteImage(pdf, sel.pageIndex, sel.id), sel.docId)
  if (ok) useImageEdit.getState().select(null)
  return ok
}

export async function replaceSelected(sel: SelectedImage, pic: Picture): Promise<boolean> {
  const mode = useImageEdit.getState().mode
  const ok = await run('Replace image', (pdf) => replaceImage(pdf, sel.pageIndex, sel.id, pic, mode), sel.docId)
  if (ok) useImageEdit.getState().select({ ...sel, id: '' })
  return ok
}

export async function placeImage(p: PendingImage, pageIndex: number, placement: Matrix): Promise<boolean> {
  const ok = await run('Add image', (pdf) => addImage(pdf, pageIndex, p.picture, placement), p.docId)
  if (ok) useImageEdit.getState().setPending(null)
  return ok
}

/**
 * Matrix for an upright image occupying a rectangle of the *displayed* page (viewport pixels), correct on
 * rotated pages: the unit square's corners are mapped through the viewport.
 */
export function placementFromViewportRect(viewport: PageViewport, x: number, y: number, w: number, h: number): Matrix {
  const p0 = viewport.convertToPdfPoint(x, y + h) as [number, number]
  const p1 = viewport.convertToPdfPoint(x + w, y + h) as [number, number]
  const p2 = viewport.convertToPdfPoint(x, y) as [number, number]
  return [p1[0] - p0[0], p1[1] - p0[1], p2[0] - p0[0], p2[1] - p0[1], p0[0], p0[1]]
}

export function describePicked(p: PickedImage): { width: number; height: number } {
  return pictureSize(p.bytes) ?? { width: 200, height: 200 }
}
