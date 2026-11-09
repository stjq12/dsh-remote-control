import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, saveState, sectionView } from './lib/state.js'
import { normalizeFileRead, normalizeServiceDuration } from './lib/file-policy.js'

const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
})()

export const name = 'remote-control'

/**
 * Services this row needs. It keeps the web surface it already used and adds the
 * two the being-controlled listener needs: `typertGateway` to dispatch Remote
 * calls in-process and `connection` to mint the Peer each socket speaks for.
 */
export const inject = ['webServer', 'typertGateway', 'connection']

/**
 * Host half of the merged remote-control bundle.
 *
 * The plugin carries both directions of remote access, because a machine is
 * often both a target and a controller:
 *
 *  - **Being controlled** (`lib/bridge-host.js`, card tab 1): an authenticated
 *    WebSocket at `/bridge` that dispatches Remote calls in-process, so a remote
 *    client reaches methods the browser transport refuses from non-loopback.
 *  - **Controlling** (`bridge.js`, card tab 2): the marker routes below, which
 *    the browser half routes this page's own `/api` traffic through when the
 *    switch is on, relaying every call to a remote bridge instead of this Host.
 *
 * The controlling half never executes a Remote call for the remote path.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {object} [config] - resolved plugin config (`clientMarker`, `requestTimeoutMs`, `bridge`).
 */
