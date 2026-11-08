/** Last configured bridge address, for messages produced outside the proxy closure. */
let configuredAddress = ''

/**
 * Plugin-owned transport between this Harness page and `dsh-remote-bridge`.
 *
 * The Host half exposes this object as `ctx.bridgeProxy`; the Client plugin
 * posts its Connection service on the marker routes below.
 *
 *   GET  <base>/transport   → JSON snapshot (setting, defaults, state)
 *   POST <base>/transport   → replace the setting or test a candidate
 *   POST <base>/api/<ns>/<m>→ one RPC for `<ns>/<m>` over the bridge protocol
 *   WS   <base>/api/remote.mux → RPC socket + the `$events` stream
 *
 * `dsh-remote-bridge` is a WebSocket data channel, not HTTP: it accepts text
 * frames `{id, type:'invoke'|'stream', namespace, method, args}` on `/bridge`
 * and answers `{kind:'result'|'stream-item'|'stream-end'}`. Almost every RPC
 * therefore travels as a bridge frame. Where the page's Connection carrier
 * needs a shape the bridge has no counterpart for (`$events`, byte
 * attachments), the plugin falls back to the bridge Host's own `/api` when that
 * Host serves it, and reports a readable error when it does not.
 *
 * The browser cannot attach a credential to a WebSocket, so the page's marker
 * socket sends `{"remote-control/hello": "<base>"}` as its first frame; the
 * plugin then opens the bridge socket with its own token and relays frames.
 * Status-only resources the bridge does not expose keep their last projection,
 * so a list view still renders.
 */
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { authorizeOwner, issueTicket, verifyTicket } from './lib/auth.js'
import { ByteQueue, frameSize } from './lib/frames.js'
import { isAbsolutePath } from './lib/paths.js'

/** Marker header the Client plugin sends so the router cannot proxy its own control calls. */
export const CLIENT_HEADER = 'x-dsh-remote-control'
/** First-frame key the Client sends over the marker socket to start the relay. */
export const HELLO_KEY = 'remote-control/hello'
/** Longest accepted address/credential so a paste mistake fails loudly. */
const MAX_ADDRESS_LENGTH = 512
const MAX_TOKEN_LENGTH = 512
const MAX_PORT = 65535
/** Largest per-socket write buffer before a slow peer is dropped. */
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024
/** Largest plain-JSON RPC result (non-attachment) this proxy will return. */
const MAX_JSON_RESULT_BYTES = 16 * 1024 * 1024
/** Largest total byte payload accepted for one unary result. */
const MAX_BYTE_RESULT_BYTES = 64 * 1024 * 1024

/**
 * Split `host[:port]` into a normalized bridge endpoint, defaulting to port 7400.
 * @param {unknown} raw - address typed by the user.
 * @returns {{ host: string, port: number, address: string }} normalized endpoint.
 * @throws {Error} when the address is empty or malformed.
 */
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') throw new Error('address must be a string')
  let text = raw.trim()
  if (text === '') throw new Error('address is empty')
  if (text.length > MAX_ADDRESS_LENGTH) throw new Error('address is too long')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url
    try {
      url = new URL(text)
    } catch {
      throw new Error('address is not a valid URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
      throw new Error('only plain http:// or ws:// addresses are supported')
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error('address must not carry a path, query, or fragment')
    }
    // `URL` drops an explicitly written default port (`http://host:80` → port
    // ''), while this endpoint's default is 7400. Read the authority's literal
    // port as a fallback so an explicit :80 is not silently retargeted.
    const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0]
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
    const literalPort = /:(\d+)$/.exec(hostPort)?.[1]
    const port = url.port !== '' ? url.port : literalPort
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    text = hostname.includes(':')
      ? `[${hostname}]${port === undefined ? '' : `:${port}`}`
      : `${hostname}${port === undefined ? '' : `:${port}`}`
  } else if (/[\s/?#]/.test(text)) {
    throw new Error('address must be host[:port] without a path, query, or whitespace')
  }
  return splitEndpoint(text)
}

/**
 * Split a bare `host[:port]` where host may be an IPv6 literal.
 * @param {string} text - endpoint text.
 * @returns {{ host: string, port: number, address: string }} normalized endpoint.
 */
function splitEndpoint(text) {
  let host
  let portText
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) throw new Error('unterminated IPv6 address')
    host = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) throw new Error('unexpected characters after the IPv6 address')
      portText = rest.slice(1)
    }
  } else if ((text.match(/:/g) ?? []).length > 1) {
    host = text
  } else {
    const colon = text.indexOf(':')
    host = colon < 0 ? text : text.slice(0, colon)
    portText = colon < 0 ? undefined : text.slice(colon + 1)
  }
  host = host.trim()
  if (host === '') throw new Error('address has no host')
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error('address host contains unsupported characters')
  let port = 7400
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) throw new Error('port must be a number')
    port = Number(portText)
    if (port < 1 || port > MAX_PORT) throw new Error('port must be between 1 and 65535')
  }
  const display = host.includes(':') ? `[${host}]` : host
  return { host, port, address: `${display}:${port}` }
}

/**
 * Coerce a loaded setting into the stored shape.
 * @param {unknown} value - loaded value.
 * @returns {{ enabled: boolean, address: string, token: string }} stored setting.
 */
function normalizeStored(value) {
  return {
    enabled: value?.enabled === true,
    address: typeof value?.address === 'string' ? value.address : '',
    token: typeof value?.token === 'string' ? value.token : '',
  }
}

/**
 * Normalize a bridge credential.
 * @param {unknown} raw - credential typed by the user.
 * @returns {string} the credential text.
 * @throws {Error} when the credential is empty, too long, or not header-safe.
 */
export function normalizeToken(raw) {
  if (typeof raw !== 'string') throw new Error('token must be a string')
  const token = raw.trim()
  if (token === '') throw new Error('token is empty')
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('token is too long')
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('token must be printable ASCII without spaces')
  return token
}

/**
 * Build the plugin-owned transport.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host context.
 * @param {{ clientMarker?: string, requestTimeoutMs?: number, initial?: { enabled: boolean, address: string, token: string }, persist?: (setting: { enabled: boolean, address: string, token: string }) => Promise<void> }} options - transport options.
 * @returns {object} the `bridgeProxy` service object.
 */
