/**
 * Validation of link targets typed by the user or found in the text. Only web, e-mail and telephone
 * addresses are allowed: `javascript:`, `file:`, `data:`, `vbscript:`, `ftp:`, custom app schemes and anything else
 * are refused, because a PDF link that runs code or opens local files is an attack, not a convenience.
 */

export const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const
export type LinkScheme = (typeof ALLOWED_SCHEMES)[number]

export type UrlCheck = { ok: true; url: string; scheme: LinkScheme } | { ok: false; reason: string }

export const MAX_URL_LENGTH = 2048

const SCHEME = /^([a-z][a-z0-9+.-]*):/i
// A conservative address check: no quoted local parts or comments; that is what real addresses look like.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const BARE_DOMAIN = /^(?:www\.)?[^\s/@:?#.]+(?:\.[^\s/@:?#.]+)*\.[^\s/@:?#.]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/u

const bad = (reason: string): UrlCheck => ({ ok: false, reason })

function hasControlOrSpace(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false
  return true
}

/** Checks (and normalises) a link address. `www.example.com` and `me@example.com` are completed to https:// and mailto:. */
export function checkUrl(input: string): UrlCheck {
  const raw = input.trim()
  if (!raw) return bad('Enter a web address, e-mail address or phone number.')
  if (raw.length > MAX_URL_LENGTH) return bad(`The address is longer than ${MAX_URL_LENGTH} characters.`)
  const m = SCHEME.exec(raw)
  // Phone numbers are commonly typed with spaces; every other address must not contain any.
  const isTel = !!m && m[1].toLowerCase() === 'tel'
  if (hasControlOrSpace(isTel ? raw.replace(/ +/g, '') : raw)) return bad('The address must not contain spaces or control characters.')

  if (!m) {
    if (EMAIL.test(raw)) return checkMailto(`mailto:${raw}`)
    if (BARE_DOMAIN.test(raw)) return checkWeb(`https://${raw}`, 'https')
    return bad('Enter a full address such as https://example.com, or an e-mail address such as name@example.com.')
  }
  const scheme = m[1].toLowerCase()
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) {
    return bad(`Links of type "${scheme}:" are not allowed. Use http, https, mailto or tel.`)
  }
  if (scheme === 'mailto') return checkMailto(`mailto:${raw.slice(m[0].length)}`)
  if (scheme === 'tel') return checkTel(raw.slice(m[0].length))
  return checkWeb(`${scheme}:${raw.slice(m[0].length)}`, scheme as 'http' | 'https')
}

function checkWeb(candidate: string, scheme: 'http' | 'https'): UrlCheck {
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return bad('That is not a valid web address.')
  }
  if (u.protocol !== `${scheme}:`) return bad('That is not a valid web address.')
  if (!u.hostname) return bad('The web address has no host name.')
  if (u.username || u.password) return bad('Web addresses with a user name or password are not allowed.')
  if (!/^[a-z0-9.\-[\]:]+$/i.test(u.hostname)) return bad('The host name contains characters that are not allowed.')
  if (u.href.length > MAX_URL_LENGTH) return bad(`The address is longer than ${MAX_URL_LENGTH} characters.`)
  return { ok: true, url: u.href, scheme } // href is percent-encoded 7-bit ASCII (IDN hosts as punycode)
}

function checkMailto(candidate: string): UrlCheck {
  const rest = candidate.slice('mailto:'.length)
  const q = rest.indexOf('?')
  const addressPart = q < 0 ? rest : rest.slice(0, q)
  const query = q < 0 ? '' : rest.slice(q)
  if (!addressPart) return bad('Enter an e-mail address.')
  const addresses = addressPart.split(',')
  for (const a of addresses) {
    let decoded: string
    try {
      decoded = decodeURIComponent(a)
    } catch {
      return bad('That is not a valid e-mail address.')
    }
    if (!EMAIL.test(decoded)) return bad(`"${decoded}" is not a valid e-mail address.`)
  }
  let encodedQuery = query
  if (!isAscii(encodedQuery)) {
    try {
      encodedQuery = encodeURI(encodedQuery)
    } catch {
      return bad('The e-mail subject or body contains invalid characters.')
    }
  }
  const url = `mailto:${addresses.map((a) => encodeURI(decodeURIComponent(a))).join(',')}${encodedQuery}`
  if (url.length > MAX_URL_LENGTH) return bad(`The address is longer than ${MAX_URL_LENGTH} characters.`)
  return { ok: true, url, scheme: 'mailto' }
}

function checkTel(number: string): UrlCheck {
  const n = number.replace(/[\s]/g, '')
  if (!/^\+?[0-9().\-*#;=pwPW,a-zA-Z]*$/.test(n) || (n.match(/[0-9]/g) ?? []).length < 3) return bad('Enter a phone number such as +974 4444 4444.')
  return { ok: true, url: `tel:${n}`, scheme: 'tel' }
}

export interface Linkable {
  start: number
  end: number
  text: string
  url: string
  kind: 'web' | 'email'
}

const TRAILING_CHAR = /[.,;:!?'"”’»)\]}>،؛؟]/u

/**
 * Finds web addresses (http/https/www.) and e-mail addresses in a line of text. Trailing punctuation is not
 * part of the address, and a closing parenthesis only belongs to it when the address opened one itself.
 */
export function findLinkables(text: string): Linkable[] {
  const found: Linkable[] = []
  const re = /(?:(?:https?:\/\/|www\.)[^\s<>"“”«»]+)|(?:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let s = m[0]
    // Trim trailing punctuation one character at a time, but keep a `)` that balances a `(` inside the address.
    while (s.length && TRAILING_CHAR.test(s[s.length - 1])) {
      if (s.endsWith(')') && (s.match(/\)/g) ?? []).length <= (s.match(/\(/g) ?? []).length) break
      s = s.slice(0, -1)
    }
    if (!s) continue
    const isMail = !/^(https?:\/\/|www\.)/i.test(s)
    const check = checkUrl(s)
    if (!check.ok) continue
    found.push({ start: m.index, end: m.index + s.length, text: s, url: check.url, kind: isMail ? 'email' : 'web' })
  }
  return found
}
