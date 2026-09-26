import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFObject } from 'pdf-lib'

/**
 * A strict validator for the /Outlines tree, following the PDF 32000-1 rules (§12.3.3). Used by the tests
 * (and available to anything that wants to check a document before shipping it): every problem is returned
 * as a readable message; an empty list means the outline is valid.
 */

const N = (s: string): PDFName => PDFName.of(s)

export function validateOutline(pdf: PDFDocument): string[] {
  const problems: string[] = []
  const ctx = pdf.context
  const entry = pdf.catalog.get(N('Outlines'))
  if (entry === undefined) return problems
  const root = entry instanceof PDFRef ? ctx.lookup(entry) : entry
  if (!(root instanceof PDFDict)) return ['/Outlines is not a dictionary']
  const type = root.lookup(N('Type'))
  if (type !== undefined && !(type instanceof PDFName && type.decodeText() === 'Outlines')) problems.push('/Outlines /Type is not /Outlines')
  if (root.has(N('Parent'))) problems.push('the outline root must not have a /Parent')

  const pageTags = new Set(pdf.getPages().map((p) => p.ref.tag))
  const seen = new Set<string>()
  const ref = (o: PDFObject | undefined): PDFRef | undefined => (o instanceof PDFRef ? o : undefined)

  /** Validates the children of `parent`; returns the number of items visible below it. */
  const check = (parent: PDFDict, parentRef: PDFRef | undefined, label: string): number => {
    const first = parent.get(N('First'))
    const last = parent.get(N('Last'))
    const count = parent.lookup(N('Count'))
    if ((first === undefined) !== (last === undefined)) problems.push(`${label}: /First and /Last must both be present or both absent`)
    if (first === undefined) {
      if (count instanceof PDFNumber && count.asNumber() !== 0) problems.push(`${label}: has /Count ${count.asNumber()} but no children`)
      return 0
    }
    let cur: PDFObject | undefined = first
    let prevRef: PDFRef | undefined
    let lastSeen: PDFRef | undefined
    let visible = 0
    let index = 0
    while (cur !== undefined) {
      const r = ref(cur)
      const where = `${label}/${index}`
      if (!r) {
        problems.push(`${where}: an outline item must be an indirect object`)
        break
      }
      if (seen.has(r.tag)) {
        problems.push(`${where}: item ${r.tag} is reachable twice (cycle or shared item)`)
        break
      }
      seen.add(r.tag)
      const dict = ctx.lookup(r)
      if (!(dict instanceof PDFDict)) {
        problems.push(`${where}: ${r.tag} is not a dictionary`)
        break
      }
      const title = dict.lookup(N('Title'))
      if (!(title instanceof PDFString || title instanceof PDFHexString)) problems.push(`${where}: /Title is missing or not a text string`)
      const parentEntry = ref(dict.get(N('Parent')))
      if (!parentEntry || (parentRef && parentEntry.tag !== parentRef.tag) || (!parentRef && !parentEntry)) problems.push(`${where}: /Parent is wrong`)
      const prev = ref(dict.get(N('Prev')))
      if (index === 0 && dict.has(N('Prev'))) problems.push(`${where}: the first item must not have /Prev`)
      if (index > 0 && (!prev || prev.tag !== prevRef!.tag)) problems.push(`${where}: /Prev does not point at the previous sibling`)
      if (dict.has(N('Dest')) && dict.has(N('A'))) problems.push(`${where}: has both /Dest and /A`)
      const dest = dict.lookup(N('Dest'))
      if (dest instanceof PDFArray) {
        const page = dest.get(0)
        if (!(page instanceof PDFRef) || !pageTags.has(page.tag)) problems.push(`${where}: /Dest does not start with a page of this document`)
      }
      const flags = dict.lookup(N('F'))
      if (flags !== undefined && !(flags instanceof PDFNumber && Number.isInteger(flags.asNumber()) && flags.asNumber() >= 0 && flags.asNumber() <= 3)) problems.push(`${where}: /F is not 0..3`)
      const color = dict.lookup(N('C'))
      if (color !== undefined && !(color instanceof PDFArray && color.size() === 3)) problems.push(`${where}: /C is not an RGB triple`)

      const below = check(dict, r, where)
      const cnt = dict.lookup(N('Count'))
      const hasKids = dict.has(N('First'))
      if (hasKids) {
        if (!(cnt instanceof PDFNumber)) problems.push(`${where}: an item with children needs /Count`)
        else if (Math.abs(cnt.asNumber()) !== below) problems.push(`${where}: /Count ${cnt.asNumber()} but ${below} descendants are visible when open`)
      }
      visible += 1 + (hasKids && cnt instanceof PDFNumber && cnt.asNumber() > 0 ? below : 0)
      lastSeen = r
      prevRef = r
      const next = dict.get(N('Next'))
      cur = next
      index++
      if (next === undefined) break
    }
    if (lastSeen && (!ref(last) || ref(last)!.tag !== lastSeen.tag)) problems.push(`${label}: /Last does not point at the last child`)
    if (lastSeen) {
      const lastDict = ctx.lookup(lastSeen)
      if (lastDict instanceof PDFDict && lastDict.has(N('Next'))) problems.push(`${label}: the last item must not have /Next`)
    }
    return visible
  }

  const rootRef = entry instanceof PDFRef ? entry : undefined
  const total = check(root, rootRef, 'outline')
  const count = root.lookup(N('Count'))
  if (root.has(N('First'))) {
    if (!(count instanceof PDFNumber)) problems.push('outline: the root needs /Count')
    else if (count.asNumber() !== total) problems.push(`outline: root /Count is ${count.asNumber()} but ${total} items are visible`)
  }
  return problems
}