export function createBridgeProxy(ctx, options = {}) {
  const clientMarker = options.clientMarker ?? '/remote-control'
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  /** Per-process secret required on the page's marker WebSocket upgrade. */
  const socketSecret = typeof options.socketSecret === 'string' ? options.socketSecret : ''
  /** Owner/Cookie or per-process page capability for every plugin-route request. */
  const authorize = (req, url) => authorizeOwner(ctx, socketSecret, req, url)
  /** Connection's shared `/api` handler, read lazily once the service is live. */
  let shared
  /** User setting, replaced atomically so every relay reads one consistent triple. */
  // The plugin is off until the user turns it on: a saved `enabled: true` is
  // treated as off on load, and only an explicit save turns it back on.
  let stored = { ...normalizeStored(options.initial), enabled: false }
  configuredAddress = stored.address
  /** Persists a saved setting; a failure is reported but never rolls back a live switch. */
  const persist = options.persist

  const defaults = () => {
    const server = ctx.get('webServer')
    const host = server?.host ?? '127.0.0.1'
    const port = server?.port ?? 3080
    const protocol = server?.protocol === 'https:' ? 'https:' : 'http:'
    const loopback = port <= 0
    return {
      localUrl: loopback ? undefined : `${protocol}//${host.includes(':') ? `[${host}]` : host}:${port}`,
      launchToken: safeLaunchToken(ctx),
    }
  }

  const snapshot = () => {
    const base = defaults()
    // `launchToken` is a Host credential. It is used only by the private local
    // relay below; it must never appear in a response, even an authenticated one.
    const { launchToken: _launchToken, ...publicBase } = base
    return {
      ...publicBase,
      enabled: stored.enabled === true,
      address: stored.address ?? '',
      token: stored.token ?? '',
      state: resolveState(stored, base),
      // Set once the bridge stopped answering and this window fell back to the
      // local Host, so the card can say so instead of showing a silent half-failure.
      fallback: remoteUnavailable(),
    }
  }

  /**
   * Resolve the runtime state without mutating the stored setting.
   * @param {{ enabled: boolean, address: string, token: string }} setting - stored setting.
   * @param {{ localUrl?: string, launchToken?: string }} base - host defaults.
   * @returns {'off' | 'ready' | 'incomplete'} state.
   */
  function resolveState(setting, base) {
    if (setting.enabled !== true) return 'off'
    if (setting.address === '' || setting.token === '') return 'incomplete'
    return 'ready'
  }

  /**
   * Read the remote `/api` origin and headers for one request, or nothing when
   * the local Host must serve it.
   * @param {{ headers?: object, url?: string }} request - node request or Fetch request.
   * @returns {undefined | { target: string, headers: Record<string, string> }} relay description.
   */
  function clientRoute(request) {
    const header = readHeader(request?.headers, CLIENT_HEADER)
    if (header === undefined) return undefined
    const setting = stored
    if (setting.enabled !== true) return { target: '', headers: {} }
    if (setting.address === '' || setting.token === '') return { target: '', headers: {} }
    return { target: `http://${setting.address}`, headers: { 'x-dsh-remote-host': 'owner' } }
  }

  /**
   * Change the stored transport setting. This is the one mutation path for both
   * the card's `apply()` and the legacy `/transport` route, so changing the
   * target always closes the old shared socket and mirrors before the next
   * request, and persistence sees the same value.
   * @param {{ enabled: boolean, address: string, token: string }} next - target setting.
   * @returns {Promise<object>} the new snapshot.
   */
  async function applySetting(next) {
    const wasEnabled = stored.enabled === true
    const previousAddress = stored.address
    const previousToken = stored.token
    stored = {
      enabled: next?.enabled === true,
      address: typeof next?.address === 'string' ? next.address : '',
      token: typeof next?.token === 'string' ? next.token : '',
    }
    configuredAddress = stored.address
    if (stored.enabled === false || previousAddress !== stored.address || previousToken !== stored.token) {
      closeSharedRpc()
      bridgeFailures = 0
      lastFailureAt = 0
    }
    // A switch-off, or a move to a different machine, must also close the
    // mirrors already open for this page; otherwise events from the old Host
    // keep arriving even though the card says the transport is off.
    if (
      wasEnabled === false ||
      stored.enabled === false ||
      previousAddress !== stored.address ||
      previousToken !== stored.token
    ) {
      for (const stop of mirrorStops) {
        try { stop() } catch {}
      }
      mirrorStops.clear()
      for (const channel of [...streamChannels]) {
        try { channel.close('transport changed') } catch {}
      }
      deliveredWaterfalls.clear()
    }
    let warning
    if (persist !== undefined) {
      try {
        await persist(stored)
      } catch (error) {
        warning = `the setting is live but could not be saved: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const answer = { ok: true, ...(warning === undefined ? {} : { warning }), ...snapshot() }
    try {
      await options.onChange?.(answer)
    } catch (error) {
      traceLog(`switch side effect failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return answer
  }

  /**
   * Serve one control request (`GET`/`POST` <base>/transport).
   * @param {import('node:http').IncomingMessage} req - control request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {URL} url - request URL.
   */
  async function handleControl(req, res, url) {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { ok: true, ...snapshot() })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const action = body?.action
      if (action === 'test') {
        const address = normalizeAddress(body.address).address
        const token = normalizeToken(body.token)
        const check = await probeBridge(address, token, requestTimeoutMs)
        sendJson(res, 200, { ok: true, check, ...snapshot() })
        return
      }
      if (action === 'save') {
        const enabled = body.enabled === true
        const address = body.address === '' || body.address === undefined ? '' : normalizeAddress(body.address).address
        const token = body.token === '' || body.token === undefined ? '' : normalizeToken(body.token)
        if (enabled && (address === '' || token === '')) {
          sendJson(res, 400, { ok: false, error: 'fill in the address and token before enabling', ...snapshot() })
          return
        }
        const answer = await applySetting({ enabled, address, token })
        sendJson(res, 200, answer)
        return
      }
      sendJson(res, 400, { ok: false, error: 'unknown action' })
    } catch (error) {
      // A rejected action leaves the stored setting untouched; report it with
      // the current state so the page can tell the switch did not move.
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error), ...snapshot() })
    }
  }


  /**
   * Route one control or relay request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  async function handleRoute(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid URL' })
      return
    }
    const auth = authorize(req, url)
    if (auth.ok !== true) {
      sendJson(res, auth.status ?? 401, { ok: false, error: auth.reason ?? 'unauthorized' })
      return
    }
    const path = url.pathname
    if (path === clientMarker || path === `${clientMarker}/`) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const rest = path.slice(clientMarker.length)
    if (rest === '/transport' || rest === '/transport/') {
      await handleControl(req, res, url)
      return
    }
    if (!rest.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    await relayHttp(req, res, url)
  }

  /**
   * Answer one marker `/api` request: over the bridge protocol when the switch
   * is on, through this Host's own transport when it is off.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {URL} url - request URL.
   */
  /**
   * Consecutive bridge failures, reset by any success.
   *
   * A remote machine that is asleep or restarted would otherwise leave this window
   * stuck on a spinner forever: every call 502s, the page retries, and nothing tells
   * the operator that the local Harness is still usable. After the first failure the
   * proxy falls back to the local Host so the window keeps working; the next save of
   * the card turns remote mode back on.
   */
  let bridgeFailures = 0

  /**
   * Last reported failure, so a burst of rejected requests produces one notice.
   *
   * Every request in flight fails at once when a token is wrong or a link drops;
   * without this the page would stack a dozen identical toasts.
   */
  let lastFailureAt = 0
  const FAILURE_NOTICE_MS = 5000

  /**
   * Tell the page that the remote side is unusable, so it can warn and fall back.
   *
   * The notice travels on the page's own event stream, which is already open; the
   * client bundle listens for it and renders a Host-styled toast.
   * @param {string} kind - `auth`, `network`, `unreachable`, or `unknown`.
   * @param {string} message - the operator-facing sentence.
   */
  const reportRemoteFailure = (kind, message) => {
    const now = Date.now()
    if (now - lastFailureAt < FAILURE_NOTICE_MS) return
    lastFailureAt = now
    traceLog(`report failure kind=${kind} message=${message}`)
    for (const sink of failureSinks) {
      try {
        sink.__failure?.({ kind, message })
      } catch {}
    }
  }

  /**
   * Map a bridge error onto the reason the operator needs to know.
   * @param {object} error - the failure the bridge reported.
   * @returns {{ kind: string, message: string }} classification and wording.
   */
  const classifyBridgeFailure = (error) => {
    const text = String(error?.message ?? error ?? '')
    const status = error?.status
    // Only two distinctions are actionable for the operator: a wrong credential,
    // which they can fix, and a Host that is not serving the bridge, which they can
    // start. Everything else — a dropped link, a timeout, a Host that never answers
    // — is one situation from this window's side, so it gets one sentence.
    if (status === 401 || /rejected the token|401/.test(text)) {
      return { kind: 'auth', message: '访问凭据无效，已切回本机' }
    }
    if (/404|no bridge endpoint/.test(text)) {
      return { kind: 'unreachable', message: '远端未开启远程控制，已切回本机' }
    }
    return { kind: 'network', message: '无法连接远端，已切回本机' }
  }
  const BRIDGE_FALLBACK_AFTER = 1
  const remoteUnavailable = () => bridgeFailures >= BRIDGE_FALLBACK_AFTER

  /** Page event streams that receive transport-failure notices. */
  const failureSinks = new Set()
  /** Remote status mirrors, so turning the transport off can close them at once. */
  const mirrorStops = new Set()
  /** Shared per-page stream channels, so a transport change closes them too. */
  const streamChannels = new Set()
  /** Read by the card so the operator can see the window fell back. */
  const bridgeHealth = () => ({ fallback: remoteUnavailable(), failures: bridgeFailures })
  const noteBridgeFailure = () => { bridgeFailures += 1 }
  const noteBridgeSuccess = () => { if (bridgeFailures !== 0) bridgeFailures = 0 }

  async function relayHttp(req, res, url) {
    const route = clientRoute(req)
    const routePath = `/api/${url.pathname.slice(`${clientMarker}/api/`.length)}`
    if (route === undefined) {
      sendJson(res, 400, { ok: false, error: 'missing remote-control marker' })
      return
    }
    if (route.target === '') {
      relayLocal(req, res, routePath)
      return
    }
    // Raw-byte routes are HTTP endpoints on the other machine, not RPC methods: the
    // RPC dispatcher below would name them `session/uploadFileBinary`, which the
    // bridge has no handler for, and the upload came back 404.
    if (RAW_BYTE_ROUTES.has(routePath.split('?')[0])) {
      // The bridge listener only serves the authenticated WebSocket: every HTTP
      // path answers 404. Forwarding the upload there produced a confusing 404;
      // say plainly that this bridge has no binary upload endpoint.
      sendJson(res, 501, {
        ok: false,
        error: 'remote-control: file upload is not supported by this bridge; upload from the controlled machine',
      })
      return
    }
    // No silent fallback here. Every request still goes to the bridge, so a failure
    // is observed and reported once; the page then shows the reason and returns to
    // the local Host on its own. Answering locally behind the operator's back hid
    // *why* the window changed.
    if (routePath.startsWith('/api/settings/')) {
      let peeked
      try {
        peeked = await peekSettingsArgs(req)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (isLocalPreference('settings', peeked)) {
        relayLocal(req, res, routePath)
        return
      }
    }
    await remoteApi(req, res, routePath)
  }

  /**
   * Forward one raw-byte HTTP route to the other machine.
   *
   * The body is streamed both ways, so a large upload never sits in this process's
   * memory and progress reporting on the page stays meaningful.
   * @param {import('node:http').IncomingMessage} req - the page's request.
   * @param {import('node:http').ServerResponse} res - response back to the page.
   * @param {string} routePath - path beginning with `/api/`.
   * @param {string} target - `http://host:port` of the other machine.
   */
  async function relayRemoteHttp(req, res, routePath, target) {
    const url = new URL(routePath, target)
    const headers = { ...stringHeaders(req.headers) }
    // The other machine authenticates the peer by its bridge token; the page's own
    // cookie belongs to this Host and must not be forwarded.
    delete headers.cookie
    delete headers.host
    headers.authorization = `Bearer ${stored.token}`
    let upstream
    try {
      const mod = await import('node:http')
      upstream = await new Promise((resolve, reject) => {
        const request = mod.request(url, { method: req.method ?? 'POST', headers }, resolve)
        request.on('error', reject)
        // `duplex: 'half'` semantics: pipe the page's body straight through.
        req.pipe(request)
      })
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: `remote-control: cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const out = {}
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue
      if (name === 'transfer-encoding' || name === 'connection') continue
      out[name] = Array.isArray(value) ? value.join(', ') : value
    }
    res.writeHead(upstream.statusCode ?? 502, out)
    upstream.pipe(res)
    upstream.on('error', () => {
      try { res.destroy() } catch {}
    })
  }

  /**
   * Execute one `/api/<ns>/<method>` RPC against the bridge.
   *
   * A Connection request carries `{type:'client-request', rpcId, method,
   * payload:{args}}`; the bridge speaks `{id, type:'invoke', namespace,
   * method, args}`. The bridge's RPC result is a business value, so the answer
   * is wrapped back into the Connection envelope the page parses.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {string} routePath - `/api/<method>` path.
   */
  /**
   * Serve one file from the other machine to this window.
   *
   * Mirrors the Host's own `/api/file` contract (`?path=<absolute>` → raw bytes) so
   * the document preview and a plain download both work unchanged. Returns the
   * request to the local Host when remote mode is off, which is what keeps the
   * switch honest: with the bridge disabled this route must not answer at all.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  async function handleFileRoute(req, res) {
    if (!stored.enabled || stored.address === '' || stored.token === '') {
      // Remote off: the Host's own route owns this path, so never answer here.
      sendJson(res, 404, { ok: false, error: 'remote file access is off' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.searchParams.get('path') ?? ''
    if (path === '' || !isAbsolutePath(path)) {
      sendJson(res, 400, { ok: false, error: 'an absolute path is required' })
      return
    }
    let upstream
    try {
      upstream = await connectBridge()
    } catch (error) {
      sendJson(res, 502, { ok: false, error: `cannot reach the bridge: ${String(error)}` })
      return
    }
    // A download is the same transfer with a different disposition; the panel asks
    // for a preview, the toolbar's button asks to keep the file.
    const download = url.searchParams.get('download') === '1'
    try {
      const first = await fileChunk(upstream, path, 0)
      if (first.ok !== true) {
        // A browser navigation cannot render a JSON body, and saving one is worse:
        // Chrome offered the failure as `download.json`. Plain text at least shows
        // the reason in the tab the navigation landed in.
        const reason = String(first.message ?? 'the bridge refused the read')
        traceLog(`file route failed for ${path}: ${reason}`)
        if (res.headersSent) { res.end(); return }
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`remote-control: ${reason}`)
        return
      }
      const total = typeof first.value?.bytes === 'number' ? first.value.bytes : undefined
      const headers = {
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        // Preview renders documents; a download saves them. Both stay sandboxed so a
        // hostile file cannot script the page.
        'content-security-policy': "sandbox; default-src 'none'",
        'content-type': download ? 'application/octet-stream' : guessType(path),
        ...(total === undefined ? {} : { 'content-length': String(total) }),
        ...(download ? { 'content-disposition': attachmentDisposition(basenameOf(path)) } : {}),
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      // Stream chunk by chunk: a 6 MB archive never has to exist in memory twice.
      let offset = 0
      let chunk = first
      let failure
      while (true) {
        if (chunk.ok !== true) {
          failure = chunk
          break
        }
        const bytes = Buffer.from(chunk.value?.data ?? '', 'base64')
        if (bytes.length > 0 && !res.write(bytes)) {
          if (res.destroyed) break
          await waitForDrain(res, req)
        }
        if (chunk.value?.eof === true) break
        offset += bytes.length
        chunk = await fileChunk(upstream, path, offset)
      }
      if (failure !== undefined) {
        // `content-length` was already promised. Ending cleanly would make the
        // browser treat a truncated file as complete; destroy the response so the
        // transfer is visibly failed instead.
        try { res.destroy(new Error(String(failure.message ?? 'the remote read failed'))) } catch {}
        return
      }
      res.end()
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error) })
      else try { res.destroy(error) } catch {}
    } finally {
      try { upstream.close() } catch {}
    }
  }

  /**
   * Ask the other machine for one file chunk.
   *
   * A dedicated frame keeps this off the typed RPC surface: `workspaceFiles/readBytes`
   * would return the whole file in one JSON value, which is what broke large reads.
   * @param {import('node:net').Socket} upstream - connected bridge socket.
   * @param {string} path - absolute path on the other machine.
   * @param {number} offset - byte offset to start at.
   * @returns {Promise<{ok: boolean, value?: object, message?: string}>} the chunk.
   */
  function fileChunk(upstream, path, offset) {
    // Same request/response machinery the RPC path uses, so both share one
    // implementation of timeout, frame matching, and error reporting.
    return rpcOnConnection(upstream, {
      type: 'file-read',
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      offset,
    })
  }


  /**
   * Save one file from the other machine onto this computer.
   *
   * Wraps {@link handleFileRoute} so the button and the preview share one transfer:
   * only the disposition differs. Refused when remote mode is off, which is what
   * guarantees no stale download affordance can outlive the switch.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  let routesTraced = false

  /**
   * Record the routes this build serves, once.
   *
   * A 404 from the browser cannot tell a missing route from a missing installation;
   * this line distinguishes the two.
   * @returns {never[]} nothing — the caller spreads it to stay a no-op.
   */
  function traceRoutesOnce() {
    if (routesTraced) return []
    routesTraced = true
    traceLog('routes: can-read, download, api/*, transport, mux upgrade')
    return []
  }

  /**
   * Report which machine owns the files a delivery card lists.
   *
   * `available: false` is the honest answer in remote mode and the one the page
   * renders as a plain "not available here" note. Claiming `true` would make it draw
   * its open-with menu, whose only real effect is launching an application on the
   * other machine — invisible from this window.
   *
   * The shape must satisfy the page's `isPresentedHost`: a string `name`, a boolean
   * `available`, and a `fileManager` of null, "finder", "explorer", or "directory".
   * Anything else leaves the card showing "could not read the host desktop".
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  function handlePresentHostRoute(req, res) {
    if (!stored.enabled || stored.address === '' || stored.token === '') {
      sendJson(res, 404, { ok: false, error: 'remote mode is off' })
      return
    }
    sendJson(res, 200, { name: stored.address, available: false, fileManager: null })
  }

  /**
   * Issue one short-lived, path-bound download ticket for an authenticated page.
   * A browser navigation cannot attach the capability header, so the download
   * URL carries this ticket instead of the per-process secret.
   * @param {import('node:http').IncomingMessage} req - authenticated request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {URL} url - request URL.
   */
  async function handleTicketRoute(req, res, url) {
    const auth = authorize(req, url)
    if (auth.ok !== true) {
      sendJson(res, auth.status ?? 401, { ok: false, error: auth.reason ?? 'unauthorized' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const path = typeof body?.path === 'string' ? body.path : ''
    if (path === '' || !isAbsolutePath(path)) {
      sendJson(res, 400, { ok: false, error: 'an absolute path is required' })
      return
    }
    if (socketSecret === '') {
      sendJson(res, 503, { ok: false, error: 'download tickets are unavailable' })
      return
    }
    const { ticket, exp } = issueTicket(socketSecret, path)
    sendJson(res, 200, { ok: true, ticket, exp })
  }

  async function handleDownloadRoute(req, res) {
    if (!stored.enabled || stored.address === '' || stored.token === '') {
      sendJson(res, 404, { ok: false, error: 'remote mode is off' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    url.searchParams.set('download', '1')
    req.url = `${url.pathname}?${url.searchParams.toString()}`
    await handleFileRoute(req, res)
  }

  /**
   * Byte budget for one `readBytes` round trip.
   *
   * One MiB keeps a chunk well inside the 30 s request timeout even on a
   * 300–500 ms / ~1 Mbps Tailscale path, while a 6.7 MB file needs only seven
   * round trips instead of 26.
   */
  const READ_BYTES_CHUNK = 1024 * 1024
  /** Line budget for one `read` round trip, for the same reason. */
  const READ_TEXT_CHUNK_LINES = 4000
  /** Total text budget for one assembled `read` response. */
  const MAX_TEXT_READ_BYTES = 8 * 1024 * 1024


  /**
   * Diagnostic trail for the readBytes chunker.
   *
   * One browser HTTP request expands into several internal bridge frames; the
   * DevTools Network tab cannot show that split. This small, append-only file
   * records the offsets and count so an operator can prove whether the plugin
   * actually paged the file. It is deliberately separate from the frame trace:
   * only readBytes writes it, so it stays bounded by the number of file reads.
   * @param {string} message - one diagnostic line.
   */
  function readBytesLog(message) {
    if (!TRACE_ENABLED) return
    try {
      const fs = process.getBuiltinModule?.('node:fs')
      const os = process.getBuiltinModule?.('node:os')
      const path = process.getBuiltinModule?.('node:path')
      if (fs === undefined || os === undefined || path === undefined) return
      const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
      const line = `${new Date().toISOString()} ${message}\n`
      fs.appendFileSync(path.join(home, 'remote-control-readbytes.log'), line, { mode: 0o600 })
    } catch {}
  }

  /**
   * Read a file's bytes in ranges instead of one oversized request.
   *
   * A single 6 MB `readBytes` had to finish inside the request timeout, which a
   * satellite-grade link could not do; each 1 MiB range is its own request, so
   * progress never depends on total file size. There is deliberately no direct
   * read threshold: a 6.7 MB PDF is seven 1 MiB ranges (about 11 s per range at
   * 0.7 Mbps) instead of one request that may hit the 30 s timeout. The page still
   * receives one complete array.
   * @param {object} args - the page's original arguments.
   * @param {string} id - request id prefix for the per-chunk calls.
   * @returns {Promise<object>} a bridge-style reply with the assembled value.
   */
  const readBytesInRanges = async (args, id) => {
    // One socket for the whole transfer: every range is another request on the same
    // connection, so a 6 MB read costs one handshake instead of one per chunk.
    let upstream
    try {
      upstream = await connectBridge()
    } catch (error) {
      return { kind: 'error', code: 'remote-control/unreachable', message: `cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      return await readBytesOver(upstream, args, id)
    } finally {
      try { upstream.terminate() } catch {}
    }
  }

  const readBytesOver = async (upstream, args, id) => {
    const started = Date.now()
    let chunkCount = 0
    readBytesLog(`start id=${id} path=${JSON.stringify(String(args?.path ?? ''))} range=${JSON.stringify(args?.options?.range ?? null)}`)
    const call = (range, tag) => rpcOnConnection(upstream, {
      id: `${id}-${tag}`, type: 'invoke', namespace: 'workspaceFiles', method: 'readBytes',
      args: adapterArgs('workspaceFiles', 'readBytes', { ...args, options: { ...(args.options ?? {}), range } }),
    })
    const first = await call({ offset: 0, length: READ_BYTES_CHUNK }, '0')
    chunkCount += 1
    readBytesLog(`first id=${id} ok=${first.ok === true} total=${typeof first.value?.bytes === 'number' ? first.value.bytes : 'unknown'} eof=${first.value?.eof === true} length=${first.value?.data?.length ?? 0}`)
    if (first.ok !== true) return first
    const total = typeof first.value?.bytes === 'number' ? first.value.bytes : undefined
    if (total !== undefined && total > 64 * 1024 * 1024) {
      return { kind: 'result', ok: false, code: 'remote-control/too-large', message: 'the file is too large for an RPC response' }
    }
    const head = first.value?.data instanceof Uint8Array ? first.value.data : new Uint8Array(0)
    // Unknown size or a single-chunk file: the first answer is the whole answer.
    if (total === undefined || first.value?.eof === true) {
      readBytesLog(`done id=${id} chunks=${chunkCount} bytes=${first.value?.data?.length ?? 0} ms=${Date.now() - started}`)
      return first
    }
    const parts = [head]
    let offset = head.length
    let guard = 0
    while (offset < total) {
      guard += 1
      // A file that keeps reporting more data than it has would loop forever.
      if (guard > 4096) return { kind: 'result', ok: false, code: 'remote-control/too-large', message: 'the file did not end within the expected number of reads' }
      const next = await call({ offset, length: READ_BYTES_CHUNK }, String(guard))
      chunkCount += 1
      readBytesLog(`chunk id=${id} n=${chunkCount} offset=${offset} ok=${next.ok === true} bytes=${next.value?.data?.length ?? 0} eof=${next.value?.eof === true}`)
      if (next.ok !== true) return next
      const piece = next.value?.data instanceof Uint8Array ? next.value.data : new Uint8Array(0)
      if (piece.length === 0) break
      parts.push(piece)
      offset += piece.length
      if (next.value?.eof === true) break
    }
    const data = new Uint8Array(offset)
    let at = 0
    for (const part of parts) { data.set(part, at); at += part.length }
    readBytesLog(`done id=${id} chunks=${chunkCount} bytes=${data.length} ms=${Date.now() - started}`)
    return { ...first, value: { ...first.value, data, offset: 0, eof: true } }
  }

  /**
   * Read a text file in line windows instead of one oversized response.
   *
   * `read` returns whole lines, so the chunks are counted in lines; the caller joins
   * them back into the single string it expects.
   * @param {object} args - the page's original arguments.
   * @param {string} id - request id prefix for the per-chunk calls.
   * @returns {Promise<object>} a bridge-style reply with the joined text.
   */
  const readTextInWindows = async (args, id) => {
    let upstream
    try {
      upstream = await connectBridge()
    } catch (error) {
      return { kind: 'error', code: 'remote-control/unreachable', message: `cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      return await readTextOver(upstream, args, id)
    } finally {
      try { upstream.terminate() } catch {}
    }
  }

  const readTextOver = async (upstream, args, id) => {
    const base = args.range ?? {}
    const startLine = Number.isInteger(base.offset) ? base.offset : 0
    const limit = Number.isInteger(base.limit) && base.limit > 0 ? base.limit : undefined
    const call = (range, tag) => rpcOnConnection(upstream, {
      id: `${id}-${tag}`, type: 'invoke', namespace: 'workspaceFiles', method: 'read',
      args: adapterArgs('workspaceFiles', 'read', { ...args, range }),
    })
    const first = await call({ offset: startLine, limit: READ_TEXT_CHUNK_LINES }, '0')
    if (first.ok !== true) return first
    const texts = [String(first.value?.text ?? '')]
    let bytes = Buffer.byteLength(texts[0])
    // The Host reports the total size on the first page. Refuse an obviously
    // oversized text file before paging through it; the per-chunk accumulator
    // below covers a Host that omits or under-reports this field.
    const totalBytes = Number(first.value?.bytes)
    // A bounded page (offset/limit) may be small even when the file is huge;
    // only reject the whole file when the caller wants the complete text.
    if (bytes > MAX_TEXT_READ_BYTES || (limit === undefined && Number.isFinite(totalBytes) && totalBytes > MAX_TEXT_READ_BYTES)) {
      return { kind: 'result', ok: false, code: 'remote-control/too-large', message: 'the text file is too large for an RPC response' }
    }
    if (first.value?.eof === true) return first
    let read = typeof first.value?.lines === 'number' ? first.value.lines : 0
    let guard = 0
    while (true) {
      // The caller asked for a bounded window, and it is now satisfied.
      if (limit !== undefined && read >= limit) break
      guard += 1
      if (guard > 4096) return { kind: 'result', ok: false, code: 'remote-control/too-large', message: 'the file did not end within the expected number of reads' }
      const want = limit === undefined ? READ_TEXT_CHUNK_LINES : Math.min(READ_TEXT_CHUNK_LINES, limit - read)
      if (want <= 0) break
      const next = await call({ offset: startLine + read, limit: want }, String(guard))
      if (next.ok !== true) return next
      const piece = String(next.value?.text ?? '')
      if (piece === '') break
      bytes += Buffer.byteLength(piece)
      if (bytes > MAX_TEXT_READ_BYTES) {
        return { kind: 'result', ok: false, code: 'remote-control/too-large', message: 'the text file is too large for an RPC response' }
      }
      texts.push(piece)
      read += typeof next.value?.lines === 'number' ? next.value.lines : 0
      if (next.value?.eof === true) break
    }
    return { ...first, value: { ...first.value, text: texts.join(''), lines: read, offset: startLine, eof: true } }
  }

  /**
   * Whether a read should be split.
   *
   * The caller's own range/limit is respected: when it already asked for a bounded
   * window there is nothing to split, and re-splitting would change its answer.
   * @param {string} method - `readBytes` or `read`.
   * @param {object} args - the page's arguments.
   * @returns {boolean} true when the plugin should page the read itself.
   */
  function wantsRangedRead(method, args) {
    // DSH serializes the default `{}` options as `range: {}`. An empty range is
    // "no window", not "the caller chose a window"; treating it as the latter
    // silently disabled all plugin chunking for complete-file reads (PDFs were
    // one 6.7 MB request instead of seven 1 MiB ranges).
    const unbounded = (range, lengthKey) => {
      if (range === undefined || range === null) return true
      if (typeof range !== 'object' || Array.isArray(range)) return false
      if (Object.keys(range).length === 0) return true
      if (range.offset !== undefined && !(Number.isInteger(range.offset) && range.offset === 0)) return false
      return range[lengthKey] === undefined
    }
    if (method === 'readBytes') return unbounded(args?.options?.range, 'length')
    return unbounded(args?.range, 'limit')
  }

  async function remoteApi(req, res, routePath) {
    const endpoint = routePath.slice('/api/'.length)
    const [namespace, method, ...extra] = endpoint.split('/')
    if (method === undefined || extra.length > 0) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let envelope
    try {
      envelope = body === undefined || body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'request body is not JSON' })
      return
    }
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : `remote-control-${Date.now()}`
    const args = envelope?.payload?.args ?? {}
    // Never use the page's correlation id as the bridge request id. The page
    // id is untrusted and may be arbitrarily long, duplicated, or empty; using
    // it directly made two concurrent requests collide and let one over-long id
    // turn into a bridge-level bad-request for unrelated calls.
    const id = `remote-control/${randomUUID()}`
    // `maxMessages` and friends are endpoint arguments, not frame fields; only
    // documented frame-level switches are forwarded beside `args`.
    const extras = {}
    for (const key of FRAME_FIELDS) {
      if (envelope?.payload !== null && typeof envelope?.payload === 'object' && envelope.payload[key] !== undefined) extras[key] = envelope.payload[key]
    }
    // The file card's open-with menu is not offered in remote mode. The plugin
    // adds its own right-sidebar download control; answering false here keeps
    // DSH's native open-with from reappearing and launching an application on the
    // controlled machine.
    if (namespace === 'session' && method === 'canOpenWorkspacePath') {
      traceLog('intercept canOpenWorkspacePath -> false')
      noteBridgeSuccess()
      await sendRpcResult(res, rpcId, { ok: true, value: false })
      return
    }
    // Defense in depth: if a DSH version still calls this despite the false above,
    // never forward it to the controlled machine (that would open a file there).
    if (namespace === 'session' && method === 'openWorkspacePath') {
      noteBridgeSuccess()
      await sendRpcResult(res, rpcId, {
        ok: false,
        error: { code: 'remote-control/open-not-supported', message: 'opening files on the controlled machine is not supported in remote mode', details: {} },
      })
      return
    }
    // Large reads are split here so no single request has to finish inside the
    // timeout. Small files take the first branch and pay nothing extra.
    // `DSH_REMOTE_CONTROL_NO_CHUNK` disables paging. It exists so a test can run the
    // same request both ways and compare the two answers byte for byte.
    const ranged = namespace === 'workspaceFiles'
      && (method === 'readBytes' || method === 'read')
      && wantsRangedRead(method, args)
      && process.env.DSH_REMOTE_CONTROL_NO_CHUNK !== '1'
    let reply
    try {
      reply = ranged
        ? (method === 'readBytes' ? await readBytesInRanges(args, id) : await readTextInWindows(args, id))
        : await bridgeRpc(namespace, method, args, id, extras)
      noteBridgeSuccess()
    } catch (error) {
      noteBridgeFailure()
      traceLog(`bridge failure ${bridgeFailures}: ${String(error)}`)
      sendJson(res, 502, {
        ok: false,
        error: `remote-control: cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    if (reply.kind === 'result') {
      // DSH's document preview only exposes its header/unpreviewable action slots
      // when the file resource carries `absolutePath`. Some bridge/Host versions
      // return a stat/read without it for binary files, which made a remote tar.gz
      // show neither the header download icon nor the middle download button.
      // The request path is already the absolute Host path in that case, so fill
      // the field instead of leaving the file owner unknown.
      if (
        reply.ok === true &&
        namespace === 'workspaceFiles' &&
        (method === 'stat' || method === 'read' || method === 'readBytes') &&
        reply.value !== null &&
        typeof reply.value === 'object' &&
        typeof reply.value.absolutePath !== 'string'
      ) {
        const requestedPath = typeof args?.path === 'string'
          ? args.path
          : typeof args?.request?.path === 'string'
            ? args.request.path
            : ''
        if (requestedPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requestedPath)) {
          reply = { ...reply, value: { ...reply.value, absolutePath: requestedPath } }
        }
      }
      const result = reply.ok === true ? { ok: true, value: reply.value } : { ok: false, error: bridgeError(reply) }
      // Diagnostic: a failing relay is the usual cause of a control that flashes and
      // vanishes (the page swallows the rejection), so record every failure by name.
      if (result.ok !== true) {
        traceLog(`relay failed ${namespace}/${method}: ${result.error.code} ${result.error.message}`)
      }
      // A byte-carrying result cannot travel as plain JSON: the page's descriptor
      // rejects anything under `data` that is not a byte array, which is exactly what
      // `JSON.stringify` turns `Uint8Array` into. Send it the way the Host does —
      // multipart, with the JSON metadata and the bytes in separate parts.
      await sendRpcResult(res, rpcId, result)
      return
    }
    // A transport-level failure (`kind: 'error'`) means the remote side is gone, and
    // the operator deserves a sentence explaining why the window changed. A business
    // failure keeps its own code and is not a transport problem.
    if (reply.kind === 'error') {
      const classified = classifyBridgeFailure(reply)
      noteBridgeFailure()
      reportRemoteFailure(classified.kind, classified.message)
    }
    // An unwrapped `$events` request (the page's always-on event stream) has no
    // bridge counterpart in this Host's Gateway; say so in one sentence.
    const code = reply.code ?? `bridge/${reply.kind ?? 'unknown'}`
    const failure = reply.kind === 'error' ? classifyBridgeFailure(reply) : undefined
    const failBody = JSON.stringify({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code,
          message:
            reply.message ??
            `remote-control: the bridge Host does not serve ${endpoint} over HTTP; ` +
              'the always-on event stream only exists on a Host whose /api is reachable. ' +
              'Session content still loads through the bridge protocol.',
          details: {},
        },
      },
    })
    if (res.headersSent) {
      res.end()
      return
    }
    // A transport failure is announced on the failing response itself. The event
    // stream cannot carry this news: it is the first thing to die when the remote
    // Host stops answering, so relying on it meant a dead link failed silently.
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(failBody),
      ...(failure === undefined
        ? {}
        : {
            'x-remote-control-failure': failure.kind,
            'x-remote-control-message': encodeURIComponent(failure.message),
          }),
    })
    res.end(failBody)
  }

  /**
   * Serve one marker `/api` request in this process through the Host
   * Connection transport, whose own admission (session cookie, Host/Origin
   * fence, Peer) authenticates the caller exactly as on `/api`.
   *
   * This is not a loop back to `/api`: the plugin never re-sends the request,
   * so there is no second Host check and no dependency on the API's trust
   * fence. When Connection's shared handler is unavailable the request falls
   * back to a loopback HTTP hop carrying this process's launch credential.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {string} routePath - `/api/...` path the bridge routes expect.
   */
  function relayLocal(req, res, routePath) {
    const connection = ctx.get('connection')
    const shared = localShared(connection)
    if (shared !== undefined) {
      relayLocalShared(req, res, routePath, connection, shared)
      return
    }
    void relayLocalLoopback(req, res, routePath)
  }

  /**
   * Dispatch one request to Connection's shared Fetch handler.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {string} routePath - `/api/...` path.
   * @param {object} connection - Host Connection service.
   * @param {object} shared - `createSharedFetchHandler('/api')` result.
   */
  async function relayLocalShared(req, res, routePath, connection, shared) {
    const admission = connection.admit(req)
    if ('rejection' in admission) {
      // A desktop page may have the page capability but no DSH browser Cookie.
      // Its local-mode requests still need the Host's own API; the loopback hop
      // carries this process's launch credential.
      if (admission.rejection === 401) {
        void relayLocalLoopback(req, res, routePath)
        return
      }
      res.writeHead(admission.rejection)
      res.end('forbidden')
      return
    }
    const base = defaults()
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') continue
      headers.set(lower, Array.isArray(value) ? value.join(', ') : String(value))
    }
    let body
    try {
      body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `cannot read the request body: ${String(error)}` })
      return
    }
    let response
    try {
      response = await shared.fetch(new Request(`${base.localUrl ?? 'http://127.0.0.1'}${routePath}`, {
        method: req.method ?? 'GET',
        headers,
        body,
      }), admission.peer)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `the local Host failed to answer: ${String(error)}` })
      return
    }
    try {
      await pipeResponse(res, response)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `the local Host response could not be relayed: ${String(error)}` })
    }
  }

  /**
   * Last-resort local relay: one loopback HTTP request carrying this process's
   * launch credential, used only when Connection's shared handler is absent.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {string} routePath - `/api/...` path.
   */
  async function relayLocalLoopback(req, res, routePath) {
    const base = defaults()
    if (base.localUrl === undefined) {
      sendJson(res, 503, { ok: false, error: 'the local web server address is unknown' })
      return
    }
    const target = new URL(`${base.localUrl}${routePath}`)
    const headers = { ...stringHeaders(req.headers), host: target.host, authorization: `Bearer ${base.launchToken ?? ''}` }
    for (const hop of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']) delete headers[hop]
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
    try {
      const response = await fetch(target, { method: req.method ?? 'GET', headers, body, redirect: 'manual' })
      await pipeResponse(res, response)
    } catch (error) {
      sendJson(res, 502, { ok: false, error: `remote-control: cannot reach this Host: ${String(error)}` })
    }
  }

  /**
   * Resolve a usable shared Fetch handler from the Host Connection service.
   * @param {object | undefined} connection - Host Connection service.
   * @returns {object | undefined} the handler when the service is live.
   */
  function localShared(connection) {
    if (connection === undefined || typeof connection?.createSharedFetchHandler !== 'function' || typeof connection?.admit !== 'function') return undefined
    if (shared !== undefined) return shared
    try {
      shared = connection.createSharedFetchHandler('/api')
      return shared
    } catch {
      return undefined
    }
  }

  /**
   * Accept one marker API socket and relay it through the bridge protocol.
   *
   * The page's Gateway multiplexes logical streams on this socket: `open`
   * starts a stream (its `$events` is the always-on event source), `item` and
   * `end` are its uplink, and `cancel` stops it. The bridge speaks plain
   * request/response frames, so this router owns the mapping in both
   * directions: `open` → bridge `stream` frame, `stream-item` → `item`,
   * `stream-end` → `end`, `cancel` → `stream-cancel`. An `open` for a stream
   * the bridge cannot serve is answered with its failure instead of silence.
   * @param {import('node:http').IncomingMessage} req - upgrade request.
   * @param {import('node:stream').Duplex} socket - client socket.
   * @param {Buffer} head - bytes already read from the client.
   */
  async function handleUpgrade(req, socket, head) {
    const marker = readHeader(req.headers, CLIENT_HEADER)
    const target = new URL(req.url ?? '/', 'http://localhost')
    // A browser socket cannot send the marker header; this exact route identifies
    // it, so an absent header is accepted here and nowhere else.
    const marked = (marker !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(String(marker))) || target.pathname === `${clientMarker}/api/remote.mux`
    if (!marked) {
      writeUpgradeFailure(socket, 400, 'Bad Request')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || key === '') {
      writeUpgradeFailure(socket, 400, 'Bad Request')
      return
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      writeUpgradeFailure(socket, 426, 'Upgrade Required')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = url.searchParams
    // The page hook appends a per-process secret to the mux URL. A cross-origin
    // page cannot read the injected HTML, so it cannot open this socket even
    // though a browser can connect to 127.0.0.1. This replaces the old
    // path-only check, which accepted any origin.
    if (socketSecret === '' || query.get('rc') !== socketSecret) {
      writeUpgradeFailure(socket, 403, 'Forbidden')
      return
    }
    const subprotocol = typeof req.headers['sec-websocket-protocol'] === 'string'
      ? req.headers['sec-websocket-protocol'].split(',').map((entry) => entry.trim()).find((entry) => /^[A-Za-z0-9._-]+$/.test(entry))
      : undefined
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        (subprotocol === undefined ? '' : `Sec-WebSocket-Protocol: ${subprotocol}\r\n`) +
        '\r\n',
    )
    socket.setNoDelay(true)
    const frames = textFrames(socket)
    let greeted = false
    let closing = false
    /** Logical stream id → bridge stream bookkeeping. */
    const streams = new Map()
    const write = (text) => {
      if (closing || !socket.writable) return
      if (socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
        close(1013, 'peer is too slow')
        return
      }
      socket.write(encodeServerText(text))
    }
    const close = (code, reason) => {
      if (closing) return
      closing = true
      for (const entry of streams.values()) entry.stop?.()
      streams.clear()
      try { socketScope.channel?.close('page socket closed') } catch {}
      try {
        if (socket.writable) {
          socket.end(closeFrame(code, reason))
          socket.destroySoon?.()
        } else {
          socket.destroy()
        }
      } catch {
        socket.destroy()
      }
    }
    /** What the stream helpers need from this socket. */
    const socketScope = { streams, write, close, cookie: req.headers.cookie ?? '' }
    socketScope.channel = createStreamChannel(socketScope)
    frames.on('error', () => close(1000, ''))
    frames.on('end', () => close(1000, ''))
    frames.on('close', (code, reason) => close(code, reason))
    frames.on('text', (text) => {
      let frame
      try {
        frame = JSON.parse(text)
      } catch {
        write(JSON.stringify({ type: 'error', streamId: '', error: { code: 'remote-control/bad-frame', message: 'frame is not JSON', details: {} } }))
        return
      }
      // The page's own Gateway socket speaks the mux protocol directly; only an
      // explicit hello (a non-browser client) asks for the greeting frame.
      if (!greeted) {
        greeted = true
        if (typeof frame?.[HELLO_KEY] === 'string') {
          write(JSON.stringify({ [HELLO_KEY]: stored.enabled === true && stored.token !== '' ? 'bridge' : 'local' }))
          // A unary socket carries its RPC in the query instead of a hello frame.
          if (query.has('endpoint')) void unary(socketScope, query.get('endpoint'))
          return
        }
      }
      switch (frame?.type) {
        case 'open':
          void openStream(socketScope, frame)
          return
        case 'cancel': {
          const entry = streams.get(frame.target)
          if (entry !== undefined) {
            entry.stop?.()
            streams.delete(frame.target)
            try { socketScope.channel?.forget(frame.target) } catch {}
            write(JSON.stringify({ type: 'end', id: frame.target }))
          }
          return
        }
        case 'item':
        case 'end':
          // Uplinks exist only for streams the bridge forwards to a Client; no
          // endpoint in scope declares one.
          return
        default:
          return
      }
    })
    if (head.length > 0) frames.push(head)

  }

  /**
   * Serve one unary RPC requested on the socket's query string.
   * @param {string} endpoint - `<ns>/<method>`.
   */
  async function unary(onSocket, endpoint) {
    const { write, close } = onSocket
    const [namespace, method] = endpoint.split('/')
    let reply
    try {
      reply = await bridgeRpc(namespace, method, {}, `remote-control/${Date.now()}`)
    } catch (error) {
      write(JSON.stringify({ type: 'error', streamId: '', error: { code: 'remote-control/unreachable', message: String(error instanceof Error ? error.message : error), details: {} } }))
      close(1011, 'bridge unreachable')
      return
    }
    write(JSON.stringify(reply.kind === 'result' ? reply : { type: 'error', streamId: '', error: { code: reply.code ?? 'remote-control/unsupported', message: reply.message ?? 'unsupported endpoint', details: {} } }))
    close(1000, '')
  }

  /**
   * One logical bridge WebSocket shared by every remote stream of a page.
   *
   * The bridge protocol already multiplexes streams by `id`; opening a new
   * socket per stream paid a handshake per channel and made every close path
   * duplicate. The channel owns the socket, keepalive, idle close, and frame
   * demultiplexing; each entry in `onSocket.streams` stays the page-facing handle.
   * @param {{streams: Map<string, object>, write: Function}} onSocket - page mux scope.
   * @returns {object} channel with open/cancel/forget/close.
   */
  function createStreamChannel(onSocket) {
    const { streams, write } = onSocket
    const ids = new Set()
    let socket
    let connecting
    let closed = false
    let idleTimer
    let keep
    const clearIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const stopKeep = () => {
      try { keep?.stop() } catch {}
      keep = undefined
    }
    const touchIdle = () => {
      clearIdle()
      if (closed || ids.size > 0) return
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        if (!closed && ids.size === 0) channel.close('idle')
      }, 60_000)
      idleTimer.unref?.()
    }
    const failAll = (message) => {
      for (const id of ids) {
        streams.delete(id)
        write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/unreachable', message, details: {} } }))
      }
      ids.clear()
      touchIdle()
    }
    const attach = (ws) => {
      keep = keepAlive(ws, () => { try { ws.terminate() } catch {} })
      ws.on('message', (data) => {
        let reply
        try {
          reply = JSON.parse(data.toString('utf8'))
        } catch {
          return
        }
        if (reply.kind === 'stream-item') {
          const id = String(reply.id ?? '')
          if (!ids.has(id)) return
          write(JSON.stringify({ type: 'item', streamId: id, value: reply.value }))
          return
        }
        if (reply.kind === 'stream-end') {
          const id = String(reply.id ?? '')
          if (!ids.has(id)) return
          ids.delete(id)
          streams.delete(id)
          write(JSON.stringify(reply.ok === true
            ? { type: 'end', id }
            : { type: 'error', streamId: id, error: { code: reply.code ?? 'bridge/stream-failed', message: reply.message ?? 'the stream failed', details: {} } }))
          touchIdle()
          return
        }
        if ((reply.kind === 'result' && reply.ok === false) || reply.kind === 'error') {
          const id = String(reply.id ?? '')
          if (!ids.has(id)) return
          ids.delete(id)
          streams.delete(id)
          const failure = reply.kind === 'error'
            ? { code: reply.code ?? 'bridge/stream-failed', message: reply.message ?? 'the stream failed', details: {} }
            : bridgeError(reply)
          write(JSON.stringify({ type: 'error', streamId: id, error: failure }))
          touchIdle()
          return
        }
        if (reply.kind === 'ping') {
          try { ws.send(JSON.stringify({ kind: 'pong' })) } catch {}
        }
      })
      ws.on('close', () => {
        if (socket !== ws) return
        socket = undefined
        stopKeep()
        failAll('the bridge connection closed')
      })
      ws.on('error', () => { try { ws.terminate() } catch {} })
    }
    const ensure = async () => {
      if (socket !== undefined && socket.readyState === 1) return socket
      if (connecting !== undefined) return connecting
      connecting = connectBridge().then((ws) => {
        if (closed) {
          try { ws.terminate() } catch {}
          throw new Error('the stream channel is closed')
        }
        socket = ws
        try { ws.setMaxListeners?.(0) } catch {}
        attach(ws)
        return ws
      }).finally(() => { connecting = undefined })
      return connecting
    }
    const channel = {
      async open(id, namespace, method, args) {
        if (closed) return false
        if (ids.has(id)) {
          write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/duplicate-stream', message: 'this stream id is already open', details: {} } }))
          return false
        }
        let ws
        try {
          ws = await ensure()
        } catch (error) {
          write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/unreachable', message: `cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}`, details: {} } }))
          return false
        }
        if (closed) return false
        ids.add(id)
        clearIdle()
        streams.set(id, { stop: () => channel.cancel(id) })
        try {
          ws.send(JSON.stringify({ id, type: 'stream', namespace, method, args }))
        } catch (error) {
          ids.delete(id)
          streams.delete(id)
          write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/unreachable', message: `cannot send the stream open: ${error instanceof Error ? error.message : String(error)}`, details: {} } }))
          touchIdle()
          return false
        }
        return true
      },
      cancel(id) {
        if (!ids.has(id)) return
        ids.delete(id)
        streams.delete(id)
        touchIdle()
        try { socket?.send(JSON.stringify({ type: 'stream-cancel', target: id })) } catch {}
      },
      forget(id) {
        ids.delete(id)
        touchIdle()
      },
      close(reason = 'closed') {
        if (closed) return
        closed = true
        clearIdle()
        stopKeep()
        const current = socket
        socket = undefined
        for (const id of ids) {
          streams.delete(id)
          write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/unreachable', message: reason, details: {} } }))
        }
        ids.clear()
        try { current?.terminate() } catch {}
        streamChannels.delete(channel)
      },
    }
    streamChannels.add(channel)
    return channel
  }

  /**
   * Open one logical stream over the bridge. `$events` and byte attachments
   * fall back to the bridge Host's own `/api` socket when it serves one.
   * @param {{id: string, endpoint: string, payload: unknown}} frame - the page's open frame.
   */
  async function openStream(onSocket, frame) {
    const { write, streams } = onSocket
    // The page names its streams `streamId`; older clients used `id`.
    const id = String(frame.streamId ?? frame.id ?? '')
    const endpoint = String(frame.endpoint ?? '')
    traceLog(`open stream ${JSON.stringify(endpoint)}`)
    // The page's Gateway names some endpoints with a dot (`session.follow`);
    // the bridge names every endpoint `<namespace>/<method>`.
    const slash = endpoint.indexOf('/')
    const dot = endpoint.indexOf('.')
    const splitAt = slash === -1 ? dot : dot === -1 ? slash : Math.min(slash, dot)
    const parsed = splitAt === -1 ? [endpoint, undefined] : [endpoint.slice(0, splitAt), endpoint.slice(splitAt + 1)]
    const namespace = parsed[0]
    const method = parsed[1]
    // Gateway-owned streams (`$events`) have no namespace; the bridge has no
    // counterpart for them, so they go to the bridge Host's own `/api`.
    const joined = splitAt === -1 ? endpoint : `${namespace}/${method}`
    if (LOCAL_HOST_STREAMS.has(joined) || isLocalPreference(namespace, frame.payload?.args)) {
      await relayLocalStream(onSocket, frame)
      return
    }
    // The switch is off (or incomplete). This tab may still be holding a mux
    // socket opened before the switch-off; every stream must stay on this Host,
    // never on a remembered remote preset. `derivedStream`/the bridge path would
    // otherwise keep polling the remote even though the card says "off".
    if (stored.enabled !== true || stored.address === '' || stored.token === '') {
      await relayLocalStream(onSocket, frame)
      return
    }
    if (DERIVED_STREAMS.has(joined)) {
      await derivedStream(onSocket, frame)
      return
    }
    if (method === undefined) {
      write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/bad-endpoint', message: `unknown endpoint ${JSON.stringify(endpoint)}`, details: {} } }))
      return
    }
    // One known Client endpoint keeps its full name in `method`, so the
    // bridge-facing arguments come from the matching bridge endpoint.
    const adapted = adapterArgs(namespace, method, frame.payload?.args ?? {}, endpoint)
    const channel = onSocket.channel
    if (channel === undefined) {
      write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/no-channel', message: 'the page socket has no stream channel', details: {} } }))
      return
    }
    const payload = frame.payload !== null && typeof frame.payload === 'object' ? frame.payload : { args: frame.args }
    const args = payload.args ?? {}
    const frameArgs = STREAM_EXTRA_ARGS[endpoint]?.(args) ?? {}
    await channel.open(id, namespace, method, { ...adapted, ...frameArgs })
  }

  /**
   * Relay one stream to this Host's own Gateway socket.
   *
   * `$events` is the page's bus (readiness, live notices) and byte attachments
   * belong to this Host; both exist only on a Host socket, so they are served
   * here. The upgrade borrows this Host's own authority and the browser's signed
   * session cookie, which is what the Host's fence expects from its own page.
   * @param {{streams: Map<string, object>, write: Function, cookie: string}} onSocket - this socket's writer and stream table.
   * @param {{id?: string, streamId?: string, endpoint: string}} frame - the page's open frame.
   */
  async function relayLocalStream(onSocket, frame) {
    const { streams, write, cookie } = onSocket
    const id = String(frame.streamId ?? frame.id ?? '')
    traceLog(`local stream endpoint=${JSON.stringify(frame.endpoint)} id=${id}`)
    const base = defaults()
    if (base.localUrl === undefined) {
      write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/host-unavailable', message: 'the local web server address is unknown', details: {} } }))
      return
    }
    const target = new URL(base.localUrl)
    const host = target.host
    const wsProtocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const headers = {
      host,
      origin: target.origin,
      'sec-fetch-site': 'same-origin',
      ...(cookie === '' ? {} : { cookie }),
      ...(base.launchToken === undefined ? {} : { authorization: `Bearer ${base.launchToken}` }),
    }
    let local
    try {
      local = await connectUpstream(`${wsProtocol}//${host}/api/remote.mux`, headers)
    } catch (error) {
      write(JSON.stringify({ type: 'error', streamId: id, error: { code: 'remote-control/host-unavailable', message: `remote-control: this Host refused the ${frame.endpoint} relay: ${error instanceof Error ? error.message : String(error)}`, details: {} } }))
      return
    }
    const entry = { upstream: local, stop: () => { try { local.send(JSON.stringify({ type: 'cancel', streamId: id })) } catch {} } }
    streams.set(id, entry)
    /** DSH's per-connection client id, used to scope waterfall de-duplication. */
    let pageClientId = ''
    local.on('message', (data) => {
      if (streams.get(id) !== entry) return
      let reply
      try { reply = JSON.parse(data.toString('utf8')) } catch { return }
      const streamId = reply.streamId ?? reply.id
      if (streamId !== undefined && streamId !== id) return
      if (reply.type === 'item') {
        if (reply.value?.type === 'ready' && typeof reply.value.clientId === 'string') pageClientId = reply.value.clientId
        const shape = reply.value === undefined ? 'undefined' : (reply.value?.type ?? 'no-type')
        if (TRACE_ENABLED) traceValue(`local item type=${shape}`, reply.value, 600)
        write(JSON.stringify({ type: 'item', streamId: id, value: reply.value }))
      }
      else if (reply.type === 'end') write(JSON.stringify({ type: 'end', id }))
      else if (reply.type === 'error') write(JSON.stringify({ type: 'error', streamId: id, error: reply.error ?? { code: 'remote-control/host-failed', message: 'this Host failed the stream', details: {} } }))
      if (reply.type === 'end' || reply.type === 'error') {
        streams.delete(id)
        try { local.terminate() } catch {}
      }
    })
    local.on('close', () => {
      if (streams.get(id) !== entry) return
      streams.delete(id)
      write(JSON.stringify({ type: 'end', id }))
    })
    local.send(JSON.stringify({ type: 'open', streamId: id, endpoint: frame.endpoint, payload: frame.payload ?? { args: {} } }))
    // `$events` is this Host's bus, but a Session running on the other machine only
    // announces `session.status` inside that process. The bridge relays those as
    // `event` frames; mirror them into this stream so the composer can switch
    // between Send and Stop while the switch is on.
    if (
      String(frame.endpoint ?? '') === '$events' &&
      stored.enabled === true &&
      stored.address !== '' &&
      stored.token !== '' &&
      !isObserveOnly()
    ) {
      traceLog('opening the remote status mirror')
      // The page's event stream is the one channel already open while the remote
      // side stops answering; it carries transport-failure notices.
      const onFailure = (detail) => {
        try {
          write(JSON.stringify({ type: 'item', streamId: id, value: { type: 'emit', event: 'remote-control/failure', args: [detail] } }))
        } catch (error) {
          traceLog(`failure event write failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      onFailure.__failure = onFailure
      failureSinks.add(onFailure)
      let mirrorClosed = false
      let release = () => {}
      const stopMirror = await mirrorRemoteStatus((value) => {
        if (streams.get(id) !== entry) {
          traceLog('inject dropped: stream gone')
          return
        }
        try {
          write(JSON.stringify({ type: 'item', streamId: id, value }))
          traceLog(`inject delivered to ${id}`)
        } catch (error) {
          traceLog(`inject write failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, () => {
        mirrorClosed = true
        release()
      }, () => pageClientId)
      if (
        mirrorClosed ||
        stopMirror === undefined ||
        streams.get(id) !== entry ||
        stored.enabled !== true ||
        stored.address === '' ||
        stored.token === ''
      ) {
        // The mirror could not open, or the operator switched the transport off
        // while it was connecting. Remove the sink here: waiting for a release
        // that is only installed on success leaked one sink per page load.
        failureSinks.delete(onFailure)
        try { stopMirror?.() } catch {}
      } else {
        // Release the extra socket on every exit path, not only on an explicit
        // cancel: the page re-opens `$events` on reconnect without cancelling, and
        // the leaked mirrors were what made the first send drop the connection.
        const stopLocal = entry.stop
        let released = false
        release = () => {
          if (released) return
          released = true
          traceLog(`releasing mirror for ${id}`)
          failureSinks.delete(onFailure)
          mirrorStops.delete(release)
          try { stopLocal?.() } catch {}
          stopMirror()
        }
        mirrorStops.add(release)
        entry.stop = release
        local.once('close', release)
      }
    }
  }

  /**
   * Listen for the other machine's `session.status` pushes.
   *
   * The Host raises `api-session/status` in-process; the bridge forwards it as a
   * `{ kind: 'event', event: 'session.status', value }` frame on this socket. The
   * page's own `$events` shape is `{ event, payload }`, which is what the mirror
   * re-emits below.
   * @param {(value: object) => void} emit - receives one bus notification.
   * @returns {Promise<undefined | (() => void)>} unsubscribe, or undefined when the socket is down.
   */
  /** Event ids already injected into the page, so a replay cannot duplicate a card. */
  const deliveredWaterfalls = new Set()

  async function mirrorRemoteStatus(emit, onClose, pageKey) {
    if (stored.enabled !== true || stored.address === '' || stored.token === '') return undefined
    let upstream
    try {
      upstream = await connectBridge()
    } catch (error) {
      traceLog(`remote status feed unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const onMessage = (data) => {
      let reply
      try { reply = JSON.parse(data.toString('utf8')) } catch { return }
      traceLog(`frame kind=${reply.kind} event=${reply.event}`)
      // Answer the bridge's liveness probe. A silent socket is reaped after ~45 s,
      // and this side has nothing else to say while a session is idle.
      if (reply.kind === 'ping') {
        try { upstream.send(JSON.stringify({ kind: 'pong' })) } catch {}
        return
      }
      if (reply.kind !== 'event') return
      // A forwarded waterfall arrives already in the shape the page's own `$events`
      // stream carries (`{ type:'waterfall', event, eventId, agentId, request }`),
      // so it passes through untouched; the page answers it on `$events/result`.
      if (reply.event === 'waterfall' || reply.value?.type === 'waterfall') {
        const item = reply.value
        // A replay delivers the same prompt again after a reconnect; forwarding it
        // twice puts two answer cards on the page, and closing one leaves the other
        // visible. The Host keeps waiting either way, so the repeat is dropped.
        const seenKey = typeof item?.eventId === 'string'
          ? `${typeof pageKey === 'function' ? pageKey() : ''}:${item.eventId}`
          : undefined
        if (seenKey !== undefined) {
          if (deliveredWaterfalls.has(seenKey)) {
            traceLog(`inject-waterfall skipped (already delivered) ${seenKey}`)
            return
          }
          deliveredWaterfalls.add(seenKey)
          // Bounded so a long session cannot grow this set forever.
          if (deliveredWaterfalls.size > 200) {
            const oldest = deliveredWaterfalls.values().next().value
            deliveredWaterfalls.delete(oldest)
          }
        }
        traceValue('inject-waterfall', item, 200)
        emit(item)
        return
      }
      // Every other mirrored one-way event already carries the page's own item
      // shape (`{ type:'emit', event, args }`), so it needs no translation.
      if (reply.value?.type === 'emit') {
        const item = reply.value
        traceValue('inject-emit', item, 200)
        emit(item)
        return
      }
      if (reply.event !== 'session.status') return
      const value = reply.value ?? {}
      // The page's `$events` pump switches on `item.value.type` and dispatches
      // `notification` items to `ctx.remote.$on` listeners:
      //   if (item.value.type === 'notification') this.publishNotification(item.value.notification)
      // Anything else is skipped, so the name must be `notification`.
      // `api-session/status` is forwarded unchanged: its parameters are
      // `(sessionId, running)`, so they travel as the argument list.
      const running = value.status === 'running'
      // Exactly the shape this Host's own `$events` stream carries for the same
      // event, captured from a live session:
      //   {"type":"emit","event":"api-session/status","args":[sessionId, running]}
      // A `notification` item is not part of this stream's vocabulary and made the
      // page treat it as an entry, which tore down the connection on every push.
      const item = {
        type: 'emit',
        event: 'api-session/status',
        args: [value.sessionId, running],
      }
      // Diagnostic: the exact item handed to the page, so a failure can be traced
      // to either the shape or the delivery without another build.
      traceValue('inject', item, 2000)
      emit(item)
    }
    upstream.on('message', onMessage)
    const pinger = keepAlive(upstream, () => { try { upstream.terminate() } catch {} })
    onMessage.__pinger = pinger
    let closed = false
    upstream.on('close', () => {
      if (closed) return
      closed = true
      pinger.stop()
      try { onClose?.() } catch {}
    })
    // The bridge listener only pushes events/approvals to sockets that subscribe.
    // Unary RPC sockets stay out of the sink sets, so they no longer trigger a
    // replay of every pending prompt.
    try {
      upstream.send(JSON.stringify({ type: 'subscribe' }))
    } catch (error) {
      try { upstream.terminate() } catch {}
      return undefined
    }
    return () => {
      try { onMessage.__pinger?.stop() } catch {}
      try { upstream.off?.('message', onMessage) } catch {}
      try { upstream.terminate() } catch {}
    }
  }

  /**
   * Serve one stream the bridge protocol has no counterpart for.
   *
   * The page's Gateway feeds (`$events`, `session.control`, `session/status`)
   * exist only on a DSH Host socket. Answering them with this Host's data would
   * mix the two machines, so each is derived from the bridge instead:
   * `session.control` is composed periodically from the bridge's own session
   * list and projections, and the rest stay open without items.
   * @param {{id?: string, streamId?: string, endpoint: string}} frame - the page's open frame.
   */
  async function derivedStream(onSocket, frame) {
    const { write, streams } = onSocket
    const id = String(frame.streamId ?? frame.id ?? '')
    const endpoint = String(frame.endpoint ?? '')
    if (endpoint === 'session.control') {
      traceLog('control baseline stream opened')
      let stopped = false
      const push = async () => {
        const baseline = await bridgeControlBaseline()
        traceLog(`control baseline -> ${baseline === undefined ? 'undefined' : `${Object.keys(baseline.projections ?? {}).length} sessions`}`)
        if (stopped || baseline === undefined) return
        write(JSON.stringify({ type: 'item', streamId: id, value: { type: 'baseline', value: baseline } }))
      }
      void push()
      const timer = setInterval(() => { void push() }, CONTROL_REFRESH_MS)
      timer.unref?.()
      streams.set(id, { stop: () => { stopped = true; clearInterval(timer) } })
      return
    }
    // No bridge source exists for this feed; keep the stream open and quiet.
    streams.set(id, { stop: () => {} })
  }

  /**
   * Compose the page's `session.control` baseline from the bridge itself.
   *
   * Every listed session (including ones with no live Agent) carries the
   * projection block the bridge reports for it, which is what titles and token
   * counters render from.
   * @returns {Promise<{ projections: Record<string, { asOfSeq: number, values: object }> } | undefined>} the baseline, or undefined when the bridge cannot answer.
   */
  /**
   * Detailed projections keyed by session, with the `asOfSeq` they were read at.
   *
   * Every refresh reads `session/list`, but the detailed read is the expensive one
   * (one bridge round trip per session). A session whose list entry reports the
   * same `asOfSeq` it had last time has not changed, so its cached copy is reused.
   */
  const projectionCache = new Map()

  /**
   * Compare the `title` projection of two view bags.
   *
   * The title is what the sidebar renders and what a rename changes, so it is the
   * one field a cache hit must never mask.
   * @param {object|undefined} a - first view values.
   * @param {object|undefined} b - second view values.
   * @returns {boolean} whether both name the same title.
   */
  const sameTitle = (a, b) => {
    const left = a?.['title']
    const right = b?.['title']
    return left === right || JSON.stringify(left) === JSON.stringify(right)
  }

  /** Single-flight wrapper: two tabs must not run the projection sweep twice. */
  let baselineInFlight
  async function bridgeControlBaseline() {
    if (baselineInFlight !== undefined) return baselineInFlight
    const task = bridgeControlBaselineOnce()
    baselineInFlight = task
    try {
      return await task
    } finally {
      if (baselineInFlight === task) baselineInFlight = undefined
    }
  }

  async function bridgeControlBaselineOnce() {
    if (stored.enabled !== true || stored.address === '' || stored.token === '') return undefined
    try {
      // The list may be paged by newer Hosts. Read cursors while the result
      // offers one, but stop immediately when the shape does not name a next
      // page (older Hosts return a single page).
      const items = []
      let cursor
      for (let page = 0; page < 32; page += 1) {
        const list = await bridgeRpc('session', 'list', { _request: cursor === undefined ? {} : { cursor } }, `remote-control/control-list-${page}`)
        if (list.ok !== true) return undefined
        const pageItems = list.value?.items
        if (Array.isArray(pageItems)) items.push(...pageItems)
        const next = typeof list.value?.nextCursor === 'string' && list.value.nextCursor !== ''
          ? list.value.nextCursor
          : list.value?.hasMore === true && typeof list.value?.cursor === 'string'
            ? list.value.cursor
            : undefined
        if (next === undefined || next === cursor) break
        cursor = next
      }
      const projections = {}
      const pending = []
      for (const item of items) {
        const sessionId = item?.sessionId
        if (typeof sessionId !== 'string') continue
        const reported = item.projections
        traceLog(`control list ${sessionId.slice(0, 12)} agentAvailable=${item.agentAvailable} hasProjections=${reported !== undefined}`)
        const cached = projectionCache.get(sessionId)
        const age = cached === undefined ? Infinity : Date.now() - cached.readAt
        if (
          cached !== undefined &&
          reported !== undefined &&
          reported.asOfSeq === cached.asOfSeq &&
          sameTitle(reported.values, cached.values) &&
          age < PROJECTION_CACHE_MS
        ) {
          projections[sessionId] = cached
          continue
        }
        pending.push({ sessionId, reported })
      }
      // The detailed read is one round trip per session. Parallelise a bounded
      // batch instead of serialising the whole sweep on a high-latency link; the
      // shared RPC socket already correlates concurrent ids.
      for (let start = 0; start < pending.length; start += PROJECTION_CONCURRENCY) {
        const batch = pending.slice(start, start + PROJECTION_CONCURRENCY)
        const replies = await Promise.all(batch.map((entry) => bridgeRpc(
          'session', 'projections', { request: { sessionId: entry.sessionId } },
          `remote-control/projections/${entry.sessionId}`,
        )))
        for (let index = 0; index < batch.length; index += 1) {
          const { sessionId, reported } = batch[index]
          const fresh = replies[index]
          if (fresh.ok === true && fresh.value !== undefined) {
            if (TRACE_ENABLED) {
              const keys = Object.keys(fresh.value.values ?? {})
              traceLog(`control projections ${sessionId.slice(0, 12)}: ${keys.join(',') || '(none)'}`)
            }
            const entry = { asOfSeq: fresh.value.asOfSeq ?? 0, values: fresh.value.values ?? {}, readAt: Date.now() }
            projectionCache.set(sessionId, entry)
            projections[sessionId] = entry
          } else if (reported !== undefined) {
            projections[sessionId] = { asOfSeq: reported.asOfSeq ?? 0, values: reported.values ?? {} }
          }
        }
      }
      // Merge rather than replace: a projection key that is momentarily absent from a
      // fresh read must not erase the value the page already shows. `agentTeam` is
      // the visible case — a brief empty roster blanked the teammate count until the
      // next full reload.
      for (const [sessionId, entry] of Object.entries(projections)) {
        const previous = projectionCache.get(sessionId)
        if (previous === undefined || previous.values === undefined) continue
        for (const [key, value] of Object.entries(previous.values)) {
          if (entry.values[key] === undefined) entry.values[key] = value
        }
      }
      // Drop sessions that no longer exist so the cache cannot grow forever.
      for (const sessionId of projectionCache.keys()) if (!(sessionId in projections)) projectionCache.delete(sessionId)
      return { projections }
    } catch (error) {
      traceLog(`composing the control baseline failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

/**
 * Open one bridge socket authenticated with the plugin's credential.
 * @returns {Promise<any>} connected bridge socket.
 */
/**
 * Append one diagnostic line to a file when `DSH_REMOTE_CONTROL_TRACE` is set.
 *
 * The desktop app is launched with stdout and stderr on `/dev/null`, so a
 * stdout/stderr line is unreachable during a real test; the file is the only way
 * to see what the bridge did.
 * @param {string} message - line to record.
 */
/**
 * Whether the bridge should only observe, never inject.
 *
 * Set by creating a marker file next to the trace log. The desktop app is started
 * from Finder with no environment, so a file is the only switch an operator can
 * flip while diagnosing; the status injection is skipped so the page keeps working
 * and every real `$events` frame lands in the trace for inspection.
 * @returns {boolean} true when the marker file exists.
 */
function isObserveOnly() {
  try {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs')
    const os = globalThis.process?.getBuiltinModule?.('node:os')
    const path = globalThis.process?.getBuiltinModule?.('node:path')
    if (fs === undefined || os === undefined || path === undefined) return false
    // Keep the marker inside the Harness home (normally 0700). A world-writable
    // `/tmp` marker let any local user silently switch this window to observe-only.
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    try {
      return fs.existsSync(path.join(home, 'remote-control-observe'))
    } catch {
      return false
    }
  } catch {
    return false
  }
}

const TRACE_ENABLED = process.env.DSH_REMOTE_CONTROL_TRACE === '1'
let traceFileReady = false
function traceLog(message) {
  // Opt-in only: this is called per frame and used to do three synchronous
  // appends each time, which dominated streaming CPU and filled /tmp.
  if (!TRACE_ENABLED) return
  const line = `${new Date().toISOString()} ${message}\n`
  const fs = globalThis.process?.getBuiltinModule?.('node:fs')
  const os = globalThis.process?.getBuiltinModule?.('node:os')
  const path = globalThis.process?.getBuiltinModule?.('node:path')
  if (fs === undefined || os === undefined || path === undefined) return
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const preferred = path.join(home, 'remote-control-trace.log')
  const fallback = path.join(os.tmpdir(), 'dsh-remote-control.log')
  for (const file of [preferred, fallback]) {
    try {
      fs.appendFileSync(file, line, { mode: 0o600 })
      if (!traceFileReady) {
        try { fs.chmodSync(file, 0o600) } catch {}
        traceFileReady = true
      }
      return
    } catch {}
  }
}

/** Stringify only when tracing is on; hot paths must not pay for a disabled log. */
function traceValue(label, value, limit = 200) {
  if (!TRACE_ENABLED) return
  let text
  try { text = JSON.stringify(value) } catch { text = String(value) }
  traceLog(`${label} ${text === undefined ? '' : text.slice(0, limit)}`)
}

async function connectBridge() {
  if (stored.enabled !== true || stored.address === '' || stored.token === '') {
    throw new Error('the remote transport is off')
  }
  return connectUpstream(`ws://${stored.address}/bridge`, { authorization: `Bearer ${stored.token}` })
}

/**
 * Run one unary RPC over a fresh bridge socket.
 * @param {string} namespace - wire namespace.
 * @param {string} method - wire method.
 * @param {unknown} args - wire arguments.
 * @param {string} id - correlation id echoed by the bridge.
 * @param {Record<string, unknown>} [extra] - frame-level parameters.
 * @returns {Promise<object>} the bridge's reply frame.
 */
/**
 * Byte slots named by `{ __bytes: n, length }` placeholders in a result tree.
 * @param {unknown} value - a decoded result value.
 * @returns {{ index: number, length: number | undefined }[]} slots in encounter order.
 */
function collectByteSlots(value) {
  const found = []
  const walk = (node, depth) => {
    if (depth > 12) return
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.__bytes === 'number') {
      const length = Number.isSafeInteger(node.length) && node.length >= 0 ? node.length : undefined
      found.push({ index: node.__bytes, length })
      return
    }
    for (const item of Object.values(node)) walk(item, depth + 1)
  }
  walk(value, 0)
  return found
}

/**
 * Put the collected bytes back where their placeholders were.
 *
 * When the Host declared a slot length, the chunks were copied into one
 * preallocated array on arrival, so a large result no longer needs a second
 * full-size `Buffer.concat` here. The concat path remains for older Hosts that
 * omit `length`.
 * @param {object} reply - the buffered result frame.
 * @param {Map<number, Buffer[]>} chunks - fallback chunk lists by slot index.
 * @param {Map<number, { data?: Uint8Array, received: number }>} targets - preallocated slots.
 * @returns {unknown} the rebuilt value.
 */
function decodeByteResults(reply, chunks, targets) {
  const walk = (node, depth) => {
    if (depth > 12) return node
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.__bytes === 'number') {
      const target = targets.get(node.__bytes)
      if (target?.data !== undefined && target.received === target.data.length) return target.data
      const parts = chunks.get(node.__bytes) ?? []
      return new Uint8Array(Buffer.concat(parts))
    }
    const out = {}
    for (const [key, item] of Object.entries(node)) out[key] = walk(item, depth + 1)
    return out
  }
  return walk(reply.value, 0)
}

/**
 * Send one request on an already-open bridge socket and wait for its answer.
 *
 * Splitting this out of {@link bridgeRpc} lets a caller keep one socket for a whole
 * series of requests — a 6 MB read or a download is dozens of round trips, and
 * reconnecting for each one costs a handshake apiece. The timeout is per request,
 * not per socket, so a long transfer never trips it.
 * @param {import('node:net').Socket} upstream - connected bridge socket.
 * @param {object} request - `{ id, type, ...payload }`; `id` correlates the answer.
 * @param {object} [options] - `{ timeoutMs, onClose }`.
 * @returns {Promise<object>} the bridge reply.
 */
function rpcOnConnection(upstream, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs
  const id = request.id
  return new Promise((resolve) => {
    let settled = false
    const finish = (reply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { upstream.off?.('message', onMessage) } catch {}
      try { upstream.off?.('close', onClose) } catch {}
      try { upstream.off?.('error', onError) } catch {}
      resolve(reply)
    }
    const onClose = () => finish({ kind: 'error', code: 'remote-control/unreachable', message: 'the bridge connection closed' })
    const onError = (error) => finish({ kind: 'error', code: 'remote-control/unreachable', message: String(error instanceof Error ? error.message : error) })
    const timer = setTimeout(
      () => finish({ kind: 'error', code: 'remote-control/timeout', message: `no answer from the bridge within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    )
    timer.unref?.()
    // Byte results arrive as separate frames naming the `result` they belong to.
    // When the Host declares a slot length we allocate it once and copy chunks
    // into place; the old grow-and-concat path is only a fallback. The total is
    // capped before allocation so a hostile/oversized result cannot pin memory.
    const byteChunks = new Map()
    const byteTargets = new Map()
    const chunkSeqs = new Map()
    const expectBytes = new Set()
    let pending
    let byteTotal = 0
    const tooLarge = () => finish({
      kind: 'result',
      id,
      ok: false,
      code: 'remote-control/too-large',
      message: `the byte result exceeds the ${Math.round(MAX_BYTE_RESULT_BYTES / (1024 * 1024))} MB bridge limit`,
    })
    const tryFinish = () => {
      if (pending === undefined) return
      for (const index of expectBytes) {
        const target = byteTargets.get(index)
        if (target?.data !== undefined) {
          if (target.received < target.data.length) return
          continue
        }
        const seen = chunkSeqs.get(index)
        if (seen === undefined || !seen.complete) return
      }
      finish({ ...pending, value: decodeByteResults(pending, byteChunks, byteTargets) })
    }
    const onMessage = (data) => {
      let reply
      try { reply = JSON.parse(data.toString('utf8')) } catch { return }
      if (reply.kind === 'result-bytes' && reply.id === id) {
        const at = reply.index
        // Decode each chunk on arrival: a chunk ending on a `=` pad would stop
        // `Buffer.from(joined, 'base64')` early and silently drop the rest.
        const chunk = Buffer.from(String(reply.data ?? ''), 'base64')
        if (byteTotal + chunk.length > MAX_BYTE_RESULT_BYTES) { tooLarge(); return }
        byteTotal += chunk.length
        const target = byteTargets.get(at)
        if (target?.data !== undefined) {
          if (target.received + chunk.length > target.data.length) { tooLarge(); return }
          target.data.set(chunk, target.received)
          target.received += chunk.length
        } else {
          const list = byteChunks.get(at) ?? []
          list.push(chunk)
          byteChunks.set(at, list)
        }
        const state = chunkSeqs.get(at) ?? { count: 0, complete: false }
        state.count += 1
        if (typeof reply.total === 'number' && state.count >= reply.total) state.complete = true
        if (target?.data !== undefined && target.received >= target.data.length) state.complete = true
        chunkSeqs.set(at, state)
        tryFinish()
        return
      }
      if (reply.kind === 'result' && reply.id === id) {
        const slots = collectByteSlots(reply.value)
        let expected = 0
        for (const slot of slots) {
          if (slot.length === undefined) continue
          expected += slot.length
          if (!Number.isSafeInteger(expected) || expected > MAX_BYTE_RESULT_BYTES) { tooLarge(); return }
        }
        for (const slot of slots) {
          expectBytes.add(slot.index)
          byteTargets.set(slot.index, {
            ...(slot.length === undefined ? {} : { data: new Uint8Array(slot.length) }),
            received: 0,
          })
        }
        if (slots.length === 0) { finish(reply); return }
        pending = reply
        tryFinish()
        return
      }
      // Only an error correlated to this request may settle it. Protocol errors
      // that cannot name a request are marked fatal by the Host and close the
      // socket; they must never be attributed to every other in-flight call.
      if (reply.kind === 'error') {
        if (reply.id === id || reply.requestId === id) finish(reply)
        else if (reply.fatal === true) finish(reply)
      }
    }
    upstream.on('message', onMessage)
    upstream.once('close', onClose)
    upstream.once('error', onError)
    try {
      upstream.send(JSON.stringify(request))
    } catch (error) {
      finish({ kind: 'error', code: 'remote-control/unreachable', message: String(error instanceof Error ? error.message : error) })
    }
  })
}

  /**
   * One long-lived socket for unary RPCs.
   *
   * The old bridgeRpc opened TCP + WebSocket for every call. A page load makes
   * dozens of calls, and on a high-latency link the handshakes dominated. The
   * socket is shared, the correlation id keeps replies apart, and an idle timer
   * releases it when the window stops talking.
   */
  let sharedRpcSocket
  let sharedRpcReady
  let sharedRpcIdle
  const closeSharedRpc = () => {
    if (sharedRpcIdle !== undefined) clearTimeout(sharedRpcIdle)
    sharedRpcIdle = undefined
    const socket = sharedRpcSocket
    sharedRpcSocket = undefined
    try { socket?.terminate?.() } catch {}
  }
  const touchSharedRpc = () => {
    if (sharedRpcIdle !== undefined) clearTimeout(sharedRpcIdle)
    sharedRpcIdle = setTimeout(closeSharedRpc, 60_000)
    sharedRpcIdle.unref?.()
  }
  const rpcChannel = async () => {
    if (sharedRpcSocket !== undefined && sharedRpcSocket.readyState === 1) return sharedRpcSocket
    if (sharedRpcReady !== undefined) return sharedRpcReady
    sharedRpcReady = connectBridge()
      .then((socket) => {
        if (stored.enabled !== true) {
          try { socket.terminate() } catch {}
          throw new Error('the remote transport is off')
        }
        sharedRpcSocket = socket
        try { socket.setMaxListeners?.(0) } catch {}
        socket.on('close', () => {
          if (sharedRpcSocket === socket) sharedRpcSocket = undefined
        })
        socket.on('error', () => {})
        return socket
      })
      .finally(() => { sharedRpcReady = undefined })
    return sharedRpcReady
  }

async function bridgeRpc(namespace, method, args, id, extra = {}) {
  let upstream
  try {
    upstream = await rpcChannel()
  } catch (error) {
    return { kind: 'error', code: 'remote-control/unreachable', message: `cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return await rpcOnConnection(upstream, { ...extra, id, type: 'invoke', namespace, method, args: adapterArgs(namespace, method, args) })
  } finally {
    touchSharedRpc()
  }
}

/**
 * Ask the controlled Host whether one absolute path may be downloaded. This is
 * an explicit per-path policy decision, not a policy download: the controller
 * only receives a boolean and never needs the mode/root/deny list.
 * @param {string} path - absolute path on the controlled Host.
 * @returns {Promise<{kind: string, ok?: boolean, value?: {allowed?: boolean}, code?: string, message?: string}>} bridge reply.
 */
async function fileReadCheck(path) {
  let upstream
  try {
    upstream = await connectBridge()
  } catch (error) {
    return { kind: 'error', code: 'remote-control/unreachable', message: `cannot reach the bridge at ${stored.address}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return await rpcOnConnection(upstream, {
      id: `remote-control/check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'file-read-check',
      path,
    })
  } finally {
    try { upstream.terminate() } catch {}
  }
}

/**
 * Keep one long-lived bridge socket honest.
 *
 * A silent TCP connection can stay half-open for minutes after a network change;
 * an application-level ping makes the bridge answer (or lets this side notice)
 * within the timeout. The returned stop() is idempotent.
 * @param {import('ws')} upstream - connected bridge socket.
 * @param {() => void} onTimeout - called once when the peer stops answering.
 * @returns {{ bump: () => void, stop: () => void }} liveness handle.
 */
function keepAlive(upstream, onTimeout) {
  let last = Date.now()
  let stopped = false
  const bump = () => { last = Date.now() }
  const timer = setInterval(() => {
    if (stopped) return
    if (Date.now() - last > 90_000) {
      stopped = true
      try { onTimeout?.() } catch {}
      return
    }
    try {
      upstream.send(JSON.stringify({ type: 'ping' }))
    } catch {
      stopped = true
      try { onTimeout?.() } catch {}
    }
  }, 30_000)
  timer.unref?.()
  upstream.on('message', bump)
  return {
    bump,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try { upstream.off?.('message', bump) } catch {}
    },
  }
}

async function connectUpstream(target, headers) {
  const wsModule = await loadWebSocket()
  const WebSocket = wsModule.WebSocket ?? wsModule.default?.WebSocket ?? wsModule.default ?? wsModule
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, {
      headers,
      handshakeTimeout: requestTimeoutMs,
      perMessageDeflate: false,
      maxPayload: 20 * 1024 * 1024,
    })
    ws.once('open', () => resolve(ws))
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      reject(Object.assign(new Error(`the remote Host's API socket answered HTTP ${status}`), { status }))
    })
    ws.once('error', (error) => reject(error))
  })
}

  return {
    name: 'remote-control',
    /** The local routes the Client plugin talks to. */
    routes: () => [
      // Trace once, so the log proves which build answered.
      ...traceRoutesOnce(),
      // `/api/file` and `/api/present.host` are **not** registered here: the Host
      // already owns both (`connection.fetch.register`), and `dsh-host-webserver`
      // throws on a duplicate path — which aborted this whole route table, taking
      // the download route below with it. File bytes reach the page through the
      // RPC channel instead.
      // The page's download button. Same transfer as the preview, with a
      // `Content-Disposition` so the browser saves instead of rendering.
      {
        kind: 'exact',
        path: `${clientMarker}/can-read`,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const auth = authorize(req, url)
          if (auth.ok !== true) {
            sendJson(res, auth.status ?? 401, { ok: false, error: auth.reason ?? 'unauthorized' })
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const path = url.searchParams.get('path') ?? ''
          if (path === '' || !isAbsolutePath(path)) {
            sendJson(res, 400, { ok: false, error: 'an absolute path is required' })
            return
          }
          if (!stored.enabled || stored.address === '' || stored.token === '') {
            sendJson(res, 200, { ok: true, allowed: false })
            return
          }
          const reply = await fileReadCheck(path)
          if (reply.kind === 'result' && reply.ok === true) {
            sendJson(res, 200, { ok: true, allowed: reply.value?.allowed === true })
            return
          }
          sendJson(res, 502, {
            ok: false,
            error: reply.message ?? 'the controlled Host refused the file check',
            code: reply.code ?? 'remote-control/file-check-failed',
          })
        },
      },
      {
        kind: 'exact',
        path: `${clientMarker}/download`,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const auth = authorize(req, url)
          if (auth.ok !== true && !verifyTicket(socketSecret, url)) {
            const ticketPresent = url.searchParams.has('ticket') || url.searchParams.has('exp')
            sendJson(res, ticketPresent ? 403 : (auth.status ?? 401), { ok: false, error: auth.reason ?? 'unauthorized' })
            return
          }
          return handleDownloadRoute(req, res)
        },
      },
      {
        kind: 'exact',
        path: `${clientMarker}/download-ticket`,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          return handleTicketRoute(req, res, url)
        },
      },
      // Owner of the files shown in a delivery card. The page script steers its
      // `api/present.host` request here because the Host's own route cannot be
      // replaced, and answering from this machine would describe the wrong owner.
      {
        kind: 'exact',
        path: `${clientMarker}/present-host`,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const auth = authorize(req, url)
          if (auth.ok !== true) {
            sendJson(res, auth.status ?? 401, { ok: false, error: auth.reason ?? 'unauthorized' })
            return
          }
          return handlePresentHostRoute(req, res)
        },
      },
      { kind: 'prefix', path: clientMarker, handler: (req, res) => handleRoute(req, res) },
      { kind: 'prefix', path: `${clientMarker}/api`, handler: (req, res) => handleRoute(req, res) },
      { kind: 'exact', path: `${clientMarker}/transport`, handler: (req, res) => handleRoute(req, res) },
      // Exact-path API socket upgrade; see `handleUpgrade` for the hello frame.
      { kind: 'upgrade', path: `${clientMarker}/api/remote.mux`, handler: (req, socket, head) => handleUpgrade(req, socket, head) },
    ],
    snapshot,
    /** Owner/Cookie or page-capability result for one plugin-route request. */
    authorize,
    /** Relay description for one `/api` request, or undefined when it is not a marker request. */
    clientRoute,

    /**
     * Change the stored transport setting without going through HTTP.
     *
     * The card owns the presets in the shared record, so the switch commit runs
     * through this instead of a second `POST`: one writer, and the page script
     * hears the change through the same `onChange` path the route uses.
     * @param {{ enabled: boolean, address: string, token: string }} next - target setting.
     * @returns {Promise<object>} the new snapshot.
     */
    apply: applySetting,
  }
}

