import { AnnotationMode } from 'pdfjs-dist'
import { create } from 'zustand'

/**
 * How PDF.js paints annotations onto the page canvas. Features change this through `setAnnotationMode`.
 *  - `AnnotationMode.ENABLE` (default): annotations *and* form-field appearances are painted on the canvas.
 *  - `AnnotationMode.ENABLE_FORMS`: annotations are painted but form widgets are NOT (a feature draws its
 *    own interactive inputs over them instead).
 *  - `AnnotationMode.DISABLE`: no annotations at all (e.g. "print without annotations" previews).
 */
interface ViewerOptions {
  annotationMode: number
  setAnnotationMode(mode: number): void
}

export const useViewerOptions = create<ViewerOptions>((set) => ({
  annotationMode: AnnotationMode.ENABLE,
  setAnnotationMode: (annotationMode) => set({ annotationMode })
}))

export { AnnotationMode }
