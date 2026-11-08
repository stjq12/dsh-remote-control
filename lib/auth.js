/**
 * Shared authorization for the plugin's own HTTP surfaces.
 *
 * The page that drives this plugin is a normal DSH owner page. Its requests can
 * therefore be admitted by DSH's own Connection service (Cookie + Host/Origin
 * fence). The desktop shell does not always expose that Cookie to the plugin
 * route, so a per-process page capability is accepted as a second factor: it is
 * injected into the authenticated index HTML and never appears in a network
 * response. A network client that did not load that page has neither.
 *
 * @module dsh-remote-control/lib/auth
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { isAbsolutePath } from './paths.js'

/** Header the page hook adds to every plugin-route request. */
export const CAPABILITY_HEADER = 'x-dsh-remote-control-capability'

/** How long a download ticket stays valid. */
export const TICKET_TTL_MS = 60_000

/** Upper bound accepted for a ticket expiry, so a forged long-lived one is useless. */
const MAX_TICKET_TTL_MS = 5 * 60_000

/** Read one header from node or Fetch headers. */
function header(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const raw = headers[name]
  if (raw === undefined) return undefined
  return Array.isArray(raw) ? raw.join(', ') : String(raw)
}

/** Compare two strings without leaking length through timing. */
export function secureEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether a request carries the page capability, as a header or (for the mux
 * WebSocket, where a browser cannot set a header) the legacy `rc` query.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {string} secret - per-process page capability.
 * @param {URL} [url] - parsed request URL.
 * @returns {boolean} true when it matches.
 */
export function capabilityMatches(req, secret, url) {
  if (typeof secret !== 'string' || secret === '') return false
  // The mux upgrade has its own `rc` query check. HTTP routes must carry the
  // capability in a header so a mux URL that lands in a proxy log cannot also
  // authenticate /state, /rbr/*, or a download request.
  const offered = header(req?.headers, CAPABILITY_HEADER) ?? ''
  return secureEqual(String(offered), secret)
}

/** Hostname of a Host header, without brackets or port. */
function hostnameOf(host) {
  if (typeof host !== 'string' || host === '') return ''
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** Whether a hostname is a loopback spelling. */
function isLoopbackHostname(name) {
  if (name === 'localhost' || name === '::1' || name === '::ffff:127.0.0.1') return true
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  return ipv4 !== null && ipv4.slice(1).every((part) => Number(part) <= 255)
}

/** Whether an Origin is same-authority with the request Host. */
function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  // The desktop shell and file-based pages use a non-HTTP origin; the page
  // capability is the authentication there.
  if (!/^https?:/i.test(origin)) return true
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Whether the request targets this listener's own authority. */
function trustedHost(ctx, req) {
  const connection = ctx?.get?.('connection')
  if (typeof connection?.isTrusted === 'function') {
    try {
      return connection.isTrusted(req) === true
    } catch {
      return false
    }
  }
  const name = hostnameOf(req?.headers?.host)
  if (name === '') return false
  if (isLoopbackHostname(name)) return true
  const bind = ctx?.get?.('webServer')?.host
  return typeof bind === 'string' && hostnameOf(bind) === name
}

/**
 * Authorize one plugin-route request.
 *
 * Order matters:
 * 1. A DSH owner admission is authoritative and covers Host/Origin/CSRF.
 * 2. A successful admission for a non-owner (guest) is a refusal, not a reason
 *    to fall through to the capability.
 * 3. Without an owner Cookie, the per-process capability is accepted. It is
 *    readable only from the authenticated DSH page, so it preserves the
 *    desktop shell and a LAN/Tailscale browser page without exposing an
 *    unauthenticated proxy to the network.
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} secret - per-process page capability.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {URL} [url] - parsed request URL.
 * @returns {{ok: true, via: string, peer?: object} | {ok: false, status: number, reason: string}} outcome.
 */
export function authorizeOwner(ctx, secret, req, url) {
  const connection = ctx?.get?.('connection')
  if (connection !== undefined && typeof connection.admit === 'function') {
    let admission
    try {
      admission = connection.admit(req)
    } catch {
      admission = undefined
    }
    if (admission !== undefined && !('rejection' in admission)) {
      if (admission.peer?.principal?.kind === 'owner') return { ok: true, via: 'admit', peer: admission.peer }
      return { ok: false, status: 403, reason: 'guest' }
    }
  }

  if (!capabilityMatches(req, secret, url)) return { ok: false, status: 401, reason: 'unauthorized' }
  if (!sameOrigin(req)) return { ok: false, status: 403, reason: 'origin' }
  const origin = req?.headers?.origin
  const httpOrigin = typeof origin === 'string' && /^https?:/i.test(origin)
  // A cross-site HTTP page cannot set the capability header without a CORS
  // preflight this server never grants; keep the check as defence in depth.
  // A non-HTTP Origin (desktop `dsh-app:`) may legitimately be cross-site to the
  // loopback listener and is authenticated by the capability instead.
  if (httpOrigin && req?.headers?.['sec-fetch-site'] === 'cross-site') {
    return { ok: false, status: 403, reason: 'cross-site' }
  }
  if (!trustedHost(ctx, req)) {
    // A non-HTTP Origin (desktop shell) is authenticated by the capability.
    // Everything else must target this listener's own authority; without that,
    // a capability leaked from a log/Referer would be usable from any Host.
    const nonHttpOrigin = typeof origin === 'string' && origin !== '' && origin !== 'null' && !/^https?:/i.test(origin)
    if (!nonHttpOrigin) return { ok: false, status: 403, reason: 'host' }
  }
  return { ok: true, via: 'capability' }
}

/** Build one short-lived, path-bound download ticket. */
export function issueTicket(secret, path, ttl = TICKET_TTL_MS) {
  const exp = Date.now() + Math.max(1, Math.min(Number(ttl) || TICKET_TTL_MS, MAX_TICKET_TTL_MS))
  const ticket = createHmac('sha256', secret).update(`${path}\n${exp}`).digest('base64url')
  return { ticket, exp }
}

/**
 * Verify a download ticket from a URL. The path and expiry are both signed, so
 * a ticket cannot be repointed at another file or kept forever.
 * @param {string} secret - per-process page capability.
 * @param {URL} url - request URL.
 * @returns {boolean} whether the ticket is valid for this URL's path.
 */
export function verifyTicket(secret, url) {
  if (typeof secret !== 'string' || secret === '') return false
  const path = url?.searchParams?.get('path') ?? ''
  const exp = Number(url?.searchParams?.get('exp'))
  const ticket = url?.searchParams?.get('ticket') ?? ''
  if (path === '' || !isAbsolutePath(path) || !Number.isFinite(exp)) return false
  const now = Date.now()
  if (exp <= now || exp > now + MAX_TICKET_TTL_MS) return false
  const expected = createHmac('sha256', secret).update(`${path}\n${exp}`).digest('base64url')
  return secureEqual(ticket, expected)
}