/** Frame-level bridge parameters (documented beside `args`) that a carrier may set. */
const FRAME_FIELDS = ['maxMessages']

/**
 * Frame-level bridge parameters a stream endpoint reads beside its arguments,
 * for the endpoints whose Client payload keeps them outside `args`.
 * @type {Record<string, (args: any) => object>}
 */
const STREAM_EXTRA_ARGS = {}

/**
 * Settings namespaces that describe *this window*, not the remote machine.
 *
 * Language, theme and density are personal preferences about the UI the operator
 * is looking at; reading them from the other machine made the interface flip to
 * that machine's language the moment the switch went on. The list is matched by
 * prefix so a namespace that gains sub-keys (or a `-v2` suffix) stays local.
 */
const LOCAL_PREFERENCE_NAMESPACES = ['ui', 'interface', 'appearance', 'locale', 'language', 'general', 'preferences']

/**
 * Whether one `settings` call belongs to this window's own preferences.
 * @param {string} namespace - RPC namespace.
 * @param {unknown} args - call arguments; `ns` names the settings section.
 * @returns {boolean} true when the call must stay on this Host.
 */
function isLocalPreference(namespace, args) {
  if (namespace !== 'settings') return false
  const section = typeof args?.ns === 'string' ? args.ns : typeof args?.namespace === 'string' ? args.namespace : ''
  // A settings call with no `ns` is a whole-document read (`settings/describe`), and
  // that document is where the UI language is read from. Answering it from the other
  // machine replaces this window's language with the remote one — the exact symptom
  // this guard exists to prevent — so the unscoped form stays local too.
  if (section === '') return true
  const key = section.toLowerCase()
  return LOCAL_PREFERENCE_NAMESPACES.some(
    (prefix) =>
      key === prefix ||
      key.startsWith(`${prefix}/`) ||
      key.startsWith(`${prefix}-`) ||
      key.startsWith(`${prefix}.`),
  )
}

