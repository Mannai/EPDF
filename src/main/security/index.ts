import { app, session, shell, type WebContents } from 'electron'
import { APP_ORIGIN } from '../services/protocol'

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

// Vite's dev server needs inline scripts/HMR websocket.
const DEV_CSP = [
  "default-src 'self' epdf-app:",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: epdf-app:",
  "font-src 'self' data: epdf-app:",
  "connect-src 'self' epdf-app: ws:",
  "worker-src 'self' blob: epdf-app:",
  "object-src 'none'"
].join('; ')

export function isTrustedUrl(url: string): boolean {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (url.startsWith(APP_ORIGIN + '/')) return true
  return !app.isPackaged && !!dev && url.startsWith(dev)
}

/** CSP, permission denial and navigation lock-down. Call once after `app.whenReady()`. */
export function installSecurity(): void {
  // The strict policy applies to everything except a live Vite dev server (which needs inline HMR scripts).
  const csp = process.env['ELECTRON_RENDERER_URL'] && !app.isPackaged ? DEV_CSP : PROD_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // Everything is denied except a VIDEO-ONLY camera stream for Epdf's own pages (webcam scanning). No
  // microphone, no geolocation, no notifications, nothing for any other origin.
  const trustedOrigin = (origin: string): boolean => isTrustedUrl(origin.endsWith('/') ? origin : `${origin}/`)
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const media = details as { mediaTypes?: string[] }
    const videoOnly = !!media.mediaTypes && media.mediaTypes.length > 0 && media.mediaTypes.every((t) => t === 'video')
    cb(permission === 'media' && videoOnly && trustedOrigin(new URL(wc.getURL()).origin))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const media = details as { mediaType?: string }
    return permission === 'media' && media.mediaType === 'video' && trustedOrigin(requestingOrigin)
  })
}

export function lockDownWebContents(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) {
      e.preventDefault()
      openExternalSafely(url)
    }
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

/** Only http(s) and mailto links may leave the app. */
export function openExternalSafely(url: string): void {
  try {
    const u = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) void shell.openExternal(u.toString())
  } catch {
    /* ignore malformed */
  }
}
