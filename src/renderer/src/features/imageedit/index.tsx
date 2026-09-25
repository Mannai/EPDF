import { registerPageOverlay, registerTool } from '../api'
import { IMAGE_TOOL_ID, ImageOverlay } from './ImageOverlay'
import { ImageOptions } from './ImageOptions'
import { useImageEdit } from './state'

/**
 * Feature: edit images in the page content (docs/features/edit-content.md): select, move, resize, delete,
 * replace and add pictures. The content-stream operations live in ../textedit/pdfcontent (unit-tested in Node);
 * the native file dialog is the `imageedit:pickImage` channel in src/main/features/imageedit.
 */

registerTool({
  id: IMAGE_TOOL_ID,
  label: 'Edit images',
  group: 'Edit',
  order: 310,
  icon: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.75" cy="6.5" r="1" />
      <path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3" />
    </svg>
  ),
  Options: ImageOptions,
  onDeactivate: () => {
    useImageEdit.getState().select(null)
    useImageEdit.getState().setPending(null)
  }
})

registerPageOverlay(ImageOverlay)