/**
 * Streams the bridge has no counterpart for. The page's bus (`$events`) and byte
 * attachments are answered by this Host's own Gateway socket, exactly as the
 * standalone proxy does; only the data feeds below are derived from the bridge.
 */
const LOCAL_HOST_STREAMS = new Set(['$events', 'session/attachment'])

/**
 * Data feeds that are composed from the bridge instead of this Host.
 *
 * `session/status` is deliberately *not* here: it is not an RPC endpoint on the
 * other machine. The Host announces it as a `session.status` notify on the
 * `$events` bus (`{ sessionId, status }`), so forwarding it as a stream produced
 * an unknown endpoint and the composer never learned a Session was running.
 */
// `session/control` is a real Host stream. Relaying it from B keeps its live
// projection frames (model selection, permissions, titles) instead of polling a
// composed baseline that only refreshed every few seconds. No derived streams
// remain; local mode is handled by relayLocalStream before this set is checked.
const DERIVED_STREAMS = new Set()

/** How often the composed control baseline is refreshed from the bridge. */
const CONTROL_REFRESH_MS = 4000
/**
 * How long a detailed projection read may be reused.
 *
 * Shorter than the refresh interval means every other refresh re-reads, so a change
 * the list summary does not reflect still reaches the window within two ticks.
 */