export async function apply(ctx, config) {
  const { createBridgeProxy, normalizeAddress, normalizeToken } = await import('./bridge.js')
  const file = settingsFile(ctx)
  // One record drives both halves; the proxy's setting is the `remote` section of
  // it, so the transport survives a restart with the preset the card selected.
  const seedConfig = config?.bridge ?? {}
  const state = await loadState(file, {
    local: { host: seedConfig.host, port: seedConfig.port, token: seedConfig.token, name: seedConfig.name },
    remote: { host: seedConfig.remoteHost, port: seedConfig.remotePort, token: seedConfig.remoteToken, name: seedConfig.remoteName },
  })
  // Per-process capability for the page's mux WebSocket. The page hook is the
  // only place that knows it; a cross-origin page cannot read the injected HTML.
  const socketSecret = randomUUID()
  const clientMarker = (typeof config?.clientMarker === 'string' && config.clientMarker.startsWith('/')
    ? config.clientMarker.replace(/\/+$/, '')
    : '') || '/remote-control'
  const activeRemote = () => state.remote.presets.find((preset) => preset.id === state.remote.activeId)
  const remoteNow = activeRemote()
  const saved = {
    enabled: state.remote.enabled === true && remoteNow !== undefined,
    address: remoteNow === undefined
      ? ''
      : `${remoteNow.host.startsWith('[') ? remoteNow.host : remoteNow.host.includes(':') ? `[${remoteNow.host}]` : remoteNow.host}:${remoteNow.port}`,
    token: remoteNow?.token ?? '',
  }
  // Startup marker: proves the running Host picked up this build of the plugin.
  // Written to several locations because the only writable one depends on how the
  // Host was launched (`~/.dsh` is sandboxed in some shells, `/tmp` never is).
  ;(() => {
    // Diagnostics are opt-in, exactly like the frame trace; a normal start must
    // not create a log file or write to disk.
    if (process.env.DSH_REMOTE_CONTROL_TRACE !== '1') return
    const line = `${new Date().toISOString()} host plugin loaded pid=${process.pid}\n`
    const fs = globalThis.process?.getBuiltinModule?.('node:fs')
    const os = globalThis.process?.getBuiltinModule?.('node:os')
    const path = globalThis.process?.getBuiltinModule?.('node:path')
    if (fs === undefined || os === undefined || path === undefined) return
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    for (const file of [
      path.join(home, 'remote-control-trace.log'),
      path.join(os.tmpdir(), 'dsh-remote-control.log'),
    ]) {
      try {
        fs.appendFileSync(file, line, { mode: 0o600 })
        try { fs.chmodSync(file, 0o600) } catch {}
        break
      } catch {}
    }
    try {
      process.stderr.write(line)
    } catch {}
  })()

  const proxy = createBridgeProxy(ctx, {
    clientMarker,
    requestTimeoutMs: config?.requestTimeoutMs ?? 30_000,
    socketSecret,
    initial: saved,
    // The record is the only file: mirroring the transport into a second one would
    // let the two disagree after a crash between the two writes.
    persist: () => {
      const preset = activeRemote()
      const live = proxy.snapshot()
      state.remote.enabled = live.enabled === true
      if (preset !== undefined && typeof live.address === 'string' && live.address !== '') {
        try {
          const endpoint = normalizeAddress(live.address)
          preset.host = endpoint.host
          preset.port = endpoint.port
        } catch {}
      }
      // Never let a blank live value erase a stored credential: turning the switch
      // off clears the snapshot's token, and writing that back would silently wipe
      // the preset the operator had already saved.
      if (preset !== undefined && typeof live.token === 'string' && live.token !== '') preset.token = live.token
      return saveState(file, state)
    },
  })
  ctx.provide('bridgeProxy', proxy)
  // The routes must exist when this context finishes loading; `webServer.register`
  // is fiber-owned, so plain registrations belong to this plugin's context.
  const server = ctx.webServer
  installPageHook(server, ctx, socketSecret, clientMarker)
  for (const route of proxy.routes()) {
    const register = route.kind === 'upgrade' ? server.registerUpgrade.bind(server) : server.register.bind(server)
    const dispose = register(route)
    ctx.effect(() => (typeof dispose === 'function' ? dispose : () => {}), `remote-control: ${route.path} route`)
  }
  const transportNow = proxy.snapshot()
  if (process.env.DSH_REMOTE_CONTROL_TRACE === '1') {
    ctx.logger?.('remote-control')?.info?.(
      `transport ${transportNow.enabled ? 'on' : 'off'}${transportNow.address ? ` (${transportNow.address})` : ''}`,
    )
  }

  // Tab 1 of the card: this machine as the controlled end. Mounted from the same
  // row so one plugin owns both directions; a missing service would have failed
  // the row's injection above, so a thrown error here is a real fault.
  const { mountBridge, parseRequestedHost, parseRequestedPort } = await import('./lib/bridge-host.js')
  // The operator's choices live in the shared JSON record, not in the profile
  // patch: the card edits presets at runtime and a deployment file must stay
  // reproducible. The patch only seeds the very first preset.
  const seed = config?.bridge ?? {}
  const activeLocal = () => state.local.presets.find((preset) => preset.id === state.local.activeId)
  const current = activeLocal()
  // Persist on every bridge mutation so a switch flip, address edit, port edit or
  // token rotation survives a restart.
  const persistLocal = (next) => {
    // The file-read policy and lifetime are machine-level settings: they must
    // survive even when no preset exists, so persist them before the preset
    // early return.
    if (next.fileRead !== undefined) state.local.fileRead = normalizeFileRead(next.fileRead)
    if (next.durationMs !== undefined) state.local.durationMs = normalizeServiceDuration(next.durationMs)
    state.local.enabled = next.enabled
    const preset = activeLocal()
    if (preset !== undefined) {
      preset.host = next.host
      preset.port = next.port
      preset.token = next.token
      if (preset.name === '' || preset.name === undefined) preset.name = `${next.host}:${next.port}`
    }
    void saveState(file, state).catch(() => {})
  }
  // Neither switch survives a restart. A persisted `enabled: true` describes the
  // previous run, not this one: after a crash it survives on disk while the port
  // it names is long gone, and the card would show an open switch nothing is
  // listening behind. Remote has the same problem: the proxy is forced off on
  // load, so leaving the record on made the card claim a transport that was not
  // active. Opening either side is a per-session decision.
  if (state.local.enabled === true || state.remote.enabled === true) {
    state.local.enabled = false
    state.remote.enabled = false
    void saveState(file, state).catch(() => {})
  }
  const bridge = mountBridge(ctx, {
    enabled: false,
    host: current?.host ?? '',
    port: current?.port ?? 7400,
    token: current?.token ?? '',
    principal: seed.principal,
    allowStreams: seed.allowStreams,
    maxRequestBytes: seed.maxRequestBytes,
    fileRead: state.local.fileRead,
    durationMs: state.local.durationMs,
    authorize: proxy.authorize,
    onChange: persistLocal,
  })
  ctx.provide('bridgeHost', bridge)
  // Closing the machine is part of shutting down, not of the switch: record the
  // closed state as the plugin unloads so a normal quit leaves the same record a
  // fresh start would write. The write is fire-and-forget because dispose is
  // synchronous; the start-up reset above is what covers a crash that skips it.
  ctx.effect(() => () => {
    try {
      if (state.local.enabled !== true && state.remote.enabled !== true) return
      state.local.enabled = false
      state.remote.enabled = false
      void saveState(file, state).catch(() => {})
    } catch {
      // Best-effort shutdown record.
    }
  }, 'remote-control: closed on unload')
  // The card reads and writes the whole record through these routes.
  installStateRoutes(ctx, { file, state, bridge, proxy, authorize: proxy.authorize, basePath: clientMarker, parseRequestedHost, parseRequestedPort, normalizeAddress, normalizeToken })
}

/**
 * Page-script key holding this tab's transport decision (`{"want":true|false}`).
 * The dialog writes it before reloading, so the page script can act on it
 * synchronously before the shell starts.
 */
