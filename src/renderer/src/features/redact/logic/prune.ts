import { PDFDict, PDFRef, PDFStream } from 'pdf-lib'
import { parseContent, type Op } from '../../textedit/pdfcontent/content'
import { N, ddict, dget, dname, nameText, refTag, streamBytes } from '../../textedit/pdfcontent/pdfutil'

/**
 * After a page was redacted, the entries of its (private) resource dictionaries that still point at the ORIGINAL
 * forms, images and graphics states — replaced at their use sites by redacted copies — must go, or the old objects
 * (with the unredacted content) would stay reachable. An entry is only removed when no operation of the finished
 * page (including the forms that inherit its resources) still refers to it by name, and only from dictionaries the
 * redaction itself created; shared dictionaries are never modified.
 */
export function pruneReplaced(pageRes: PDFDict | undefined, slots: readonly { ops: readonly Op[] }[], owned: ReadonlySet<PDFDict>, replaced: ReadonlySet<unknown>): void {
  if (replaced.size === 0) return
  type Used = { XObject: Set<string>; ExtGState: Set<string>; Pattern: Set<string>; Shading: Set<string> }
  const CATS = ['XObject', 'ExtGState', 'Pattern', 'Shading'] as const
  const used = new Map<PDFDict, Used>()
  const seen = new Set<string>()
  const ids = new WeakMap<object, number>()
  let nextId = 1
  const idOf = (o: object): number => {
    let i = ids.get(o)
    if (i === undefined) {
      i = nextId++
      ids.set(o, i)
    }
    return i
  }
  const entry = (d: PDFDict): Used => {
    let e = used.get(d)
    if (!e) used.set(d, (e = { XObject: new Set(), ExtGState: new Set(), Pattern: new Set(), Shading: new Set() }))
    return e
  }
  const walkOps = (ops: readonly Op[], res: PDFDict | undefined, depth: number): void => {
    if (depth > 20) return
    const e = res ? entry(res) : undefined
    for (const op of ops) {
      if ((op.op === 'scn' || op.op === 'SCN') && e) {
        const last = op.args[op.args.length - 1]
        if (last?.t === 'name') e.Pattern.add(last.v)
        continue
      }
      const a = op.args[0]
      if (a?.t !== 'name') continue
      if (op.op === 'sh' && e) e.Shading.add(a.v)
      else if (op.op === 'Do' && res) {
        e!.XObject.add(a.v)
        const target = ddict(res, 'XObject')?.lookup(N(a.v))
        if (target instanceof PDFStream && dname(target.dict, 'Subtype') === 'Form') visitForm(target, ddict(target.dict, 'Resources') ?? res, depth)
      } else if (op.op === 'gs' && res) {
        e!.ExtGState.add(a.v)
        const gsd = ddict(ddict(res, 'ExtGState'), a.v)
        const g = gsd ? dget(ddict(gsd, 'SMask'), 'G') : undefined
        if (g instanceof PDFStream) visitForm(g, ddict(g.dict, 'Resources') ?? res, depth)
      }
    }
  }
  const visitForm = (form: PDFStream, res: PDFDict, depth: number): void => {
    const key = `${idOf(form)}|${idOf(res)}`
    if (seen.has(key)) return
    seen.add(key)
    let ops: Op[]
    try {
      ops = parseContent(streamBytes(form)).ops
    } catch {
      // unreadable content: keep everything this form could name (mark all entries used)
      const e = entry(res)
      for (const cat of CATS) {
        const d = ddict(res, cat)
        if (d) for (const [k] of d.entries()) e[cat].add(nameText(k))
      }
      return
    }
    walkOps(ops, res, depth + 1)
  }
  if (pageRes) {
    entry(pageRes)
    for (const s of slots) walkOps(s.ops, pageRes, 0)
  }
  for (const [res, u] of used) {
    if (!owned.has(res)) continue
    for (const cat of CATS) {
      const d = res.get(N(cat))
      const dict = d instanceof PDFRef ? undefined : d
      if (!(dict instanceof PDFDict) || !owned.has(dict)) continue
      for (const [k, v] of [...dict.entries()]) {
        const key = v instanceof PDFRef ? refTag(v) : v
        if (replaced.has(key) && !u[cat].has(nameText(k))) dict.delete(k)
      }
    }
  }
}