const PROJECTION_CACHE_MS = 12000
/** Detailed projection reads in flight per sweep. */
// One at a time. Four concurrent projection reads look faster on a quiet link,
// but each one runs inside the same B event loop that serves the PDF reader's
// 26 sequential 256 KB readBytes requests; the burst made PDFs visibly slower
// (and could starve the interactive path on a small remote Host). The cache and
// cursor pagination are kept, so the sweep is still cheaper than before P2/P3.
const PROJECTION_CONCURRENCY = (() => {
  const raw = Number(process.env.DSH_REMOTE_CONTROL_PROJECTION_CONCURRENCY ?? 1)
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 4) : 1
})()

/**
 * Rewrite Connection-shaped arguments into the bridge's positional wire shape.
 *
 * The bridge names one argument per endpoint (`{request: {...}}`,
 * `{_request: {}}`, `{sessionId, action}`), while Connection sends a positional
 * object whose keys are the source parameter names and whose array/object
 * arguments are spread positionally. Only the endpoints that differ are
 * translated; everything else passes through untouched.
 * @param {string} namespace - wire namespace.
 * @param {string} method - wire method.
 * @param {unknown} args - Connection payload arguments.
 * @param {string} [endpointKey] - explicit endpoint key (dotted Client endpoints).
 * @returns {object} argument object the bridge expects.
 */