const SWITCH_KEY = 'dsh-remote-control/switch'
/** Marker the page script sets once it wrapped the page globals. */
const HOOK_MARK = '__remoteControlHook'
/** Marker header the Host routes use to recognise this page's calls. */
const MARKER_HEADER = 'x-dsh-remote-control'
/** API prefix the page script rewrites the page's own carriers onto. */
const BASE_PATH = '/remote-control'

/**
 * The page script, injected before the shell's own script.
 *
 * It wraps the page's generic `fetch` and `WebSocket` so that, while this tab's
 * switch is on, the harness page's `/api` calls and its API socket go to the
 * plugin's transport routes instead of this Host. Everything that is not one of
 * those two carriers passes through untouched. The script is synchronous and
 * reads only storage, so it can run before the shell's own scripts.
 * @returns {string} inline script source.
 */
function pageHookScript(secret, basePath = BASE_PATH) {
  return `(function () {
  var KEY = '${SWITCH_KEY}'
  var NOTICE_KEY = 'dsh-remote-control/notice'
  var MARK = '${HOOK_MARK}'
  var HEADER = '${MARKER_HEADER}'
  var CAP = 'x-dsh-remote-control-capability'
  var BASE = ${JSON.stringify(basePath)}
  var RBR = '/rbr'
  function isPluginPath(path) {
    return path === BASE || path.indexOf(BASE + '/') === 0 || path === RBR || path.indexOf(RBR + '/') === 0
  }
  var BUILD = 'v3'
  var SECRET = '${secret}'
  // Never re-wrap the same page twice. The loader facade exists from the first
  // script on, so it is not a "shell already started" signal.
  if (window[MARK] === true) return
  var flag
  try {
    var raw = window.sessionStorage.getItem(KEY)
    flag = raw === null ? undefined : JSON.parse(raw)
  } catch (error) { flag = undefined }
  var want = flag !== undefined && flag.want === true
  var nativeFetch = window.fetch
  var NativeWebSocket = window.WebSocket
  /**
   * Warn, then return this window to the Local Host.
   *
   * The switch is the same decision the card writes, so the fallback is persistent:
   * a reload lands on want:false and the window shows local data. The delay exists
   * so the toast can be read before the reload clears the page.
   * @param {{kind?: string, message?: string}} detail - what the proxy reported.
   */
  /**
   * Return this window to the Local Host, leaving a note for the next load.
   *
   * Nothing is drawn here on purpose. The switch-off is followed by a reload, so
   * anything painted now would be discarded with the page, and a desktop shell can
   * drop the timer that would have delayed it. The sentence goes into session
   * storage instead; the card reads it once on the load that follows and shows it.
   * @param {{kind?: string, message?: string}} [detail] - what went wrong.
   */
  function fallbackToLocal(detail) {
    if (!want) return
    var english = false
    try {
      var lang = String((document.documentElement && document.documentElement.lang) || '')
      if (lang === '') lang = String((window.navigator && window.navigator.language) || '')
      english = /^en\b/i.test(lang)
    } catch (error) {}
    // Stop rewriting URLs immediately, so nothing new is sent to the dead link.
    want = false
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify({ want: false }))
    } catch (error) { /* the switch-off below still returns to local */ }
    try {
      window.sessionStorage.setItem(NOTICE_KEY, JSON.stringify({
        kind: 'error',
        message: english ? 'Connection failed; switched back to this machine. Check the network or token.' : '连接失败，已切回本机。请检查网络或令牌。',
        at: Date.now(),
      }))
    } catch (error) { /* a notice is nice to have */ }
    var reload = function () { try { window.location.reload() } catch (error) {} }
    var disable = window.__remoteControlFailBack
    if (typeof disable === 'function') {
      disable(detail).then(reload, reload)
      return
    }
    // The card's bundle has not mounted yet. Turn the switch off through the same
    // endpoint it would use, then reload onto the local transport.
    try {
      nativeFetch(BASE + '/state', {
        method: 'POST',
        credentials: 'same-origin',
        headers: (function () {
          var h = new Headers()
          h.set('content-type', 'application/json')
          h.set('x-dsh-remote-control', '1')
          h.set(CAP, SECRET)
          return h
        })(),
        body: JSON.stringify({ section: 'remote', action: 'toggle', enabled: false, host: '', port: 0, token: '' }),
      }).then(reload, reload)
    } catch (error) { reload() }
  }
  function performDownload(path) {
    // The download affordance belongs to the remote window only; the local
    // window keeps DSH's own file controls.
    if (typeof path !== 'string' || path === '' || !want) return
    // A navigation cannot attach a custom header, so exchange the page
    // capability for a short-lived, path-bound ticket first. The capability
    // itself never appears in the download URL.
    try {
      nativeFetch(BASE + '/download-ticket', {
        method: 'POST',
        credentials: 'same-origin',
        headers: (function () {
          var h = new Headers()
          h.set('content-type', 'application/json')
          h.set(CAP, SECRET)
          return h
        })(),
        body: JSON.stringify({ path: path }),
      }).then(function (response) {
        if (!response.ok) return undefined
        return response.json()
      }).then(function (ticket) {
        if (ticket === undefined || ticket.ok !== true || typeof ticket.ticket !== 'string' || typeof ticket.exp !== 'number') return
        var link = document.createElement('a')
        link.href = BASE + '/download?path=' + encodeURIComponent(path) +
          '&exp=' + encodeURIComponent(String(ticket.exp)) +
          '&ticket=' + encodeURIComponent(ticket.ticket)
        link.download = ''
        link.style.display = 'none'
        document.body.appendChild(link)
        link.click()
        link.remove()
      }, function () { /* a failed ticket simply leaves no download */ })
    } catch (error) { /* the anchor path is best-effort */ }
  }
  try {
    if (typeof EventSource === 'undefined') { /* downloads wait for the stream below */ }
  } catch (error) {}
  /** Rewrite one page-relative carrier path onto the plugin's routes. */
  function bridgePath(path) {
    var raw = String(path)
    // Rewrite only the path. A query such as ?path=/api/report used to be
    // rewritten too, which silently changed the file being previewed.
    var cut = raw.search(/[?#]/)
    var suffix = cut === -1 ? '' : raw.slice(cut)
    var text = cut === -1 ? raw : raw.slice(0, cut)
    // api/... becomes <marker>/api/.... The rewrite must be idempotent: the page
    // resolves relative routes such as api/present.host against its own URL, which
    // can already sit under the marker, and prepending it twice produced
    // a doubled marker prefix (a 404).
    var marker = BASE.slice(1)
    if (text.indexOf(marker + '/api/') !== -1) return text + suffix
    return text.replace(/(^|\\/)api\\//, function (_match, lead) { return lead + marker + '/api/' }) + suffix
  }
  if (typeof nativeFetch === 'function') {
    /**
     * Watch a proxied response for the transport-failure mark.
     *
     * The mark travels on the failing request's own response because the event
     * stream dies with the link it would report on. One observation is enough: the
     * fallback reloads the page.
     * @param {Promise<Response>} pending - the in-flight proxied request.
     * @returns {Promise<Response>} the same promise, unaltered.
     */
    function watchFailure(pending) {
      return pending.then(function (response) {
        try {
          var kind = response.headers.get('x-remote-control-failure')
          if (kind) {
            var encoded = response.headers.get('x-remote-control-message') || ''
            var message = encoded === '' ? '' : decodeURIComponent(encoded)
            fallbackToLocal({ kind: kind, message: message })
          }
        } catch (error) { /* a missing header means success */ }
        return response
      })
    }
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || '')
      var bare = url.replace(/[?#].*$/, '')
      var plugin = isPluginPath(bare)
      // State, presets and the legacy transport route are plugin-internal. They
      // are usable while this tab is on the local transport too, so this branch
      // sits before the want gate and carries the page capability with it.
      if (plugin) {
        var pluginHeaders = new Headers(init && init.headers)
        pluginHeaders.set(CAP, SECRET)
        return nativeFetch(input, Object.assign({}, init, { headers: pluginHeaders }))
      }
      if (!want) return nativeFetch(input, init)
      // The delivery card asks its own Host who owns the files. Answering from this
      // window would describe the wrong machine, and the Host route cannot be
      // replaced (it is already registered), so the request is steered to our own
      // route, which reports the other Host with no usable desktop.
      if (/(^|\\/)api\\/present\\.host$/.test(bare)) {
        var probeHeaders = new Headers(init && init.headers)
        probeHeaders.set(CAP, SECRET)
        return nativeFetch(BASE + '/present-host', { method: 'GET', credentials: 'same-origin', headers: probeHeaders })
      }
      if (!/(^|\\/)api\\/[A-Za-z0-9_$.-]+/.test(bare)) return nativeFetch(input, init)
      var headers = new Headers(init && init.headers)
      headers.set(HEADER, '1')
      headers.set(CAP, SECRET)
      return watchFailure(nativeFetch(bridgePath(url), Object.assign({}, init, { headers: headers })))
    }
  }
  // The file uploader uses XMLHttpRequest, not fetch, so a fetch-only hook left
  // uploads pointing at this machine's own /api and the bytes never reached the
  // remote host. Only the open() URL is rewritten; the body keeps streaming.
  var NativeXhr = window.XMLHttpRequest
  if (typeof NativeXhr === 'function') {
    var HookedXhr = function () {
      var xhr = new NativeXhr()
      var open = xhr.open
      xhr.open = function (method, url) {
        var next = url
        var plugin = false
        try {
          var original = new URL(String(url), document.baseURI)
          plugin = isPluginPath(original.pathname)
          if (want && /(^|\\/)api\\/[A-Za-z0-9_$.-]+/.test(String(url).replace(/[?#].*$/, ''))) {
            var absolute = new URL(String(url), document.baseURI)
            absolute.pathname = bridgePath(absolute.pathname)
            next = absolute.href
          }
        } catch (error) { next = url }
        var result = open.apply(xhr, [method, next].concat(Array.prototype.slice.call(arguments, 2)))
        // Header must be set after open() has run, and only when the URL was ours:
        // XHR throws if a header is named while the request is in the UNSENT state.
        if (next !== url || plugin) {
          try {
            xhr.setRequestHeader(HEADER, '1')
            xhr.setRequestHeader(CAP, SECRET)
            xhr.withCredentials = true
          } catch (error) { /* the header is best-effort */ }
        }
        return result
      }
      return xhr
    }
    HookedXhr.prototype = NativeXhr.prototype
    for (var xhrKey in ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
      if (typeof NativeXhr[xhrKey] !== 'undefined') HookedXhr[xhrKey] = NativeXhr[xhrKey]
    }
    window.XMLHttpRequest = HookedXhr
  }
  if (typeof NativeWebSocket === 'function') {
    var HookedWebSocket = function (url, protocols) {
      if (!want || !/(^|\\/)api\\/remote\\.mux/.test(String(url))) return new NativeWebSocket(url, protocols)
      var absolute = new URL(String(url), document.baseURI)
      absolute.pathname = bridgePath(absolute.pathname)
      var params = new URLSearchParams(absolute.search)
      params.set('rc', SECRET)
      absolute.search = '?' + params.toString()
      absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:'
      var socket = new NativeWebSocket(absolute.href, protocols)
      // Watch this socket only for transport-failure notices.
      try {
        socket.addEventListener('message', function (event) {
          // Failure notices share this stream: the client bundle renders a toast,
          // and this side falls back to the Local Host once it has been read.
          if (typeof event.data === 'string' && event.data.indexOf('remote-control/failure') !== -1) {
            try {
              var failFrame = JSON.parse(event.data)
              var failItem = failFrame && failFrame.value
              if (failItem && failItem.type === 'emit' && failItem.event === 'remote-control/failure') {
                fallbackToLocal(failItem.args && failItem.args[0])
                return
              }
            } catch (error) { /* not our frame */ }
          }
        })
      } catch (error) { /* a socket without addEventListener simply never sees failures */ }
      return socket
    }
    HookedWebSocket.prototype = NativeWebSocket.prototype
    HookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING
    HookedWebSocket.OPEN = NativeWebSocket.OPEN
    HookedWebSocket.CLOSING = NativeWebSocket.CLOSING
    HookedWebSocket.CLOSED = NativeWebSocket.CLOSED
    window.WebSocket = HookedWebSocket
  }
  // The dialog can flip this live: the wrappers read it on every call.
  window.__remoteControlBuild = BUILD
  window.__remoteControlBase = BASE
  window.__remoteControlCapability = SECRET
  // Exposed so the client bundle's own slot button can start a download without
  // duplicating the anchor trick or the remote-mode gate.
  window.__remoteControlDownload = performDownload
  window.__remoteControlWant = function (next) {
    if (typeof next === 'boolean') want = next
    return want
  }
  try {
    Object.defineProperty(window, MARK, { value: true, configurable: true })
  } catch (error) { window[MARK] = true }
})()`
}

