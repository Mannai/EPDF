import type { PDFDocument } from 'pdf-lib'
import type { GroupSettings, MarkGroup, OverlaySettings } from '../../../../../shared/features/headerfooter'
import { applyHeaderFooter, applyOverlay, type ApplyOptions, type ApplyResult, type SourceInput } from './apply'
import { removeMarks, type RemoveResult } from './remove'

/**
 * One application as the dialog runs it (inside one `editPdf`, i.e. one undo step): optionally remove what the group
 * added before (Epdf's own marks, and Acrobat-style marks of the same kind, except for Bates which only Epdf tells
 * apart), then apply the new settings.
 */

export interface GroupApplyOptions extends ApplyOptions {
  /** replace = remove the group's earlier marks first; add = keep them and add another. */
  mode: 'replace' | 'add'
  source?: SourceInput
}

export interface GroupApplyResult extends ApplyResult {
  removed: RemoveResult | null
}

/** Groups whose Acrobat-made marks a replace also removes. */
const foreignRemovable = (g: MarkGroup): boolean => g !== 'bates'

export async function applyGroup(pdf: PDFDocument, gs: GroupSettings, o: GroupApplyOptions): Promise<GroupApplyResult> {
  let removed: RemoveResult | null = null
  if (o.mode === 'replace') {
    removed = await removeMarks(pdf, {
      groups: [gs.group],
      foreign: foreignRemovable(gs.group),
      keep: o.source && 'ref' in o.source ? [o.source.ref] : [],
      isCancelled: o.isCancelled,
      yieldEvery: o.yieldEvery
    })
  }
  const r = gs.group === 'headerfooter' || gs.group === 'bates' ? await applyHeaderFooter(pdf, gs.group, gs.settings, o) : await applyOverlay(pdf, gs.group, gs.settings as OverlaySettings, o.source, o)
  return { pages: r.pages, missing: r.missing, removed }
}

export async function removeGroup(pdf: PDFDocument, group: MarkGroup, o: { isCancelled?(): boolean; yieldEvery?: number } = {}): Promise<RemoveResult> {
  return removeMarks(pdf, { groups: [group], foreign: foreignRemovable(group), ...o })
}