function adapterArgs(namespace, method, args, endpointKey) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  const endpoint = endpointKey ?? `${namespace}/${method}`
  const special = SPECIAL_ARGS[endpoint]
  if (special !== undefined) return special(args)
  return applyWireRenames(endpoint, args)
}

/**
 * Keep only the named fields of one argument object.
 * @param {any} args - Connection payload arguments.
 * @param {string[]} names - fields the bridge endpoint declares.
 * @returns {object} the argument object the bridge expects.
 */
function pickArgs(args, names) {
  const out = {}
  for (const name of names) if (args?.[name] !== undefined) out[name] = args[name]
  return out
}

/**
 * Per-endpoint argument adapters for the endpoints this page calls.
 * @type {Record<string, (args: any) => object>}
 */
/**
 * Endpoints whose page-facing parameter names differ from their wire names.
 *
 * Extracted from each descriptor's `{ name, wire }` pairs (DSH 0.2.1-rc.5). The page
 * calls these positionally, so what arrives here is the *logical* name and the Host
 * only accepts the wire one. Kept as data so a missing entry is visible in review
 * instead of hiding inside 33 near-identical closures.
 */
const WIRE_RENAMES = {
  'agentPresets/select': { agent: 'agentId' },
  'fileReferences/list': { agent: 'agentId' },
  'fileUploads/upload': { agent: 'agentId' },
  'commands/execute': { agent: 'agentId' },
  'terminal/attach': { agent: 'agentId' },
  'terminal/close': { agent: 'agentId' },
  'terminal/create': { agent: 'agentId' },
  'terminal/environment': { agent: 'agentId' },
  'terminal/rename': { agent: 'agentId' },
  'terminal/shells': { agent: 'agentId' },
  'workspaceFiles/list': { workspaceFileScope: 'workspaceFileScopeId' },
  'workspaceFiles/stat': { workspaceFileScope: 'workspaceFileScopeId' },
  'workspaceFiles/read': { workspaceFileScope: 'workspaceFileScopeId' },
  'workspaceFiles/readBytes': { workspaceFileScope: 'workspaceFileScopeId' },
  'workspaceFiles/changes': { workspaceFileScope: 'workspaceFileScopeId' },
  'dynamicCordisRunner/getClientCode': { agent: 'agentId' },
  'dynamicCordisRunner/reportClientGuardFailure': { agent: 'agentId' },
  'dynamicCordisRunner/reportRenderFailure': { agent: 'agentId' },
  'dynamicCordisRunner/resolveInspectQuery': { agent: 'agentId' },
  'dynamicCordisRunner/runHostHalf': { agent: 'agentId' },
  'dynamicCordisRunner/settleUserRun': { agent: 'agentId' },
  'dynamicCordisRunner/stopFromPanel': { agent: 'agentId' },
  'dynamicCordisRunner/syncInspectManifest': { agent: 'agentId' },
  'dynamicCordisRunner/undefineFromPanel': { agent: 'agentId' },
  'subagents/prompt': { agent: 'agentId' },
  'subagents/interruptByParent': { agent: 'agentId' },
  'goals/clear': { agent: 'agentId' },
  'goals/complete': { agent: 'agentId' },
  'goals/create': { agent: 'agentId' },
  'goals/edit': { agent: 'agentId' },
  'goals/get': { agent: 'agentId' },
  'goals/pause': { agent: 'agentId' },
  'goals/resume': { agent: 'agentId' },
  'officeToPdf/render': { workspaceFileScope: 'workspaceFileScopeId' },
  'sessionReferenceResolver/candidates': { agent: 'agentId' },
  'userQuestions/answer': { agent: 'agentId' },
}

