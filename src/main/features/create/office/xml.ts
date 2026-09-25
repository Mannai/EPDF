/**
 * A small, fast, dependency-free XML reader for OOXML/ODF parts. It builds a light tree of elements
 * (`XNode`) and is deliberately forgiving: unknown entities are kept as text, unclosed tags are closed at
 * the end, and DOCTYPE/comments/processing instructions are skipped. Element names are exposed WITHOUT
 * their namespace prefix (`w:p` -> `p`) because the formats we read use prefixes consistently and the same
 * local names rarely collide inside one part; the prefix stays available in `prefix`.
 */

export interface XNode {
  /** Local name (no prefix). */
  name: string
  prefix: string
  attrs: Record<string, string>
  children: XNode[]
  /** Text directly inside this element, in document order interleaved with children via `nodes`. */
  text: string
  /** Mixed content in document order: XNode for elements, string for text. */
  nodes: (XNode | string)[]
  parent: XNode | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
      try {
        return String.fromCodePoint(cp)
      } catch {
        return ''
      }
    }
    return ENTITIES[e] ?? m
  })
}

const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 58 || c === 95 || c === 45 || c === 46 || c > 127

export function parseXml(src: string): XNode {
  const root: XNode = { name: '#document', prefix: '', attrs: {}, children: [], text: '', nodes: [], parent: null }
  let cur = root
  let i = 0
  const n = src.length
  if (src.charCodeAt(0) === 0xfeff) i = 1
  const addText = (t: string): void => {
    if (!t) return
    cur.text += t
    const last = cur.nodes[cur.nodes.length - 1]
    if (typeof last === 'string') cur.nodes[cur.nodes.length - 1] = last + t
    else cur.nodes.push(t)
  }
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      addText(decodeEntities(src.slice(i)))
      break
    }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)))
    i = lt
    const c1 = src.charCodeAt(i + 1)
    if (c1 === 33) {
      // <! ... comment, CDATA, doctype
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4)
        i = end < 0 ? n : end + 3
      } else if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i + 9)
        addText(src.slice(i + 9, end < 0 ? n : end))
        i = end < 0 ? n : end + 3
      } else {
        // DOCTYPE, possibly with an internal subset in brackets
        let depth = 0
        let j = i + 2
        for (; j < n; j++) {
          const ch = src[j]
          if (ch === '[') depth++
          else if (ch === ']') depth--
          else if (ch === '>' && depth <= 0) break
        }
        i = j + 1
      }
      continue
    }
    if (c1 === 63) {
      // <? processing instruction
      const end = src.indexOf('?>', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c1 === 47) {
      // closing tag
      const end = src.indexOf('>', i + 2)
      const raw = src.slice(i + 2, end < 0 ? n : end).trim()
      i = end < 0 ? n : end + 1
      const local = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
      // pop to the matching open element (tolerate mismatches)
      let p: XNode | null = cur
      while (p && p !== root && p.name !== local) p = p.parent
      if (p && p !== root) cur = p.parent ?? root
      continue
    }
    // opening tag
    let j = i + 1
    while (j < n && isNameChar(src.charCodeAt(j))) j++
    const qname = src.slice(i + 1, j)
    if (!qname) {
      addText('<')
      i++
      continue
    }
    const attrs: Record<string, string> = {}
    let selfClose = false
    for (;;) {
      while (j < n && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t')) j++
      if (j >= n) break
      const ch = src[j]
      if (ch === '>') {
        j++
        break
      }
      if (ch === '/') {
        selfClose = true
        j++
        continue
      }
      let k = j
      while (k < n && isNameChar(src.charCodeAt(k))) k++
      if (k === j) {
        j++ // stray character
        continue
      }
      const an = src.slice(j, k)
      j = k
      while (j < n && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t')) j++
      if (src[j] === '=') {
        j++
        while (j < n && (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t')) j++
        const q = src[j]
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, j + 1)
          attrs[an] = decodeEntities(src.slice(j + 1, e < 0 ? n : e))
          j = e < 0 ? n : e + 1
        } else {
          let e = j
          while (e < n && !/[\s>/]/.test(src[e])) e++
          attrs[an] = decodeEntities(src.slice(j, e))
          j = e
        }
      } else attrs[an] = ''
    }
    i = j
    const colon = qname.indexOf(':')
    const node: XNode = {
      name: colon >= 0 ? qname.slice(colon + 1) : qname,
      prefix: colon >= 0 ? qname.slice(0, colon) : '',
      attrs,
      children: [],
      text: '',
      nodes: [],
      parent: cur
    }
    cur.children.push(node)
    cur.nodes.push(node)
    if (!selfClose) cur = node
  }
  return root
}

// ---------------------------------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------------------------------

/** First child element with local name `name`. */
export const child = (n: XNode | null | undefined, name: string): XNode | undefined => n?.children.find((c) => c.name === name)

export const childrenNamed = (n: XNode | null | undefined, name: string): XNode[] => (n ? n.children.filter((c) => c.name === name) : [])

/** Follows a path of child names: `path(n, 'tblPr', 'tblBorders', 'top')`. */
export function path(n: XNode | null | undefined, ...names: string[]): XNode | undefined {
  let cur: XNode | undefined | null = n
  for (const nm of names) {
    cur = cur ? child(cur, nm) : undefined
    if (!cur) return undefined
  }
  return cur ?? undefined
}

/** Attribute by local name, ignoring any prefix (`w:val` -> 'val'). */
export function attr(n: XNode | null | undefined, name: string): string | undefined {
  if (!n) return undefined
  const a = n.attrs
  if (name in a) return a[name]
  for (const k in a) {
    const c = k.indexOf(':')
    if (c >= 0 && k.slice(c + 1) === name) return a[k]
  }
  return undefined
}

export const numAttr = (n: XNode | null | undefined, name: string): number | undefined => {
  const v = attr(n, name)
  if (v === undefined || v === '') return undefined
  const x = Number(v)
  return Number.isFinite(x) ? x : undefined
}

/** All descendant elements (depth-first) with local name `name`. */
export function descendants(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c)
    descendants(c, name, out)
  }
  return out
}

/** Concatenated text of all descendants. */
export function textContent(n: XNode): string {
  let s = ''
  for (const x of n.nodes) s += typeof x === 'string' ? x : textContent(x)
  return s
}

/** Escapes text for XML output (used by tests and the writers of fixtures). */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