/**
 * Put the page hook into every index response, ahead of the shell's own script.
 *
 * Two carriers exist because the page is assembled by two different owners:
 *
 *  - **Browser (web profile).** `dsh-host-webserver` renders `index.html` itself,
 *    so `tapIndex` — which runs after the structured rows — rewrites the markup.
 *  - **Desktop (Electron).** The window loads `index.html` straight off disk over
 *    `dsh-app://app/`, so `tapIndex` is never called for it. The desktop shell
 *    instead applies the Host's structured `webserver/index-inject` table inside
 *    the page (`applyIndexInjections`), so the same script has to be contributed
 *    as a `script` row to reach that window.
 *
 * Both carriers are installed. The script is idempotent (it bails when
 * `HOOK_MARK` is already set), so a page that receives it twice runs it once.
 * @param {object} server - Host web server service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context, for effect scoping.
 */
/**
 * Mount the preset routes the card drives.
 *
 * These are loopback administration, like the bridge's own `/rbr/*` routes: the
 * card renders presets, and a preset holds a token that grants owner rights on
 * the far machine.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{ file: string, state: object, bridge: object }} deps - shared record and bridge handle.
 */
function installStateRoutes(ctx, {
  file,
  state,
  bridge,
  proxy,
  authorize,
  basePath = BASE_PATH,
  parseRequestedHost,
  parseRequestedPort,
  normalizeAddress,
  normalizeToken,
}) {
  const server = ctx.webServer
  if (typeof server?.register !== 'function') return
  const send = (res, code, body) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.length,
    })
    res.end(payload)
  }
  /**
   * The state routes are owner-level: they expose preset credentials and drive
   * the local bridge. They are guarded by the same owner/Cookie or page
   * capability as the proxy routes; network location is deliberately not used,
   * so a LAN/Tailscale browser page can use the card while an unauthenticated
   * network client cannot.
   */
  const readBody = (req, limit = 16384) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  /** Validate a local bind target with the same rules the bridge enforces. */
  const localTarget = (host, port) => {
    const checkedHost = parseRequestedHost(host)
    if (checkedHost instanceof Error) return { error: checkedHost.message, code: 'bad-host', field: 'target' }
    const checkedPort = parseRequestedPort(port)
    if (checkedPort instanceof Error) return { error: checkedPort.message, code: 'bad-port', field: 'target' }
    return { host: checkedHost, port: checkedPort }
  }
  /** Validate a remote endpoint, accepting hostnames but bracketing IPv6. */
  const remoteTarget = (host, port) => {
    const text = String(host ?? '').trim()
    const shown = text.startsWith('[') ? text : text.includes(':') ? `[${text}]` : text
    try {
      const endpoint = normalizeAddress(`${shown}:${Number(port)}`)
      return { host: endpoint.host, port: endpoint.port, address: endpoint.address }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const remoteToken = (raw) => {
    try {
      return { token: normalizeToken(raw) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const snapshot = () => {
    // `transport` mirrors what the page script reads: the card decides whether to
    // reload from it, so it must be the proxy's own view rather than the record's.
    const transport = proxy?.snapshot?.() ?? { state: 'off', address: '' }
    return {
      version: state.version,
      pluginVersion: PACKAGE_VERSION,
      // `status` is the live listener, not the record: a failed bind or a port
      // scan must be visible instead of the switch claiming a port nobody holds.
      local: { ...sectionView(state.local), status: bridge.status() },
      remote: sectionView(state.remote),
      transport: { state: transport.state, address: transport.address ?? '', enabled: transport.enabled === true },
      // True once the bridge stopped answering and the proxy fell back to this Host.
      fallback: proxy?.snapshot?.().fallback === true,
    }
  }

  const handle = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://rc.invalid')
    } catch {
      return send(res, 400, { ok: false, error: 'invalid request URL' })
    }
    const auth = authorize(req, url)
    if (auth.ok !== true) {
      return send(res, auth.status ?? 401, { ok: false, error: auth.reason ?? 'unauthorized' })
    }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, { ok: true, ...snapshot() })
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method-not-allowed' })
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return send(res, 415, { ok: false, error: 'content-type must be application/json' })
      }
      // One POST endpoint carries every mutation, discriminated by `action` in the
      // body; the path stays a single prefix so the card needs one URL.
      const body = await readBody(req)
      const action = typeof body?.action === 'string' ? body.action : ''
      if (body?.section !== 'local' && body?.section !== 'remote') {
        return send(res, 400, { ok: false, error: 'section must be "local" or "remote"' })
      }
      const section = body.section === 'remote' ? state.remote : state.local
      const host = typeof body.host === 'string' ? body.host.trim() : ''
      const port = Number(body.port)
      const typedToken = typeof body.token === 'string' ? body.token.trim() : ''

      if (action === 'toggle') {
        // The switch is an action: it commits the form's target and the new state
        // together, so turning it on always listens on what the fields show.
        const wanted = body.enabled === true
        if (section.section === 'local') {
          if (!wanted) {
            const result = await bridge.configure({ enabled: false, persist: false })
            section.enabled = false
            await saveState(file, state)
            if (!result.ok) return send(res, 502, { ok: false, error: result.error, ...snapshot() })
            return send(res, 200, { ok: true, ...snapshot() })
          }
          const target = localTarget(host, port)
          if (target.error !== undefined) {
            return send(res, 400, { ok: false, error: target.error, code: target.code, field: 'target' })
          }
          const current = section.presets.find((entry) => entry.id === section.activeId)
          // An existing preset's empty token stays empty: the machine-level seed
          // token must not silently stand in for a preset the operator saved blank.
          const fallbackToken = current === undefined ? (section.token ?? '') : (current.token ?? '')
          let token = typedToken !== '' ? typedToken : fallbackToken
          // First use has no credential and the local token field is read-only.
          // Mint one when the switch is turned on instead of returning a dead end;
          // the operator can copy it from the card immediately.
          if (token === '') {
            token = randomBytes(32).toString('hex')
            section.token = token
          }
          // Bind first; commit the preset only after the listener is real. A
          // failed bind (bad interface, occupied port) must not replace the
          // operator's saved endpoint with a dead one.
          const result = await bridge.configure({ enabled: true, host: target.host, port: target.port, token, persist: false })
          if (!result.ok) {
            section.enabled = result.status.enabled === true
            await saveState(file, state)
            return send(res, 502, { ok: false, error: result.error, code: result.code, field: result.field ?? 'target', ...snapshot() })
          }
          let preset = section.presets.find((entry) => entry.id === section.activeId)
          if (preset === undefined) {
            preset = { id: randomUUID(), name: `${result.status.host}:${result.status.port}`, host: result.status.host, port: result.status.port, token }
            section.presets.push(preset)
            section.activeId = preset.id
          } else {
            preset.host = result.status.host
            preset.port = result.status.port
            preset.token = token
          }
          section.enabled = true
          await saveState(file, state)
          return send(res, 200, { ok: true, ...snapshot() })
        }
        // Remote side: a transport switch, not a listener.
        if (!wanted) {
          await proxy?.apply?.({ enabled: false, address: '', token: '' })
          section.enabled = false
          await saveState(file, state)
          return send(res, 200, { ok: true, ...snapshot() })
        }
        const target = remoteTarget(host, port)
        if (target.error !== undefined) return send(res, 400, { ok: false, error: target.error })
        const checked = remoteToken(typedToken !== '' ? typedToken : (section.presets.find((entry) => entry.id === section.activeId)?.token ?? ''))
        if (checked.error !== undefined) return send(res, 400, { ok: false, error: checked.error })
        if (section.presets.length === 0) {
          section.presets.push({ id: randomUUID(), name: `${target.host}:${target.port}`, host: target.host, port: target.port, token: checked.token })
          section.activeId = section.presets[0].id
        }
        const preset = section.presets.find((entry) => entry.id === section.activeId)
        if (preset === undefined) return send(res, 400, { ok: false, error: 'no active remote preset' })
        preset.host = target.host
        preset.port = target.port
        preset.token = checked.token
        await proxy?.apply?.({ enabled: true, address: target.address, token: checked.token })
        section.enabled = true
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'file-read') {
        if (section.section !== 'local') return send(res, 400, { ok: false, error: 'file-read applies to the local section' })
        const policy = normalizeFileRead({ mode: body.mode, root: body.root })
        const status = bridge.setFileRead(policy)
        state.local.fileRead = normalizeFileRead(status.fileRead)
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'duration') {
        if (section.section !== 'local') return send(res, 400, { ok: false, error: 'duration applies to the local section' })
        const durationMs = normalizeServiceDuration(Number(body.durationMs))
        const status = bridge.setDuration(durationMs)
        state.local.durationMs = normalizeServiceDuration(status.durationMs)
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'rotate') {
        // Rotating only exists for this machine: the token is generated here.
        if (section.section !== 'local') return send(res, 400, { ok: false, error: 'rotate applies to the local section' })
        const fresh = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
        const preset = section.presets.find((entry) => entry.id === section.activeId)
        if (preset !== undefined) preset.token = fresh
        // With no preset there is nowhere to hang the token, but the machine still
        // has an identity: keep it on the section so the card can show and copy it.
        section.token = fresh
        const result = await bridge.configure({ enabled: section.enabled === true, token: fresh, persist: false })
        if (!result.ok) {
          section.enabled = result.status.enabled === true
          await saveState(file, state)
          return send(res, 502, { ok: false, error: result.error, ...snapshot() })
        }
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'select') {
        const preset = section.presets.find((entry) => entry.id === body.id)
        if (preset === undefined) return send(res, 404, { ok: false, error: 'no such preset' })
        // Selecting a preset is a record edit, not a transport action. It only
        // changes which IP/token the form shows; the live bridge/proxy is moved
        // only when the operator throws the switch (toggle) or explicitly saves
        // and applies. This also keeps the persistence callback from writing the
        // selected token into the previously active preset.
        section.activeId = preset.id
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'delete') {
        const at = section.presets.findIndex((entry) => entry.id === body.id)
        if (at === -1) return send(res, 404, { ok: false, error: 'no such preset' })
        const wasActive = section.activeId === body.id
        const removed = section.presets[at]
        // The machine keeps the credential it was serving, so a paired controller
        // is not orphaned by a cleanup.
        if (section.section === 'local' && typeof removed?.token === 'string' && removed.token !== '') {
          section.token = removed.token
        }
        section.presets.splice(at, 1)
        if (wasActive) {
          // Deleting the last preset is allowed: the target becomes "nothing
          // selected" and the switch has to be off, because there is no endpoint
          // to serve or connect to. The form clears on the card side.
          section.enabled = false
          section.activeId = section.presets[0]?.id ?? ''
          if (section.section === 'local') {
            await bridge.configure({ enabled: false, persist: false })
            const keep = section.presets[0]
            if (keep !== undefined) {
              await bridge.configure({ enabled: false, host: keep.host, port: keep.port, token: keep.token, persist: false })
            }
          } else {
            // The record saying "off" is not enough: the proxy owns the live link.
            await proxy?.apply?.({ enabled: false, address: '', token: '' })
          }
        }
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }

      if (action === 'save') {
        if (section.section === 'local') {
          const target = localTarget(host, port)
          if (target.error !== undefined) {
            return send(res, 400, { ok: false, error: target.error, code: target.code, field: 'target' })
          }
          // Saving is not a binding action: the form's target is validated, but an
          // empty token is allowed to be stored. The switch will require a token
          // when it actually starts the listener.
          const token = typedToken !== '' ? typedToken : (section.token ?? '')
          const rawName = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
          const name = rawName === '' ? `${target.host}:${target.port}` : rawName
          const existing = section.presets.find((entry) => entry.name === name)
          if (existing !== undefined) {
            existing.host = target.host
            existing.port = target.port
            existing.token = token
            section.activeId = existing.id
          } else {
            const created = { id: randomUUID(), name, host: target.host, port: target.port, token }
            section.presets.push(created)
            section.activeId = created.id
          }
          if (token !== '') section.token = token
          // Save only writes the record. It does not bind, move the live
          // listener, or check the port; those belong to the switch.
          await saveState(file, state)
          return send(res, 200, { ok: true, ...snapshot() })
        }
        const target = remoteTarget(host, port)
        if (target.error !== undefined) return send(res, 400, { ok: false, error: target.error, code: 'bad-host', field: 'target' })
        // An empty token is allowed in a saved preset; the switch requires it.
        let remoteTokenValue = ''
        if (typedToken !== '') {
          const checked = remoteToken(typedToken)
          if (checked.error !== undefined) return send(res, 400, { ok: false, error: checked.error, code: 'bad-token', field: 'token' })
          remoteTokenValue = checked.token
        }
        const rawName = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
        const name = rawName === '' ? `${target.host}:${target.port}` : rawName
        const existing = section.presets.find((entry) => entry.name === name)
        if (existing !== undefined) {
          existing.host = target.host
          existing.port = target.port
          existing.token = remoteTokenValue
          section.activeId = existing.id
        } else {
          const created = { id: randomUUID(), name, host: target.host, port: target.port, token: remoteTokenValue }
          section.presets.push(created)
          section.activeId = created.id
        }
        // Save is record-only; the remote switch applies the preset.
        await saveState(file, state)
        return send(res, 200, { ok: true, ...snapshot() })
      }
      return send(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(
    () => server.register({ kind: 'prefix', path: `${basePath}/state`, handler: handle }),
    'remote-control: state routes',
  )
}
function installPageHook(server, ctx, secret, basePath = BASE_PATH) {
  if (typeof server?.tapIndex !== 'function') return
  const tag = `<script>${pageHookScript(secret, basePath)}</script>`
  // Browser surface: rewrite the rendered index. `tapIndex` returns a disposer;
  // leaving it registered after this row unloads would keep injecting a hook
  // whose routes no longer exist.
  const disposeTap = server.tapIndex((html) => (html.includes(HOOK_MARK) ? html : html.replace(/<head([^>]*)>/i, `<head$1>${tag}`)))
  if (typeof disposeTap === 'function') {
    ctx.effect(() => disposeTap, 'remote-control: index tap')
  }
  // Desktop surface: hand the same script to the page-side interpreter.
  if (typeof ctx?.on === 'function') {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      table.push({ kind: 'script', placement: 'head', text: pageHookScript(secret, basePath) })
    })
  }
}

/**
 * Resolve the settings file inside the active Harness home.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {string} absolute path of the settings JSON file.
 */
/**
 * Path of the shared state record.
 *
 * The controlling half used to keep its own file; both directions now share one
 * record so the card has a single write that covers whichever side it edits.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {string} absolute path of the state file.
 */
function settingsFile(ctx) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.cwd(), '.dsh')
  return join(home, 'remote-control.json')
}