/**
 * Copy logical parameter names onto the wire names a descriptor requires.
 *
 * A page may already send the wire name (or a bare session id in that slot), so every
 * source spelling is accepted and the translation is a no-op when it is unnecessary.
 * @param {string} endpoint - `<namespace>/<method>`.
 * @param {object} args - parameters as the page sent them.
 * @returns {object} the same bag, with wire names filled in.
 */
function applyWireRenames(endpoint, args) {
  const table = WIRE_RENAMES[endpoint]
  if (table === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const out = { ...args }
  for (const [logical, wire] of Object.entries(table)) {
    if (out[wire] !== undefined) continue
    // The page's positional call puts the session id in the logical slot; some
    // endpoints additionally send it as `sessionId`.
    const fromSession = out[logical] === undefined && (wire === 'agentId' || wire === 'workspaceFileScopeId')
      ? out.sessionId
      : undefined
    const value = out[logical] ?? fromSession
    if (value === undefined) continue
    out[wire] = value
    delete out[logical]
    // The fallback uses the bare session id as the agent/workspace identity; it
    // must not remain as an extra argument the descriptor does not declare.
    if (fromSession !== undefined) delete out.sessionId
  }
  return out
}

const SPECIAL_ARGS = {
  // The bridge names the one Session list argument `_request`.
  // The bridge names the list request `_request`; `cursor` is its only field and
  // dropping it made every page look like the first.
  'session/list': (args) => ({
    _request: {
      ...(args._request ?? {}),
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    },
  }),
  // Connection and the bridge split the same request fields around `request`.
  // `SessionCreateRequest` carries four optional fields; only forwarding two of them
  // silently dropped every workspace-scoped or preset-scoped creation.
  'session/create': (args) => ({
    request: {
      ...(args.request ?? {}),
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
    },
  }),
  // The bridge's prompt descriptor takes one `request`; the time zone belongs
  // to the request itself (a sibling field is rejected as unexpected).
  'session/prompt': (args) => ({
    request: {
      ...(args.request ?? { sessionId: args.sessionId, mode: args.mode, content: args.content }),
      ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
      ...(args.clientTimeZone === undefined ? {} : { clientTimeZone: args.clientTimeZone }),
    },
  }),
  'session/updateQueue': (args) => ({ request: args.request ?? { sessionId: args.sessionId, itemId: args.itemId, action: args.action } }),
  'session/selectModel': (args) => ({
    request: args.request ?? { sessionId: args.sessionId, provider: args.provider, model: args.model, reasoningEffort: args.reasoningEffort },
  }),
  'session.follow': (args) => ({
    request: args.request ?? {
      address: args.address,
      ...(args.maxMessages === undefined ? {} : { maxMessages: args.maxMessages }),
      ...(args.turnWindow === undefined ? {} : { turnWindow: args.turnWindow }),
      ...(args.assistantStream === true ? { assistantStream: true } : {}),
    },
  }),

  'session/openWorkspacePath': (args) => ({ request: args.request ?? args }),
  'session/workspacePathApplications': (args) => ({ request: args.request ?? args }),
  'session/control': () => ({}),
  'session/cancel': (args) => ({ request: args.request ?? { sessionId: args.sessionId } }),
  'session/rename': (args) => ({ request: args.request ?? { sessionId: args.sessionId, title: args.title } }),
  'session/fork': (args) => ({
    request: args.request ?? {
      sessionId: args.sessionId,
      ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }),
      ...(args.allowMigration === undefined ? {} : { allowMigration: args.allowMigration }),
    },
  }),
  'session/search': (args) => ({ request: args.request ?? { query: args.query } }),
  'session/projections': (args) => ({ request: args.request ?? { sessionId: args.sessionId } }),
  'session/initializeDefaultModel': () => ({}),
  // Empty-argument endpoints: any positional leftovers are not bridge fields.
  'session/modelCatalog': () => ({}),
  'settings/describe': () => ({}),
  'agentPresets/list': () => ({}),
  // The bridge descriptor for `commands/list` names the field `agentId`; the page
  // sends `agent`. Passing the page's name straight through tripped
  // `gateway/arguments-invalid: missing "agentId"`, which is what made the "+"
  // command menu flash and close instead of opening.
  'commands/list': (args) => ({
    ...(args.agentId !== undefined
      ? { agentId: args.agentId }
      : args.agent !== undefined
        ? { agentId: args.agent }
        : args.sessionId !== undefined
          ? { agentId: args.sessionId }
          : {}),
  }),
  // `SkillListRequest.sessionId` is required; omitting it rejected the call outright.
  // `attachWait` is a stream whose `agent` parameter is a lookup carried as
  // `agentId`; the page passes the session id positionally, so the field has to be
  // renamed or the call fails its descriptor check and the answer card never
  // releases its claim.
  'userQuestions/attachWait': (args) => ({
    ...(args.agentId !== undefined
      ? { agentId: args.agentId }
      : args.sessionId !== undefined
        ? { agentId: args.sessionId }
        : args.agent !== undefined
          ? { agentId: args.agent }
          : {}),
    ...(args.callId === undefined ? {} : { callId: args.callId }),
  }),
  'skills/list': (args) => {
    const request = args.request
    if (request !== undefined && typeof request === 'object') return { request }
    const sessionId = args.sessionId ?? args.agent ?? args.agentId
    return sessionId === undefined ? {} : { request: { sessionId } }
  },
  'workspace/follow': () => ({}),
  // Evidence-free providers report their failures; the page's status-only
  // account panel reads them.
  'account/watch': () => ({}),
  'productAnalytics/watchPolicy': () => ({}),
  'job/list': (args) => ({ request: args.request ?? {} }),
  'job/follow': (args) => ({ request: args.request ?? args }),
  'settings/update': (args) => pickArgs(args, ['ns', 'patch', 'expectedRevision']),
  'settings/mutate': (args) => pickArgs(args, ['ns', 'ops']),
  'settings/replace': (args) => pickArgs(args, ['ns', 'section', 'expectedRevision']),
  'settings/openSettingsDocument': (args) => pickArgs(args, ['ns', 'section', 'expectedRevision']),
  'workspace/create': (args) => ({ request: args.request ?? { path: args.path } }),
  'workspace/rename': (args) => ({ request: args.request ?? { workspaceId: args.workspaceId, title: args.title } }),
  'workspace/delete': (args) => ({ request: args.request ?? { workspaceId: args.workspaceId } }),
}

/**
 * Translate one bridge failure into a Connection failure.
 * @param {object} reply - bridge result/stream-end frame.
 * @returns {{code: string, message: string, details: object}} Connection failure.
 */
function bridgeError(reply) {
  return {
    code: typeof reply.code === 'string' && reply.code !== '' ? reply.code : 'bridge/failed',
    message: typeof reply.message === 'string' && reply.message !== '' ? reply.message : 'the bridge reported a failure',
    details: {},
  }
}

/**
 * One-sentence cause for a bridge Host that does not serve its own `/api`.
 * @param {unknown} error - connect failure.
 * @returns {string} message for the page.
 */
function hostUnavailableMessage(error) {
  const status = error?.status
  return (
    `remote-control: the bridge at ${storedAddress()} does not serve the DSH API over HTTP` +
    (typeof status === 'number' ? ` (HTTP ${status})` : '') +
    '. The always-on event stream (and byte attachments) need that endpoint; session, workspace and ' +
    'settings calls still run over the bridge protocol, and status-only resources keep their last view.'
  )
}


/**
 * @returns {string} the configured bridge address for user-facing messages.
 */
function storedAddress() {
  return configuredAddress === '' ? 'the remote Host' : configuredAddress
}

/**
 * Read this process's launch token, which the local Connection transport uses
 * to authenticate a loopback API client.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {string | undefined} the token when the connection service exposes one.
 */
function safeLaunchToken(ctx) {
  try {
    const connection = ctx.get('connection')
    const server = ctx.get('webServer')
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function' || server === undefined) return undefined
    const host = server.host?.includes(':') ? `[${server.host}]` : (server.host ?? '127.0.0.1')
    const protocol = server.protocol === 'https:' ? 'https:' : 'http:'
    const url = new URL(connection.authenticatedUrl(`${protocol}//${host}:${server.port ?? 3080}/`))
    const token = url.searchParams.get('token')
    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/**
 * Visit the bridge once with a `ping` frame to report reachability.
 * @param {string} address - normalized `host:port`.
 * @param {string} token - bridge credential.
 * @param {number} timeoutMs - handshake timeout.
 * @returns {Promise<{ ok: boolean, principal?: string, streams?: boolean, protocol?: number, error?: string }>} probe outcome.
 */
async function probeBridge(address, token, timeoutMs) {
  const WebSocket = await loadWebSocket()
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${address}/bridge`, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
    })
    const finish = (result) => {
      clearTimeout(timer)
      try {
        ws.terminate()
      } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `no answer from ${address} within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs)
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      finish({
        ok: false,
        error:
          status === 401
            ? 'the bridge rejected the token (401)'
            : status === 404
              ? `no bridge endpoint at ${address}/bridge (404)`
              : `the bridge answered HTTP ${status}`,
      })
    })
    ws.on('error', (error) => finish({ ok: false, error: error.message }))
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'ping' }))
      } catch {
        finish({ ok: false, error: 'could not send the probe frame' })
      }
    })
    ws.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString('utf8'))
      } catch {
        finish({ ok: false, error: 'the bridge sent a malformed frame' })
        return
      }
      if (frame?.kind === 'hello' || frame?.kind === 'pong') {
        finish({ ok: true, protocol: frame.protocol, principal: frame.principal, streams: frame.streams })
      } else {
        finish({ ok: true })
      }
    })
    ws.on('close', (code) => finish({ ok: false, error: `the bridge closed the probe socket (${code})` }))
  })
}

/** Cache the WebSocket implementation from the Harness installation. */
let webSocketModule

/**
 * Load a `ws` build already present on this machine. The plugin carries no
 * dependencies, so it borrows the copy the running Harness (or a parent
 * install such as the `npx` cache) ships: the Harness itself opens API
 * WebSockets with it, which makes it a guaranteed peer rather than an extra
 * download.
 * @returns {Promise<any>} the ws module namespace.
 */
async function loadWebSocket() {
  if (webSocketModule !== undefined) return webSocketModule
  const failures = []
  for (const entry of wsSearchRoots()) {
    try {
      const required = createRequire(pathToFileURL(entry))
      const mod = required(entry)
      if (typeof mod?.WebSocket === 'function') {
        webSocketModule = mod
        return mod
      }
      failures.push(`${entry}: no WebSocket export`)
    } catch (error) {
      failures.push(`${entry}: ${error?.message ?? String(error)}`)
    }
  }
  throw new Error(`remote-control: the ws package is unavailable (${failures.slice(0, 3).join('; ') || 'no candidate found'})`)
}

/**
 * The Harness installation this process runs from: the launcher's explicit
 * anchor, else the nearest ancestor of the running entry point that holds a
 * `dsh` package, since the process executable itself lives in a shared Node
 * directory rather than beside the installation.
 * @returns {string | undefined} directory holding the installation's `node_modules`.
 */
function installationAnchor() {
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR !== '') return process.env.DSH_INSTALL_DIR
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : ''
  if (entry === '') return undefined
  let dir = dirname(entry)
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (statSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).isFile()) return dir
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Enumerate package roots that may hold a `ws` build, nearest first. The
 * Harness installation is the reliable supplier: its own API Gateway opens
 * WebSockets with `ws`, and this plugin runs inside that same process.
 * @returns {{ label: string, entry: string }[]} candidate `ws/index.js` files.
 */
function wsSearchRoots() {
  const candidates = []
  const seen = new Set()
  // Each entry is a directory holding `node_modules`, never a package root.
  const addRoot = (root) => {
    if (typeof root !== 'string' || root === '') return
    const entry = root.endsWith('node_modules') ? join(root, 'ws', 'index.js') : join(root, 'node_modules', 'ws', 'index.js')
    if (seen.has(entry)) return
    seen.add(entry)
    candidates.push(entry)
  }
  // 1. an explicit installation anchor, when a launcher provides one
  addRoot(installationAnchor())
  // 2. the entry points of the running process: the Harness CLI, the plugin
  //    manager, or a test runner all live inside (or next to) the installation
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(pathToFileURL(process.argv[1]).href)
  for (const [index, anchor] of [import.meta.url, ...anchors].entries()) {
    const moduleBuiltin = process.getBuiltinModule?.('node:module')
    const loader = index === 0 ? createRequire : (moduleBuiltin?.createRequire ?? createRequire)
    try {
      // `<root>/node_modules/ws/index.js` → the directory holding `node_modules`
      addRoot(dirname(dirname(dirname(loader(anchor).resolve('ws')))))
    } catch {}
  }
  // 3. this plugin inside a checkout: walk up to the workspace root
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    addRoot(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 4. every `node_modules` directory on this process's module paths
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter)) {
    if (entry.endsWith('node_modules')) addRoot(dirname(entry))
  }
  // 5. a `node_modules` copy inside this package (an explicit local override)
  addRoot(dirname(fileURLToPath(import.meta.url)))
  return candidates
}

/**
 * Read one header value from node or Fetch headers.
 * @param {object | undefined} headers - header bag.
 * @param {string} name - lower-case header name.
 * @returns {string | undefined} the first value.
 */
function readHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const raw = headers[name]
  if (raw === undefined) return undefined
  return Array.isArray(raw) ? raw.join(', ') : String(raw)
}

/**
 * Convert node request headers into a plain Fetch header map.
 * @param {object} headers - node headers.
 * @returns {Record<string,string>} lower-case header map.
 */
function stringHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/**
 * Read a request body as bytes.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Buffer | undefined>} body bytes.
 */
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`)
      error.code = 'remote-control/body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  return Buffer.concat(chunks)
}

/**
 * Read a request body once and make it available to the reader that follows.
 *
 * `readBody` drains the stream, so deciding where a request goes *after* reading
 * it would leave the relay with nothing to forward. The bytes are buffered here
 * and re-emitted through the request's own `[Symbol.asyncIterator]`, which both
 * `readBody` and `relayLocal` use.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<any>} the parsed body, or an empty object.
 */
async function peekSettingsArgs(req, limit = 256 * 1024) {
  if (req[PEEKED] !== undefined) return req[PEEKED]
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`request body exceeds ${limit} bytes`)
      error.code = 'remote-control/body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  const buffered = Buffer.concat(chunks)
  req[PEEKED] = buffered
  // Replay: `readBody` iterates the request again, so hand back the same bytes.
  req[Symbol.asyncIterator] = async function* replay() {
    if (buffered.length > 0) yield buffered
  }
  if (buffered.length === 0) return {}
  try {
    const envelope = JSON.parse(buffered.toString('utf8'))
    return envelope?.payload?.args ?? envelope ?? {}
  } catch {
    return {}
  }
}

/**
 * `/api` paths the other machine serves as raw HTTP routes rather than RPC methods.
 *
 * `uploadFileBinary` is the file-upload service's authenticated byte intake; the
 * page POSTs the file here instead of encoding it into an RPC frame.
 */
/**
 * Build a `Content-Disposition` that survives a non-ASCII filename.
 *
 * HTTP header values are bytes; a raw CJK name throws `ERR_INVALID_CHAR` and the
 * whole response dies (Chrome then reported "site can't be reached" and saved the
 * error as `download.json`). RFC 5987 carries the real name in `filename*`, and the
 * ASCII-only `filename` fallback keeps older clients from receiving an empty one.
 * @param {string} name - file name as it should appear.
 * @returns {string} the header value.
 */
function attachmentDisposition(name) {
  // Loose ASCII fallback: keep the extension, replace everything else.
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const ascii = (stem.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download') + ext.replace(/[^\x20-\x7e]/g, '')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Filename shown in a download's `Content-Disposition`. */
function basenameOf(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = at === -1 ? path : path.slice(at + 1)
  // Quotes and newlines would break the header; anything else is kept verbatim.
  return name.replace(/["\r\n]/g, '_') || 'download'
}

/**
 * Content type for a preview response.
 *
 * Only what the panel renders is worth naming: everything else stays
 * `application/octet-stream` so the browser downloads instead of guessing.
 * @param {string} path - file path.
 * @returns {string} a media type.
 */
function guessType(path) {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  const table = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
  }
  return table[ext] ?? 'application/octet-stream'
}

const RAW_BYTE_ROUTES = new Set(['/api/session/uploadFileBinary'])

/** Marks a request whose body the router already buffered. */
const PEEKED = Symbol('remote-control/peeked')

/**
 * Read a small JSON body for a control request.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<any>} parsed body.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const body = await readBody(req, limit)
  if (body === undefined) return {}
  if (body.length > limit) throw new Error('request body is too large')
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('request body is not JSON')
  }
}

/**
 * Write a Fetch response to a node response, header for header and chunk by
 * chunk, honouring backpressure.
 * @param {import('node:http').ServerResponse} res - node response.
 * @param {Response} response - Fetch response.
 * @returns {Promise<void>} when the body is fully written.
 */
async function pipeResponse(res, response) {
  if (res.headersSent) {
    res.end()
    return
  }
  const headers = {}
  const skip = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'])
  response.headers.forEach((value, key) => {
    if (skip.has(key.toLowerCase())) return
    headers[key.toLowerCase()] = value
  })
  res.writeHead(response.status, headers)
  if (response.body === null || res.req?.method === 'HEAD') {
    res.end()
    return
  }
  try {
    for await (const chunk of response.body) {
      if (res.writableEnded || res.destroyed) break
      if (!res.write(chunk)) {
        if (res.destroyed) break
        await waitForDrain(res, res.req)
      }
    }
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end()
  }
}

/**
 * Wait for a ServerResponse to drain, or reject when the peer goes away. The
 * old code waited only for `drain`, which never fires on an aborted response;
 * a cancelled download then kept its bridge socket and loop alive forever.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {import('node:http').IncomingMessage} [req] - request.
 * @returns {Promise<void>} when the socket can accept more bytes.
 */
function waitForDrain(res, req) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onError)
      req?.off('aborted', onClose)
    }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error('the client closed the response')) }
    const onError = (error) => { cleanup(); reject(error) }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onError)
    req?.once('aborted', onClose)
    if (res.destroyed) onClose()
  })
}

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 */
/**
 * Send one RPC result, splitting out any byte arrays it carries.
 *
 * Mirrors the Host's own `fullResponse`: the JSON part describes the payload and each
 * byte array becomes a `bytes-<n>` part the client stitches back by `path`. Without
 * this the page sees `{0:137,1:80,...}` where it expects bytes and rejects the result.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string} rpcId - request correlation id.
 * @param {object} result - `{ ok, value }` or `{ ok: false, error }`.
 */
async function sendRpcResult(res, rpcId, result) {
  if (res.headersSent) {
    res.end()
    return
  }
  const attachments = []
  if (result.ok === true) {
    const walk = (node, path, depth) => {
      if (depth > 12) return node
      if (node instanceof Uint8Array) {
        attachments.push({ path, bytes: node })
        // The client walks `attachment.path` and requires the slot there to be
        // exactly `null` before installing the bytes; anything else throws
        // "invalid binary response placeholder".
        return null
      }
      if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, i], depth + 1))
      if (node === null || typeof node !== 'object') return node
      if (ArrayBuffer.isView(node)) return walk(new Uint8Array(node.buffer, node.byteOffset, node.byteLength), path, depth)
      const out = {}
      for (const [key, item] of Object.entries(node)) out[key] = walk(item, [...path, key], depth + 1)
      return out
    }
    result = { ...result, value: walk(result.value, [], 0) }
  }
  // `attachments` is a sibling of `result`, not a member of it: the client reads
  // `envelope.attachments` at the top level and takes the value from
  // `full.result.value`. Nesting it inside `result` made every byte response fail
  // with "connection: invalid binary response result".
  const body = {
    type: 'server-response',
    rpcId,
    result,
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.map((a, i) => ({ path: a.path, codec: 'bytes', part: `bytes-${i}` })) }),
  }
  if (attachments.length === 0) {
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) > MAX_JSON_RESULT_BYTES) {
      sendJson(res, 413, { ok: false, error: 'the result is too large for one RPC response' })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
    return
  }
  const boundary = `----remoteControl${Math.random().toString(36).slice(2)}`
  const parts = []
  let totalBytes = 0
  let payloadLength = 0
  for (let i = 0; i < attachments.length; i += 1) {
    const bytes = attachments[i].bytes
    // A Buffer view avoids the extra full-size copy `Buffer.from(Uint8Array)`
    // would make; the attachment array is about to be written to the socket.
    const view = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bytes-${i}"; filename="bytes-${i}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8')
    totalBytes += view.byteLength
    if (totalBytes > MAX_BYTE_RESULT_BYTES) {
      sendJson(res, 413, { ok: false, error: 'the result is too large for one RPC response' })
      return
    }
    parts.push({ header, view })
    payloadLength += header.length + view.length + 2
  }
  // No `filename` on the metadata part: with one, the browser's `formData()` hands
  // back a File instead of a string and the caller's `.text()`/JSON parse breaks.
  const metadataHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`, 'utf8')
  const metadata = Buffer.from(JSON.stringify(body), 'utf8')
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  payloadLength += metadataHeader.length + metadata.length + trailer.length
  res.writeHead(200, {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(payloadLength),
    'cache-control': 'no-store',
  })
  // Write sequentially with backpressure instead of building one giant
  // `Buffer.concat`; a 64 MB attachment stays a 64 MB view, not an extra copy.
  for (const part of parts) {
    if (!(await writeResponseChunk(res, part.header))) return
    if (!(await writeResponseChunk(res, part.view))) return
    if (!(await writeResponseChunk(res, Buffer.from('\r\n')))) return
  }
  if (!(await writeResponseChunk(res, metadataHeader))) return
  if (!(await writeResponseChunk(res, metadata))) return
  if (await writeResponseChunk(res, trailer)) res.end()
}

/**
 * Write one response chunk, waiting for `drain` when the socket is full.
 * Resolves false once the peer has gone away, so the caller stops early.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {Buffer} chunk - bytes to write.
 * @returns {Promise<boolean>} whether more may be written.
 */
function writeResponseChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  if (res.write(chunk)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok) => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('error', onError)
      resolve(ok)
    }
    const onDrain = () => done(true)
    const onClose = () => done(false)
    const onError = () => done(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onError)
    // The peer may have gone away between the `write` call and listener setup.
    if (res.destroyed || res.writableEnded) done(false)
  })
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Refuse an upgrade before the handshake completes.
 * @param {import('node:stream').Duplex} socket - client socket.
 * @param {number} status - HTTP status.
 * @param {string} reason - status text.
 */
function writeUpgradeFailure(socket, status, reason) {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  socket.destroy()
}

/**
 * Compute the RFC 6455 accept value.
 * @param {string | undefined} key - client key.
 * @returns {string} accept token.
 */
function acceptKey(key) {
  return createHash('sha1').update(`${key ?? ''}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

/**
 * Encode one unmasked server text frame.
 * @param {string} text - frame payload.
 * @returns {Buffer} the frame.
 */
function encodeServerText(text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Encode one server close frame.
 * @param {number} code - close code (1000 when out of range).
 * @param {string} reason - close reason, truncated to 123 bytes.
 * @returns {Buffer} the frame.
 */
function closeFrame(code, reason) {
  const valid = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1000
  const body = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123)
  // Close frame: 2-byte header, 2-byte code, then the reason. The old layout
  // allocated only 2+reason bytes and wrote the code over the reason.
  const frame = Buffer.alloc(4 + body.length)
  frame[0] = 0x88
  frame[1] = 2 + body.length
  frame.writeUInt16BE(valid, 2)
  body.copy(frame, 4)
  return frame
}

/** Encode one unmasked server control frame (pong/close/ping). */
function encodeServerControl(opcode, payload) {
  const body = Buffer.from(payload ?? Buffer.alloc(0))
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

/**
 * Convert message bytes to text.
 * @param {Buffer} data - frame bytes.
 * @returns {string} payload text.
 */
function toText(data) {
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

/**
 * Minimal client→server frame reader: parses masked text/close/ping frames from
 * the browser socket and ignores everything else.
 * @param {import('node:stream').Duplex} socket - browser socket.
 * @returns {{ on: Function, push: Function }} frame events.
 */
function textFrames(socket) {
  const listeners = { text: [], close: [], end: [], error: [] }
  const queue = new ByteQueue()
  let fragmented = null
  let fragmentedBytes = 0
  const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
  const emit = (name, ...args) => {
    for (const fn of listeners[name]) fn(...args)
  }
  const fail = (error) => {
    emit('error', error)
    socket.destroy()
  }
  const parse = () => {
    for (;;) {
      if (queue.length < 2) return
      const meta = frameSize(queue.peek(14), MAX_MESSAGE_BYTES)
      if (meta.error !== undefined) {
        if (meta.error === 'truncated frame') return
        fail(new Error(meta.error === 'frame exceeds maxRequestBytes' ? 'websocket frame too large' : meta.error))
        return
      }
      if (queue.length < meta.total) return
      const frame = queue.take(meta.total)
      const payload = Buffer.alloc(meta.length)
      const mask = frame.subarray(meta.payloadOffset - 4, meta.payloadOffset)
      for (let index = 0; index < meta.length; index += 1) {
        payload[index] = frame[meta.payloadOffset + index] ^ mask[index % 4]
      }
      if (meta.opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        emit('close', code, payload.subarray(2).toString('utf8'))
        return
      }
      if (meta.opcode === 0x9) {
        if (socket.writable) socket.write(encodeServerControl(0xa, payload))
        continue
      }
      if (meta.opcode === 0xa) continue
      if (meta.opcode === 0x1 || meta.opcode === 0x0) {
        if (fragmented === null) fragmented = []
        fragmentedBytes += payload.length
        if (fragmentedBytes > MAX_MESSAGE_BYTES) {
          fail(new Error('websocket message too large'))
          return
        }
        if (payload.length > 0) fragmented.push(payload)
        if (meta.fin) {
          const text = Buffer.concat(fragmented).toString('utf8')
          fragmented = null
          fragmentedBytes = 0
          emit('text', text)
        }
        continue
      }
      if (meta.opcode === 0x2) {
        fail(new Error('binary frames are not supported by the bridge'))
        return
      }
    }
  }
  socket.on('data', (chunk) => {
    queue.push(chunk)
    parse()
  })
  socket.on('close', () => emit('end'))
  socket.on('error', (error) => emit('error', error))
  return {
    on: (name, fn) => {
      listeners[name].push(fn)
    },
    push: (chunk) => {
      queue.push(chunk)
      parse()
    },
  }
}