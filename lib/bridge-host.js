/**
 * Being-controlled host half — expose this Host's `typertGateway` over an
 * authenticated WebSocket.
 *
 * The Host's browser transport (`/api` on `dsh-host-webserver`) admits a set of
 * privileged Remote methods only for loopback callers, and re-runs that check
 * against an empty trusted-host list. This plugin sidesteps that fence by
 * running in the same process as the Host Remote Gateway: it creates a `Peer`
 * with `ctx.connection.createPeer()` and dispatches with
 * `ctx.typertGateway.invoke()` / `.stream()`, so a call never crosses a socket
 * on the Host side.
 *
 * The listener is inert until `enabled` is true and a `token` is configured.
 * @module dsh-remote-control/lib/bridge-host
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { isUnspecifiedAddress } from './ip.js'
import { ByteQueue, frameSize as measureFrame } from './frames.js'
import { isAbsolutePath } from './paths.js'
import { decideFileRead, normalizeFileRead, normalizeServiceDuration } from './file-policy.js'

/**
 * Services this row requires. `typertGateway` is the Host Remote Gateway (the
 * in-process dispatcher), `connection` supplies the Peer constructor, and
 * `webServer` is taken only so the row composes next to the browser surface and
 * can reuse its compression/protocol facts.
 */
/** Wire protocol revision carried in the `hello` frame. */
/**
 * Append one diagnostic line when `DSH_REMOTE_CONTROL_TRACE=1`.
 *
 * The desktop app runs with stdout/stderr on `/dev/null`, so stdout/stderr output
 * is lost; a file under the Harness home is the only channel left.
 * @param {string} message - line to record.
 */
const TRACE_ENABLED = process.env.DSH_REMOTE_CONTROL_TRACE === '1'
let traceFileReady = false
function hostTrace(message) {
  // Diagnostics are opt-in: the old always-on writer executed three synchronous
  // appends for every event and grew without bound.
  if (!TRACE_ENABLED) return
  const line = `${new Date().toISOString()} host ${message}\n`
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

const PROTOCOL = 1

/** WebSocket upgrade path; everything else on the port answers 404. */
const WS_PATH = '/bridge'

/** Largest port number a bind attempt may use. */
const MAX_PORT = 65535

/** Management routes used by the sidebar "远程设备" panel (loopback only). */
const STATUS_PATH = '/rbr/status'
const TOGGLE_PATH = '/rbr/toggle'
const TOKEN_PATH = '/rbr/token'
const PORT_PATH = '/rbr/port'

/** Frame kinds a client may send. */
const CLIENT_FRAMES = new Set(['invoke', 'stream', 'stream-cancel', 'subscribe', 'ping', 'file-read', 'file-read-check'])

/** Largest `id`/`target` string we echo back. */
const MAX_ID_LENGTH = 128
/**
 * Largest per-socket write buffer before a slow controller is dropped.
 *
 * One 64 MB byte result is split into 256 KB attachments and base64-encoded, so a
 * legitimate response can enqueue ~85 MB before the reader drains it. A smaller
 * bound (8 MB was tried) closed the bridge on large PDFs instead of only on a
 * genuinely stuck peer.
 */
const MAX_SOCKET_BUFFER_BYTES = 96 * 1024 * 1024

/** WebSocket opcode: text frame. */
const OPCODE_TEXT = 0x1
/** WebSocket opcode: connection close. */
const OPCODE_CLOSE = 0x8
/** WebSocket opcode: ping. */
const OPCODE_PING = 0x9
/** WebSocket opcode: pong. */
const OPCODE_PONG = 0xa

/** WebSocket close code used when a client fails authentication mid-flight. */
const CLOSE_POLICY = 1008

/** Fail closed when nobody answers a forwarded prompt. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000
/** Grace after the last controller leaves before pending prompts are settled. */
const DEFAULT_APPROVAL_GRACE_MS = 10_000

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024
const DEFAULT_PORT = 7400

/** Composition config; every field is validated before the listener starts. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.natural().min(1).max(65535).default(DEFAULT_PORT),
  token: z.string().default(''),
  principal: z.union([z.const('owner'), z.const('guest')]).default('owner'),
  allowStreams: z.boolean().default(true),
  maxRequestBytes: z.natural().min(1024).default(DEFAULT_MAX_REQUEST_BYTES),
})

/** Headers that describe *this* hop only and must not be relayed to upstream. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Encode one JSON value as a WebSocket text frame.
 * @param payload - JSON-serializable value.
 * @param masked - whether the frame is client-to-server (ours are never masked).
 * @returns the complete frame buffer.
 */
/** Endpoints whose result shape has already been traced once. */
/**
 * Size of one `file-read` chunk.
 *
 * Large enough that a 6 MB archive needs only a handful of round trips, small enough
 * that one chunk stays a single WebSocket frame and never doubles memory.
 */
const FILE_CHUNK_BYTES = 256 * 1024

/**
 * Read one chunk of a file from this Host's disk.
 *
 * Text is returned as a JSON-safe `data` string; anything else is base64, so the
 * frame stays inside the bridge's JSON protocol without a second binary channel.
 * @param {{ path?: string, offset?: number, length?: number }} args - the request.
 * @param {AbortSignal} signal - cancellation for the connection.
 * @returns {Promise<{ data: string, bytes: number, eof: boolean, encoding: string }>} the chunk.
 */
async function readFileChunk(args, signal) {
  const path = typeof args?.path === 'string' ? args.path : ''
  if (path === '' || !isAbsolutePath(path)) {
    throw Object.assign(new Error('file-read needs an absolute path'), { code: 'bad-request' })
  }
  const info = await stat(path)
  if (!info.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'bad-request' })
  const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 0
  const length = Number.isInteger(args?.length) && args.length > 0 ? Math.min(args.length, FILE_CHUNK_BYTES) : FILE_CHUNK_BYTES
  const remaining = Math.max(0, info.size - offset)
  const want = Math.min(length, remaining)
  if (want === 0) return { data: '', bytes: info.size, eof: true, encoding: 'base64' }
  // O_NOFOLLOW rejects a symlink at the final component; the pre-stat and the
  // opened-file identity check reject a swap between policy resolution and open.
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw Object.assign(new Error('the file changed while it was being opened'), { code: 'remote-control/file-changed' })
    }
    const buffer = Buffer.allocUnsafe(want)
    const { bytesRead } = await handle.read(buffer, 0, want, offset)
    signal.throwIfAborted()
    const slice = buffer.subarray(0, bytesRead)
    return {
      data: slice.toString('base64'),
      bytes: info.size,
      eof: offset + bytesRead >= info.size,
      encoding: 'base64',
    }
  } finally {
    await handle.close()
  }
}

/**
 * Bytes per `result-bytes` frame.
 *
 * Base64 expands by a third, so 256 KB becomes a ~350 KB frame: comfortably under a
 * WebSocket limit and small enough that one stuck frame cannot stall the session.
 */
const RESULT_CHUNK_BYTES = 256 * 1024

/**
 * Replace every `Uint8Array` in a result with a placeholder and emit its bytes apart.
 *
 * Mirrors what the Host's own Gateway does for byte results: the JSON keeps the shape
 * (paths, offsets, lengths) and the payload travels as attachments.
 * The chunks are yielded lazily: a 64 MB result must not first materialize a
 * second 85 MB array of base64 strings on the Host.
 * @param {unknown} value - a Gateway result.
 * @returns {{ json: unknown, chunks: Generator<{ index: number, seq: number, total: number, data: string }> }} the placeholder tree and a lazy chunk stream.
 */
function encodeByteResults(value) {
  // Slots are numbered independently of the chunk list: a 6 MB array is many chunks
  // but one slot, so deriving the slot from `chunks.length` would give every chunk of
  // that array the same index and the reader would keep overwriting one entry.
  let nextSlot = 0
  const walk = (node, depth) => {
    if (depth > 12) return node
    if (node instanceof Uint8Array) {
      return { __bytes: nextSlot++, length: node.length }
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (node === null || typeof node !== 'object') return node
    if (ArrayBuffer.isView(node)) {
      return walk(new Uint8Array(node.buffer, node.byteOffset, node.byteLength), depth)
    }
    const out = {}
    for (const [key, item] of Object.entries(node)) out[key] = walk(item, depth + 1)
    return out
  }
  const chunks = function* () {
    let slot = 0
    function* emit(node, depth) {
      if (depth > 12) return
      if (node instanceof Uint8Array) {
        const at = slot++
        const total = Math.max(1, Math.ceil(node.length / RESULT_CHUNK_BYTES))
        // An empty array still needs one entry so the reader knows the slot existed.
        if (node.length === 0) {
          yield { index: at, seq: 0, total, data: '' }
          return
        }
        let seq = 0
        for (let offset = 0; offset < node.length; offset += RESULT_CHUNK_BYTES) {
          yield {
            index: at,
            seq: seq++,
            total,
            data: Buffer.from(node.subarray(offset, offset + RESULT_CHUNK_BYTES)).toString('base64'),
          }
        }
        return
      }
      if (Array.isArray(node)) {
        for (const item of node) yield* emit(item, depth + 1)
        return
      }
      if (node === null || typeof node !== 'object') return
      if (ArrayBuffer.isView(node)) {
        yield* emit(new Uint8Array(node.buffer, node.byteOffset, node.byteLength), depth)
        return
      }
      for (const item of Object.values(node)) yield* emit(item, depth + 1)
    }
    yield* emit(value, 0)
  }
  return { json: walk(value, 0), chunks: chunks() }
}

const PROBED = new Set()

/**
 * Describe a result value's shape without serializing its payload.
 * @param {unknown} value - the value returned by the Gateway.
 * @param {number} [depth] - recursion guard.
 * @returns {string} a short structural description.
 */
function describeShape(value, depth = 0) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Uint8Array) return `Uint8Array(${value.byteLength})`
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`
  if (Array.isArray(value)) {
    // Walk the first element to whatever depth the byte value hides at: an
    // attachment list nests `bytes` three levels down, and stopping early is what
    // makes a byte-carrying result look byte-free.
    return `Array(${value.length})` + (depth < 6 && value.length ? `[0]=${describeShape(value[0], depth + 1)}` : '')
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (depth >= 6) return `{${keys.slice(0, 6).join(',')}}`
    return `{${keys.slice(0, 8).map((k) => `${k}:${describeShape(value[k], depth + 1)}`).join(',')}}`
  }
  return typeof value
}

function encodeFrame(payload, masked = false) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | OPCODE_TEXT
  if (!masked) return Buffer.concat([header, body])
  // A masked frame carries a random 4-byte key and an XOR-masked body. The old
  // branch set the mask bit but sent the body unmasked, which is invalid if a
  // caller ever asks for it; mask honestly or not at all.
  header[1] |= 0x80
  const key = crypto.randomBytes(4)
  const maskedBody = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 1) maskedBody[index] = body[index] ^ key[index % 4]
  return Buffer.concat([header, key, maskedBody])
}

/** Encode one unmasked server control frame (pong/close/ping). */
function encodeControl(opcode, payload) {
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
 * Encode a close frame with a status code.
 * @param code - WebSocket close status code.
 * @returns the frame buffer.
 */
function encodeClose(code) {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(code, 0)
  const header = Buffer.from([0x80 | OPCODE_CLOSE, body.length])
  return Buffer.concat([header, body])
}

/**
 * Whether an IPv4/IPv6 literal is an unspecified (wildcard) address.
 * @param host - bind address text.
 * @returns true for `0.0.0.0`, `::`, and their mapped spellings.
 */
function isWildcard(host) {
  return isUnspecifiedAddress(host)
}

/**
 * Validate an address supplied at runtime from the panel.
 *
 * Only bare IP literals are accepted: a hostname would need DNS, which can
 * resolve differently over time and would make the bound address unpredictable.
 * Wildcards stay rejected for the same reason the config rejects them — one
 * interface would expose this Host's Remote surface to whatever network is
 * attached.
 * @param value - JSON value from the request body.
 * @returns the address text, or an Error describing why it was rejected.
 */
export function parseRequestedHost(value) {
  if (typeof value !== 'string' || value.trim() === '') return new Error('host must be a non-empty string')
  const host = value.trim()
  if (isWildcard(host)) {
    return new Error(
      `host ${JSON.stringify(host)} is an unspecified (wildcard) address; bind one concrete IPv4 or IPv6 ` +
        'address instead, for example 127.0.0.1 or this machine\'s LAN address',
    )
  }
  if (!isIP(host.includes('%') ? host.slice(0, host.indexOf('%')) : host)) {
    return new Error(
      `host ${JSON.stringify(host)} is not an IP literal; use a bare IPv4 or IPv6 address such as ` +
        '127.0.0.1, 192.168.1.10, or fd7a:115c:a1e0::1',
    )
  }
  return host
}

/**
 * Validate a port supplied at runtime from the panel.
 * @param value - JSON value from the request body.
 * @returns the port, or an Error describing why it was rejected.
 */
export function parseRequestedPort(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_PORT) {
    return new Error(`port must be an integer between 1 and ${MAX_PORT}`)
  }
  if (numeric < 1024) {
    return new Error(
      `port ${numeric} is privileged; only a root process can bind below 1024. Choose 1024 or higher`,
    )
  }
  return numeric
}

/**
 * Mint a fresh credential in the same alphabet DSH uses for its own tokens:
 * base64url over 32 random bytes, so the value is legal both in an
 * `Authorization` header and in the `dsh-bridge.<token>` subprotocol.
 * @returns the new token text.
 */
function mintToken() {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Constant-time token comparison that tolerates unequal lengths.
 * @param actual - token presented by the client.
 * @param expected - configured token.
 * @returns whether they match.
 */
function tokenMatches(actual, expected) {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) {
    // Still consume a comparison so the timing does not leak the length.
    timingSafeEqual(right, right)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Extract the bearer token from an upgrade request.
 * WebSocket clients cannot set arbitrary headers from a browser, so the token is
 * accepted either as `Authorization: Bearer <t>` or as the subprotocol
 * `dsh-bridge.<t>` — the same split `dsh-mobile-v1` uses.
 * @param req - the upgrade request.
 * @returns the presented token, or undefined.
 */
function presentedToken(req) {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    if (match) return match[1]
  }
  const protocols = req.headers['sec-websocket-protocol']
  if (typeof protocols === 'string') {
    for (const entry of protocols.split(',')) {
      const value = entry.trim()
      if (value.startsWith('dsh-bridge.')) return value.slice('dsh-bridge.'.length)
    }
  }
  return undefined
}

/**
 * Decode one unmasked client text frame's payload.
 * @param buffer - raw frame bytes including the header.
 * @param maxBytes - largest payload accepted.
 * @returns `{ opcode, payload }` or `{ error }`.
 */
function decodeFrame(buffer, maxBytes) {
  if (buffer.length < 2) return { error: 'truncated frame' }
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return { error: 'truncated frame' }
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return { error: 'truncated frame' }
    const wide = buffer.readBigUInt64BE(2)
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return { error: 'frame too large' }
    length = Number(wide)
    offset = 10
  }
  if (length > maxBytes) return { error: 'frame exceeds maxRequestBytes' }
  if (!masked) return { error: 'client frames must be masked' }
  if (buffer.length < offset + 4 + length) return { error: 'truncated frame' }
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[offset + index] ^ mask[index % 4]
  }
  return { opcode, fin, payload }
}

/**
 * Serialize an unknown thrown value into a wire error.
 * @param error - the thrown value.
 * @returns `{ ok: false, code, message }`.
 */
function wireError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'bridge/internal'
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code, message }
}

/**
 * Validate the plugin config before anything binds.
 * @param config - composed config.
 * @returns the normalized config.
 * @throws when the config cannot be honored.
 */
function resolveConfig(config) {
  const resolved = {
    enabled: config?.enabled === true,
    host: typeof config?.host === 'string' && config.host.trim() !== '' ? config.host.trim() : '127.0.0.1',
    port: Number.isInteger(config?.port) ? config.port : DEFAULT_PORT,
    token: typeof config?.token === 'string' ? config.token.trim() : '',
    principal: config?.principal === 'guest' ? 'guest' : 'owner',
    allowStreams: config?.allowStreams !== false,
    maxRequestBytes: Number.isInteger(config?.maxRequestBytes) ? config.maxRequestBytes : DEFAULT_MAX_REQUEST_BYTES,
    fileRead: normalizeFileRead(config?.fileRead),
    durationMs: normalizeServiceDuration(config?.durationMs),
  }
  if (isWildcard(resolved.host)) {
    throw new Error(
      `remote-bridge: host ${JSON.stringify(resolved.host)} is an unspecified (wildcard) address, which is not supported: ` +
        'binding every interface would expose this Host\'s Remote surface to whatever network is attached; ' +
        'bind one concrete IPv4 or IPv6 address instead',
    )
  }
  // Ports below 1024 are privileged on macOS and Linux: a non-root Host cannot
  // bind them. Port 0 is the one exception — it asks the OS for a free
  // ephemeral port, which is never privileged.
  if (resolved.port !== 0 && resolved.port < 1024) {
    throw new Error(
      `remote-bridge: port ${resolved.port} is privileged; only a root process can bind below 1024 and the ` +
        'Choose a base port of 1024 or higher (7400 is the default)',
    )
  }
  return resolved
}

/**
 * Mount the being-controlled listener and its loopback management routes.
 *
 * The parent plugin owns the Cordis row, so this module no longer carries a
 * plugin identity of its own: it is called once from the merged entry, which
 * needs a handle on the same state the status/toggle/token routes expose.
 * @param ctx - Host plugin context (must supply typertGateway and connection).
 * @param config - resolved bridge config.
 * @returns the control surface the browser half talks to.
 */
export function mountBridge(ctx, config) {
  const resolved = resolveConfig(config)
  /**
   * Optional owner/capability authorizer supplied by the merged entry. The
   * management routes are a legacy surface; when the parent does not supply an
   * authorizer they keep their historical loopback+marker guard.
   * @type {((req: import('node:http').IncomingMessage, url: URL) => { ok: boolean, status?: number, reason?: string }) | undefined}
   */
  const authorize = typeof config?.authorize === 'function' ? config.authorize : undefined
  /** Time a controller gets to reconnect before parked prompts are settled. */
  const approvalGraceMs = Number.isInteger(config?.approvalGraceMs) && config.approvalGraceMs >= 0
    ? config.approvalGraceMs
    : DEFAULT_APPROVAL_GRACE_MS
  /** Unique per process so a restarted peer cannot reuse an event id. */
  const instanceId = crypto.randomUUID().replaceAll('-', '').slice(0, 12)

  const gateway = ctx.typertGateway
  if (typeof gateway?.invoke !== 'function' || typeof gateway?.stream !== 'function') {
    throw new Error('remote-bridge requires the Host Remote Gateway service (typertGateway)')
  }
  if (typeof ctx.connection?.createPeer !== 'function') {
    throw new Error('remote-bridge requires DSH 0.2.1 or later with Connection.createPeer')
  }

  const log = (...parts) => {
    if (TRACE_ENABLED) ctx.logger?.('remote-bridge')?.info?.(...parts)
  }

  // ── Mutable runtime state ────────────────────────────────────────────────
  // `enabled` is the config default; the management routes flip it at runtime
  // for this process only, which is what the "远程设备" switch drives. The
  // persisted choice lives in the profile patch, not in this variable.
  let enabled = resolved.enabled
  let listener = undefined
  /** Promise of the bind currently in flight; makes start idempotent. */
  let starting
  /** Incremented by every stop so a late bind can recognise it is stale. */
  let generation = 0
  /** Set before the row is disposed; a late bind must never re-attach. */
  let disposing = false
  /** Every server this bridge ever created, including a bind still in flight. */
  const servers = new Set()
  let listenError = ''
  let listenErrorCode = ''
  /**
   * Persistence hook supplied by the parent plugin. The bridge owns its runtime
   * state (listener, peers) but not the record of what the operator chose, so
   * every mutation reports the new values here and the caller writes them.
   * @type {((next: { enabled: boolean, host: string, port: number, token: string }) => void) | undefined}
   */
  let onChange = typeof config?.onChange === 'function' ? config.onChange : undefined
  const notify = () => onChange?.({
    enabled,
    host: requestedHost,
    port: requestedPort,
    token,
    fileRead: { ...fileReadPolicy },
    durationMs: serviceDurationMs,
  })
  /**
   * Address the operator asked for. Starts from the config value and can be
   * changed at runtime from the panel; a change re-binds the listener. A
   * literal that is not currently on this machine fails with EADDRNOTAVAIL,
   * which is reported rather than hidden.
   */
  let requestedHost = resolved.host
  /**
   * Port the operator asked for. Starts from the config value and can be
   * changed at runtime from the panel; a change re-binds the listener.
   */
  let requestedPort = resolved.port
  /** Address the listener actually bound. */
  let boundHost = resolved.host
  /** Port the listener actually bound (the requested port on success). */
  let boundPort = resolved.port
  /**
   * The credential clients must present. Starts from the config value and can
   * be rotated at runtime from the panel; a rotation rebinds nothing, it only
   * changes what the next upgrade must present.
   */
  let token = resolved.token
  /** Remote download policy, persisted by the caller. */
  let fileReadPolicy = normalizeFileRead(resolved.fileRead)
  /** Service lifetime in milliseconds; 0 means until manual close/exit. */
  let serviceDurationMs = normalizeServiceDuration(resolved.durationMs)
  /** Wall-clock expiry for this listener session, or 0 when none. */
  let serviceExpiresAt = 0
  /** Host-side lifetime timer. */
  let serviceTimer
  const peers = new Set()
  /**
   * Every accepted socket, so unloading the plugin also drops connected controllers.
   *
   * `peers` only holds the Gateway identities; closing the HTTP server stops new
   * upgrades but leaves established sockets open, and a controller would keep
   * receiving pushes from a bridge that no longer exists.
   */
  const liveSockets = new Set()

  /**
   * Live connections that accept pushed events, keyed by their writer.
   *
   * A Session's running state is announced by the Host as the official
   * `api-session/status` event, which lives only inside this process. The bridge
   * cannot fetch it through `typertGateway`, so the sender below subscribes to the
   * event and pushes it to every connected peer as a bus notification — the same
   * shape the page's own `$events` stream carries.
   * @type {Set<(event: { sessionId: string, running: boolean }) => void>}
   */
  const statusSinks = new Set()

  /**
   * Whether a token is configured at all. The listener refuses to bind without
   * one, because an unauthenticated Remote surface is a full Host takeover.
   * @returns true when a credential is present.
   */
  const configured = () => token !== ''

  /**
   * Report the surface the panel renders.
   * @returns status object.
   */
  const status = () => ({
    enabled,
    configured: configured(),
    listening: listener !== undefined,
    /** True while a bind is in flight; the panel can show "starting". */
    starting: starting !== undefined,
    disposing,
    /** Address actually bound; differs from `requestedHost` before the first bind. */
    host: boundHost,
    /** Address the operator asked for (the panel field). */
    requestedHost,
    port: boundPort,
    /** Requested bind port; kept in the status for compatibility. */
    basePort: requestedPort,
    /** Always false now: an occupied port is an error, not a scan. */
    portShifted: listener !== undefined && boundPort !== requestedPort,
    /** Whether the bound address differs from the requested one. */
    hostShifted: listener !== undefined && boundHost !== requestedHost,
    /**
     * The current credential, so the operator can copy it into a client. It is
     * already required to be readable to edit the profile; the route that
     * returns this is loopback-only.
     */
    token,
    clients: peers.size,
    principal: resolved.principal,
    streams: resolved.allowStreams,
    fileRead: { ...fileReadPolicy },
    durationMs: serviceDurationMs,
    expiresAt: serviceExpiresAt === 0 ? null : serviceExpiresAt,
    error: listenError === '' ? null : listenError,
  })

  /**
   * Drop every live controller. Used by stop, rotation and unload.
   *
   * Closing the HTTP server only stops new upgrades; a controller that is
   * already connected would otherwise keep receiving pushes from a bridge that
   * no longer exists. `peers` holds Gateway identities, `liveSockets` holds the
   * actual transport, so both must be released.
   * @param {number} code - WebSocket close code.
   */
  function dropSockets(code = 1008) {
    for (const peer of peers) void peer.dispose?.()
    peers.clear()
    for (const socket of liveSockets) {
      try {
        if (!socket.destroyed) socket.end(encodeClose(code))
      } catch {}
      try {
        if (!socket.destroyed) socket.destroy()
      } catch {}
    }
    liveSockets.clear()
    statusSinks.clear()
    approvalSinks.clear()
    if (enabled === true) scheduleApprovalGrace()
  }

  /**
   * Close one server and wait until its listening handle is really gone.
   *
   * `server.close()` is asynchronous and can be held open by an idle keep-alive
   * connection. The callback is the only proof the port has been released, so
   * every stop path awaits it before a new bind starts.
   * @param {import('node:http').Server} server - server to close.
   * @returns {Promise<void>} resolves when the handle is closed.
   */
  async function closeServer(server) {
    servers.delete(server)
    if (listener === server) listener = undefined
    await new Promise((resolve) => {
      let settled = false
      let timer
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      try {
        // Node 18.2+: destroy sockets that would otherwise keep close pending.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        server.close(finish)
      } catch {
        finish()
      }
      timer = setTimeout(() => {
        try { server.closeAllConnections?.() } catch {}
        finish()
      }, 1500)
      timer.unref?.()
    })
  }

  /** Stop the lifetime timer and forget this session's expiry. */
  function clearServiceTimer() {
    if (serviceTimer !== undefined) clearTimeout(serviceTimer)
    serviceTimer = undefined
    serviceExpiresAt = 0
  }

  /** Start the lifetime timer from the moment the listener is actually bound. */
  function startServiceTimer() {
    clearServiceTimer()
    if (!enabled || listener === undefined || serviceDurationMs <= 0) return
    serviceExpiresAt = Date.now() + serviceDurationMs
    serviceTimer = setTimeout(() => {
      serviceTimer = undefined
      serviceExpiresAt = 0
      void configure({ enabled: false }).catch((error) => {
        log(`service lifetime expiry failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, serviceDurationMs)
    serviceTimer.unref?.()
  }

  /**
   * Update the remote download policy without changing the transport.
   * @param {{mode?: string, root?: string|null}} next - new policy.
   * @returns {object} live status.
   */
  function setFileRead(next) {
    fileReadPolicy = normalizeFileRead(next)
    notify()
    return status()
  }

  /**
   * Change the listener lifetime. A running listener restarts its countdown
   * from now; a stopped one uses the value on its next successful bind.
   * @param {number} next - milliseconds, 0 for permanent.
   * @returns {object} live status.
   */
  function setDuration(next) {
    serviceDurationMs = normalizeServiceDuration(next)
    if (enabled && listener !== undefined) startServiceTimer()
    notify()
    return status()
  }

  /**
   * Stop the listener and drop every live connection.
   *
   * The generation bump makes a bind that is still in flight stale: when it
   * settles it closes its own server instead of assigning `listener`.
   * @returns {Promise<void>} resolves after every server handle is closed.
   */
  async function stopListener() {
    generation += 1
    clearServiceTimer()
    const pending = starting
    listener = undefined
    dropSockets(1000)
    // Wait for a bind that is already in flight; otherwise it could attach after
    // this stop and leave an orphan port behind.
    if (pending !== undefined) {
      try { await pending } catch {}
    }
    const closing = [...servers]
    servers.clear()
    await Promise.all(closing.map((server) => closeServer(server)))
    if (enabled !== true) {
      listenError = ''
      listenErrorCode = ''
      // The switch is off: no controller can answer a prompt that was parked
      // for this bridge. Settle it immediately instead of waiting for timeout.
      cancelApprovalGrace()
      settlePending('bridge stopped')
    }
  }

  /**
   * Try to bind one candidate port on the configured host.
   * @param {number} port - the port to attempt.
   * @param {string} host - validated bind address.
   * @returns {Promise<import('node:http').Server | Error>} the bound server, or the bind error.
   */
  async function bindOnce(port, host) {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not-found' }))
    })
    // Unauthenticated slow headers must not pin sockets/FDs forever. The bridge
    // only serves one WebSocket endpoint, so conservative limits are safe.
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.keepAliveTimeout = 5_000
    server.maxConnections = 128
    servers.add(server)
    server.on('upgrade', onUpgrade)
    // A malformed HTTP request can make Node write a 400 to a socket the peer
    // already reset. Without this listener that write is an uncaught EPIPE.
    server.on('clientError', (_error, socket) => {
      try { socket.destroy() } catch {}
    })
    const failure = await new Promise((resolve) => {
      server.once('error', (error) => resolve(error))
      server.listen(port, host, () => resolve(undefined))
    })
    if (failure !== undefined) {
      servers.delete(server)
      try { server.close() } catch {}
      return failure
    }
    return server
  }

  /**
   * Start the listener once. Idempotent.
   *
   * The requested port is exact. If it is occupied, bind fails and the status
   * route reports `EADDRINUSE`; it is never silently moved to another port,
   * because the remote side would keep using the old address.
   *
   * The host/port are validated here as well as in `configure()`, so a caller
   * that reaches this function directly cannot bind a wildcard or a privileged
   * port. The `generation` check is the single-flight guard: a stop (or a
   * newer start) invalidates a bind that is still in flight.
   * @returns {Promise<void>} settles once bound or once every candidate failed.
   */
  async function startListener() {
    if (disposing || listener !== undefined || !enabled || !configured()) return
    if (starting !== undefined) return starting
    const checkedHost = parseRequestedHost(requestedHost)
    if (checkedHost instanceof Error) {
      listenError = checkedHost.message
      enabled = false
      return
    }
    const checkedPort = parseRequestedPort(requestedPort)
    if (checkedPort instanceof Error) {
      listenError = checkedPort.message
      enabled = false
      return
    }
    const host = checkedHost
    const port = checkedPort
    const gen = ++generation
    const task = (async () => {
      if (gen !== generation || !enabled || disposing) return
      const outcome = await bindOnce(port, host)
      if (outcome instanceof Error) {
        if (gen !== generation || !enabled || disposing) return
        listenError = outcome.message
        listenErrorCode = typeof outcome.code === 'string' ? outcome.code : ''
        log(`listener failed: ${listenError}`)
        return
      }
      // A stop (or a newer start) may have happened while this bind was in
      // flight: the listener must not come back up after that stop.
      if (gen !== generation || !enabled || disposing) {
        await closeServer(outcome)
        return
      }
      const address = outcome.address()
      if (typeof address === 'object' && address !== null) {
        boundPort = address.port
        boundHost = address.address
      }
      listener = outcome
      listenError = ''
      listenErrorCode = ''
      startServiceTimer()
      hostTrace(`listener up ${boundHost}:${boundPort}`)
      log(`listening on ${boundHost}:${boundPort}${WS_PATH} (principal=${resolved.principal}, streams=${resolved.allowStreams})`)
    })()
    starting = task
    try {
      await task
    } finally {
      if (starting === task) starting = undefined
    }
  }

  /**
   * Apply a bind target and a switch in one serialized transaction.
   *
   * This is the only mutation path used by the card. It validates before it
   * changes anything, stops the previous listener, waits for the port to be
   * released, then binds once. A failed bind leaves the switch off instead of
   * reporting a success the operator cannot use.
   * @param {{ enabled?: boolean, host?: string, port?: number, token?: string }} next - target values; omitted fields stay as they are.
   * @returns {Promise<{ ok: boolean, error?: string, status: object }>} outcome and live status.
   */
  /**
   * Serialize configuration transitions.
   *
   * Two tabs (or a retry) can POST "enable" at the same time. Without this
   * queue the second call stops the first call's in-flight bind, and both can
   * end up reporting failure with no listener. One transition at a time keeps
   * start/stop and the switch record deterministic.
   */
  let configureQueue = Promise.resolve()
  function configure(next = {}) {
    const run = configureQueue.then(
      () => configureOnce(next),
      () => configureOnce(next),
    )
    configureQueue = run.catch(() => {})
    return run
  }

  async function configureOnce(next = {}) {
    if (disposing) return { ok: false, error: 'the remote bridge is unloading', status: status() }
    const shouldNotify = next.persist !== false
    const targetEnabled = next.enabled === undefined ? enabled : next.enabled === true
    const host = next.host === undefined ? requestedHost : next.host
    const port = next.port === undefined ? requestedPort : next.port
    const nextToken = next.token === undefined ? token : next.token
    if (!targetEnabled) {
      // Closing must work even when the remembered target is no longer valid
      // (for example the last preset was deleted). A valid target submitted with
      // the close is still adopted for the next bind; validation only gates the
      // bind itself.
      if (next.host !== undefined || next.port !== undefined) {
        const nextHost = parseRequestedHost(host)
        const nextPort = parseRequestedPort(port)
        if (!(nextHost instanceof Error) && !(nextPort instanceof Error)) {
          requestedHost = nextHost
          requestedPort = nextPort
        }
      }
      if (next.token !== undefined) token = nextToken
      enabled = false
      await stopListener()
      if (shouldNotify) notify()
      return { ok: true, status: status() }
    }
    const checkedHost = parseRequestedHost(host)
    if (checkedHost instanceof Error) {
      listenError = checkedHost.message
      listenErrorCode = 'bad-host'
      return { ok: false, error: checkedHost.message, code: 'bad-host', field: 'target', status: status() }
    }
    const checkedPort = parseRequestedPort(port)
    if (checkedPort instanceof Error) {
      listenError = checkedPort.message
      listenErrorCode = 'bad-port'
      return { ok: false, error: checkedPort.message, code: 'bad-port', field: 'target', status: status() }
    }
    if (nextToken === '') {
      return { ok: false, error: 'a token is required to enable the bridge', code: 'bad-token', field: 'token', status: status() }
    }
    const changed = checkedHost !== requestedHost || checkedPort !== requestedPort || nextToken !== token
    requestedHost = checkedHost
    requestedPort = checkedPort
    token = nextToken
    enabled = targetEnabled
    // Restart only when the target changed or nothing is listening. A repeated
    // "on" from two tabs must not create a second server.
    if (changed || listener === undefined) {
      await stopListener()
      await startListener()
    }
    if (listener === undefined) {
      enabled = false
      const error = listenError === '' ? 'the bridge could not bind its port' : listenError
      const code = listenErrorCode === '' ? 'bind-failed' : listenErrorCode
      await stopListener()
      listenError = error
      listenErrorCode = code
      if (shouldNotify) notify()
      return { ok: false, error, code, field: 'target', status: status() }
    }
    if (shouldNotify) notify()
    return { ok: true, status: status() }
  }

  /**
   * Admit one WebSocket upgrade on the bridge listener.
   * @param req - the upgrade request.
   * @param socket - the raw TCP socket.
   * @param head - bytes already read past the handshake.
   */
  function onUpgrade(req, socket, head) {
    // Every rejection below writes a response to a peer that may already have
    // reset the connection. Attach the error handler before the first write so
    // that write cannot become an uncaught 'error' event and kill the Host.
    socket.on('error', () => {
      try { socket.destroy() } catch {}
    })
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://bridge.invalid').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (typeof req.headers['sec-websocket-key'] !== 'string' || req.headers['sec-websocket-key'] === '') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const presented = presentedToken(req)
    if (presented === undefined || presented === '' || !tokenMatches(presented, token)) {
      log('rejected upgrade: missing or invalid token')
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    acceptSocket(req, socket, head)
  }

  /**
   * Complete the handshake and start the per-connection frame pump.
   * @param req - the upgrade request.
   * @param socket - the raw TCP socket.
   * @param head - bytes already read past the handshake.
   */
  function acceptSocket(req, socket, head) {
    // Also covers a direct caller and the handshake write itself; onUpgrade
    // installs the same listener, and a second listener is harmless.
    socket.on('error', () => {
      try { socket.destroy() } catch {}
    })
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    const offered = typeof req.headers['sec-websocket-protocol'] === 'string'
      ? req.headers['sec-websocket-protocol']
          .split(',')
          .map((entry) => entry.trim())
          .find((entry) => /^[A-Za-z0-9._-]+$/.test(entry))
      : undefined
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (offered === undefined ? '' : `Sec-WebSocket-Protocol: ${offered}\r\n`) +
        '\r\n',
    )
    socket.setNoDelay(true)

    const controller = new AbortController()
    const owner = resolved.principal === 'owner'
    // `answer` is what lets this peer open the Host's `$events` stream. The bridge
    // needs it to relay `api-session/status` to the controlling window: with `none`
    // the Gateway refuses the stream (gateway/interactions-forbidden) and a remote
    // window never learns that a Session started running.
    const peer = ctx.connection.createPeer({
      principal: { kind: resolved.principal },
      interactions: 'answer',
    })
    peers.add(peer)
    liveSockets.add(socket)
    const dropSocket = () => liveSockets.delete(socket)
    socket.on('close', dropSocket)

    /** AbortControllers of every live stream this connection opened. */
    const streams = new Map()
    let closed = false
    let lastSeen = Date.now()
    let idleTimer

    const send = (payload) => {
      if (closed || socket.destroyed) return
      if (socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
        hostTrace(`slow controller: ${socket.writableLength} bytes queued`)
        shutdown(1013)
        return
      }
      socket.write(encodeFrame(payload))
    }

    /**
     * Forward one Session status change to this connection.
     * @param {{ sessionId: string, running: boolean }} event - the Host's announcement.
     */
    function pushStatus(payload) {
      // Two shapes arrive here: the composer's own status triple, and the
      // `{ event, args }` envelope every other one-way event uses.
      if (Array.isArray(payload?.args) && typeof payload?.event === 'string') {
        send({ kind: 'event', event: payload.event, value: { type: 'emit', event: payload.event, args: payload.args } })
        return
      }
      send({ kind: 'event', event: 'session.status', value: { sessionId: payload.sessionId, status: payload.running ? 'running' : 'idle' } })
    }

    /**
     * Forward one forwarded-event frame verbatim.
     *
     * The frame keeps the Host's own waterfall envelope (`type`, `event`,
     * `eventId`, `agentId`, `request`) so the page validates it unchanged.
     * @param {object} value - the forwarded event frame.
     */
    function pushApproval(value) {
      // The frame carries its own name (`approval/request` or
      // `user-questions/request`); hardcoding it made every question look like an
      // approval in the trace, which sent a whole debugging session down the wrong
      // path.
      send({ kind: 'event', event: typeof value?.event === 'string' ? value.event : 'approval/request', value })
    }

    const shutdown = (code) => {
      if (closed) return
      closed = true
      if (idleTimer !== undefined) clearInterval(idleTimer)
      idleTimer = undefined
      for (const control of streams.values()) control.abort(new Error('connection closed'))
      streams.clear()
      controller.abort(new Error('connection closed'))
      peers.delete(peer)
      void peer.dispose?.()
      // Drop the sinks here rather than waiting for the socket's `close` event: a
      // half-closed peer that never answers the close frame would otherwise leave
      // this connection in `statusSinks` forever, and every replay would fan out to
      // dead sockets.
      forgetStatus()
      if (!socket.destroyed) socket.end(encodeClose(code))
    }

    send({ kind: 'hello', protocol: PROTOCOL, principal: resolved.principal, streams: resolved.allowStreams })

    let sinksDropped = false
    let subscribed = false
    const forgetStatus = () => {
      // Idempotent: `shutdown` drops the sinks eagerly and the socket's own `close`
      // event follows, so an unguarded delete would log every release twice.
      if (sinksDropped) return
      sinksDropped = true
      statusSinks.delete(pushStatus)
      approvalSinks.delete(pushApproval)
      hostTrace(`connection released sinks=${statusSinks.size}`)
      if (approvalSinks.size === 0) scheduleApprovalGrace()
    }
    /**
     * Promote this socket to an event controller.
     *
     * Every short-lived unary RPC used to be registered as a sink too, so each
     * call replayed every pending prompt to every socket. Only the page's mirror
     * asks for events now, via a `subscribe` frame.
     */
    const subscribe = () => {
      if (closed || subscribed) return
      if (!owner) {
        // A guest peer must not receive the raw event/approval stream: DSH's
        // remote-access policy is enforced for gateway calls, but this stream is
        // plugin-owned and would otherwise bypass it.
        send({ kind: 'error', code: 'remote-control/forbidden', message: 'guest peers may not subscribe' })
        return
      }
      subscribed = true
      sinksDropped = false
      statusSinks.add(pushStatus)
      approvalSinks.add(pushApproval)
      cancelApprovalGrace()
      hostTrace(`connection registered sinks=${statusSinks.size}`)
      replayPendingApprovals()
    }
    // Release the push targets on any terminal event. No liveness probe watches a
    // silent peer: every connection here is opened by the controlling side for one
    // RPC or one held stream, its own request timeout bounds it, and an early version
    // that reaped quiet connections cut legitimate long transfers short.
    socket.on('close', () => {
      hostTrace(`socket closed (was ${statusSinks.has(pushStatus) ? 'held' : 'already-free'})`)
      forgetStatus()
    })
    socket.on('error', (error) => {
      hostTrace(`socket error: ${error?.message ?? 'unknown'}`)
      forgetStatus()
    })
    socket.on('end', () => {
      hostTrace('socket ended')
      forgetStatus()
    })
    /**
     * Fail one request that cannot be correlated back to its caller.
     *
     * A `fatal` error is a connection-level protocol failure: the controller
     * must not attribute it to every other request multiplexed on this socket,
     * so the Host also stops the connection. Correlatable errors include `id`.
     * @param {string} message - diagnostic text.
     */
    const fatalProtocolError = (message) => {
      send({ kind: 'error', code: 'bad-request', message, fatal: true })
      shutdown(CLOSE_POLICY)
    }
    const handleFrame = async (payload) => {
      let frame
      try {
        frame = JSON.parse(payload)
      } catch {
        fatalProtocolError('frame is not JSON')
        return
      }
      if (frame === null || typeof frame !== 'object' || className(frame) !== 'Object') {
        fatalProtocolError('frame must be a JSON object')
        return
      }
      const type = frame.type
      if (typeof type !== 'string' || !CLIENT_FRAMES.has(type)) {
        if (typeof frame.id === 'string' && frame.id !== '') {
          send({ kind: 'error', id: frame.id, code: 'bad-request', message: `unknown frame type ${JSON.stringify(type)}` })
        } else {
          fatalProtocolError(`unknown frame type ${JSON.stringify(type)}`)
        }
        return
      }

      if (type === 'subscribe') {
        if (!owner) {
          send({ kind: 'error', code: 'remote-control/forbidden', message: 'guest peers may not subscribe' })
          return
        }
        subscribe()
        send({ kind: 'subscribed' })
        return
      }

      if (type === 'ping') {
        send({ kind: 'pong' })
        return
      }

      if (type === 'stream-cancel') {
        const target = frame.target
        if (typeof target !== 'string') {
          send({ kind: 'error', code: 'bad-request', message: 'stream-cancel needs a target id' })
          return
        }
        streams.get(target)?.abort(new Error('cancelled by client'))
        return
      }

      // Per-path download decision for the controller's sidebar button. It
      // never reads bytes; it only asks the policy that `file-read` will use.
      if (type === 'file-read-check') {
        const checkId = frame.id
        if (typeof checkId !== 'string' || checkId === '' || checkId.length > MAX_ID_LENGTH) {
          fatalProtocolError('file-read-check needs an id of at most 128 bytes')
          return
        }
        if (!owner) {
          send({ kind: 'result', id: checkId, ok: true, value: { allowed: false } })
          return
        }
        const decision = await decideFileRead(ctx, fileReadPolicy, frame.path)
        send({ kind: 'result', id: checkId, ok: true, value: { allowed: decision.allowed } })
        return
      }

      // Raw file bytes for the controlling window's `/api/file` route.
      //
      // Placed before the namespace/method check: this frame carries no RPC endpoint,
      // only a path and an offset. The Host serves that route over HTTP, which this
      // bridge cannot reach, and `workspaceFiles/readBytes` returns the whole file in
      // one JSON value (a 6.4 MB archive became 76 MB and killed the socket).
      if (type === 'file-read') {
        if (!owner) {
          const deniedId = typeof frame.id === 'string' ? frame.id : ''
          send({ kind: 'result', id: deniedId, ok: false, code: 'remote-control/forbidden', message: 'guest peers may not read files' })
          return
        }
        const fileId = frame.id
        if (typeof fileId !== 'string' || fileId === '' || fileId.length > MAX_ID_LENGTH) {
          fatalProtocolError('file-read needs an id of at most 128 bytes')
          return
        }
        hostTrace(`file-read path=${JSON.stringify(frame.path)} offset=${frame.offset}`)
        try {
          const decision = await decideFileRead(ctx, fileReadPolicy, frame.path)
          if (!decision.allowed) {
            send({ kind: 'result', id: fileId, ok: false, code: decision.code ?? 'remote-control/file-read-denied', message: decision.message ?? 'file access denied' })
            return
          }
          const value = await readFileChunk({ path: decision.target ?? frame.path, offset: frame.offset, length: frame.length }, controller.signal)
          send({ kind: 'result', id: fileId, ok: true, value })
        } catch (error) {
          send({ kind: 'result', id: fileId, ok: false, ...errorFields(error) })
        }
        return
      }

      const id = frame.id
      if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
        fatalProtocolError('id must be a non-empty string of at most 128 bytes')
        return
      }
      const namespace = frame.namespace
      const method = frame.method
      if (typeof namespace !== 'string' || namespace === '' || typeof method !== 'string' || method === '') {
        send({ kind: 'error', id, code: 'bad-request', message: 'namespace and method must be non-empty strings' })
        return
      }
      const args = frame.args === undefined ? {} : frame.args
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        send({ kind: 'error', id, code: 'bad-request', message: 'args must be a JSON object' })
        return
      }

      // A controller answers a forwarded waterfall here. This is the Gateway's
      // internal `$events/result` shape; the bridge owns it because the prompt
      // itself was parked by `relayApproval`, not by the Gateway.
      if (namespace === '$events' && method === 'result') {
        if (!owner) {
          send({ kind: 'error', id, code: 'remote-control/forbidden', message: 'guest peers may not answer approvals' })
          return
        }
        const eventId = args.eventId
        const pending = typeof eventId === 'string' ? pendingApprovals.get(eventId) : undefined
        if (pending === undefined) {
          send({ kind: 'result', id, ok: false, code: 'bad-request', message: `no pending approval ${JSON.stringify(eventId)}` })
          return
        }
        pendingApprovals.delete(eventId)
        if (pending.frame.event === 'user-questions/request') {
          // A question's outcome is the answer list itself, not a vocabulary word.
          // `custom` carries the free-text box, which the Host forwards verbatim.
          const raw = args.outcome?.value ?? args.outcome
          const asked = new Set(pending.frame.request.questions.map((question) => question.id))
          const answers = (Array.isArray(raw?.answers) ? raw.answers : [])
            .filter((answer) => typeof answer?.id === 'string' && asked.has(answer.id))
            .map((answer) => ({
              id: answer.id,
              selected: (Array.isArray(answer.selected) ? answer.selected : []).filter((value) => typeof value === 'string'),
              ...(typeof answer.custom === 'string' && answer.custom !== '' ? { custom: answer.custom } : {}),
            }))
          pending.resolve({ answers })
          hostTrace(`question answered ${eventId} -> ${answers.length} answer(s)`)
          send({ kind: 'result', id, ok: true, value: {} })
          return
        }
        const outcome = args.outcome?.value ?? args.outcome?.kind ?? 'unavailable'
        const allowed = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
        pending.resolve(allowed.includes(outcome) ? outcome : 'unavailable')
        hostTrace(`approval answered ${eventId} -> ${outcome}`)
        send({ kind: 'result', id, ok: true, value: {} })
        return
      }

      if (type === 'invoke') {
        try {
          const value = await gateway.invoke({ namespace, method, args, peer, signal: controller.signal })
          // Byte-returning endpoints (`readBytes`) hand back a `Uint8Array`, which
          // `JSON.stringify` would flatten into `{0:137,1:80,...}`. Record the shape
          // once per endpoint so the binary channel can be built against reality
          // rather than an assumption about where the bytes live.
          if (!PROBED.has(`${namespace}/${method}`)) {
            PROBED.add(`${namespace}/${method}`)
            hostTrace(`result shape ${namespace}/${method}: ${describeShape(value)}`)
          }
          // A `Uint8Array` in the result would be flattened by `JSON.stringify` into
          // `{0:..,1:..}` — a 6.4 MB file became a 76 MB frame and killed the socket
          // (`write EPIPE`). Bytes travel as base64 chunks instead, which the
          // controlling side reassembles before answering the page.
          const encoded = encodeByteResults(value)
          send({ kind: 'result', id, ok: true, value: encoded.json })
          // `total` tells the reader how many frames this slot was split into, so it can
          // wait for the last one instead of settling on the first. The chunks are
          // generated one at a time; stop early if a slow/closed socket was dropped.
          for (const chunk of encoded.chunks) {
            if (closed) break
            send({ kind: 'result-bytes', id, index: chunk.index, seq: chunk.seq, total: chunk.total, data: chunk.data })
          }
        } catch (error) {
          send({ kind: 'result', id, ok: false, ...errorFields(error) })
        }
        return
      }

      // type === 'stream'
      if (!resolved.allowStreams) {
        send({ kind: 'stream-end', id, ok: false, code: 'bridge/streams-disabled', message: 'this bridge does not allow stream methods' })
        return
      }
      if (streams.has(id)) {
        send({ kind: 'stream-end', id, ok: false, code: 'bad-request', message: `stream id ${id} is already open` })
        return
      }
      const control = new AbortController()
      streams.set(id, control)
      const onAbort = () => control.abort(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      void pumpStream({ id, namespace, method, args, peer, control, send, streams, onAbort })
    }

    const pumpStream = async ({ id, namespace, method, args, peer, control, send: emit, streams: registry, onAbort }) => {
      try {
        const iterable = await gateway.stream({ namespace, method, args, peer, signal: control.signal })
        for await (const value of iterable) {
          // A cancelled stream must not be reported as a clean completion: the
          // client asked for it to stop, so the terminal frame says so.
          if (control.signal.aborted) break
          emit({ kind: 'stream-item', id, value })
        }
        if (control.signal.aborted) {
          emit({ kind: 'stream-end', id, ok: false, ...cancelledFields(control.signal.reason) })
        } else {
          emit({ kind: 'stream-end', id, ok: true })
        }
      } catch (error) {
        emit({ kind: 'stream-end', id, ok: false, ...errorFields(control.signal.aborted ? control.signal.reason : error) })
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
        registry.delete(id)
      }
    }

    const queue = new ByteQueue()
    if (head && head.length > 0) queue.push(head)

    const consume = (chunk) => {
      queue.push(chunk)
      for (;;) {
        if (queue.length < 2) return
        const meta = measureFrame(queue.peek(14), resolved.maxRequestBytes)
        if (meta.error !== undefined) {
          if (meta.error === 'truncated frame') return
          send({ kind: 'error', code: 'bad-request', message: meta.error })
          shutdown(CLOSE_POLICY)
          return
        }
        if (queue.length < meta.total) return
        const frame = queue.take(meta.total)
        const decoded = decodeFrame(frame, resolved.maxRequestBytes)
        if (decoded.error !== undefined) {
          send({ kind: 'error', code: 'bad-request', message: decoded.error })
          shutdown(CLOSE_POLICY)
          return
        }
        if (decoded.opcode === OPCODE_CLOSE) {
          shutdown(1000)
          return
        }
        if (decoded.opcode === OPCODE_PING) {
          socket.write(encodeControl(OPCODE_PONG, decoded.payload))
          continue
        }
        if (decoded.opcode === OPCODE_PONG) continue
        if (decoded.opcode !== OPCODE_TEXT) {
          send({ kind: 'error', code: 'bad-request', message: `unsupported opcode ${decoded.opcode}` })
          shutdown(CLOSE_POLICY)
          return
        }
        if (!decoded.fin) {
          send({ kind: 'error', code: 'bad-request', message: 'fragmented frames are not supported' })
          shutdown(CLOSE_POLICY)
          return
        }
        void handleFrame(decoded.payload.toString('utf8'))
      }
    }

    socket.on('data', (chunk) => {
      lastSeen = Date.now()
      consume(chunk)
    })
    // A client that pipelines its first frame with the upgrade leaves it in
    // `head`; no later `data` event may arrive to trigger the parser.
    if (queue.length > 0) consume(Buffer.alloc(0))
    // A controller that disappears without a FIN/RST must not keep an approval
    // sink alive (and suppress the local prompt) for the full five-minute
    // timeout. A sends an application-level ping every 30 s; any incoming bytes
    // count as liveness.
    idleTimer = setInterval(() => {
      if (closed || socket.destroyed) {
        clearInterval(idleTimer)
        idleTimer = undefined
        return
      }
      if (Date.now() - lastSeen > 90_000) {
        hostTrace('idle controller: no frames for 90s')
        shutdown(1001)
      }
    }, 30_000)
    idleTimer.unref?.()
    socket.on('error', () => shutdown(1011))
    socket.on('close', () => shutdown(1000))
  }

  // ── Management routes on the Host web server ─────────────────────────────
  // These drive the "远程设备" panel. Like the mobile gateway's /mgw/*, they are
  // local administration: loopback callers only, never reachable from the
  // bridge listener, which answers 404 to everything but the WebSocket path.
  const isLoopbackRequest = (req) => {
    const remote = req.socket?.remoteAddress ?? ''
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  }

  const sendJson = (res, code, body) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.length,
    })
    res.end(payload)
  }

  const readJsonBody = (req, limit = 8192) =>
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
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  /**
   * Whether an administration request carries the page marker and is not a
   * cross-site browser request.
   *
   * `remoteAddress === loopback` alone is not a CSRF defence: a page on any
   * origin can send a simple request to 127.0.0.1. The marker header is not
   * settable by a cross-origin simple request (it forces a preflight this
   * server never grants), and `Sec-Fetch-Site` is a second, browser-supplied
   * signal. Non-browser local tools can still set the header deliberately.
   * @param {import('node:http').IncomingMessage} req - request.
   * @returns {boolean} true when the request may mutate state.
   */
  const authorizedAdmin = (req) => {
    if (req.headers['x-dsh-remote-control'] !== '1') return false
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  const managementHandler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid')
    const known =
      url.pathname === STATUS_PATH ||
      url.pathname === TOGGLE_PATH ||
      url.pathname === TOKEN_PATH ||
      url.pathname === PORT_PATH
    if (!known) return false
    if (authorize !== undefined) {
      const outcome = authorize(req, url)
      if (outcome.ok !== true) {
        sendJson(res, outcome.status ?? 403, { error: 'forbidden', message: outcome.reason ?? 'unauthorized' })
        return true
      }
    } else if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: 'forbidden', message: 'this route is loopback-only' })
      return true
    } else if (!authorizedAdmin(req)) {
      sendJson(res, 403, { error: 'forbidden', message: 'missing same-origin remote-control marker' })
      return true
    }
    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return true
      }
      sendJson(res, 200, status())
      return true
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return true
    }
    if (url.pathname === PORT_PATH || url.pathname === TOGGLE_PATH) {
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(res, 415, { error: 'unsupported-media-type', message: 'content-type must be application/json' })
        return true
      }
    }
    if (url.pathname === PORT_PATH) {
      // Re-bind on a new address and/or port. A change takes effect immediately
      // when the bridge is listening; when it is off the values only become the
      // next bind targets. The config rules apply unchanged: the address must be
      // one concrete non-wildcard literal, and the port must be unprivileged.
      readJsonBody(req)
        .then(async (body) => {
          const nextHost = body?.host === undefined ? requestedHost : parseRequestedHost(body.host)
          if (nextHost instanceof Error) {
            sendJson(res, 400, { error: 'bad-request', message: nextHost.message })
            return
          }
          const nextPort = body?.port === undefined ? requestedPort : parseRequestedPort(body.port)
          if (nextPort instanceof Error) {
            sendJson(res, 400, { error: 'bad-request', message: nextPort.message })
            return
          }
          const previousHost = requestedHost
          const previousPort = requestedPort
          const result = await configure({ host: nextHost, port: nextPort })
          if (!result.ok) {
            sendJson(res, 502, { error: 'bind-failed', message: result.error, ...result.status })
            return
          }
          if (previousHost !== nextHost || previousPort !== nextPort) {
            log(`bind target changed ${previousHost}:${previousPort} -> ${nextHost}:${nextPort} from the remote-devices panel`)
          }
          sendJson(res, 200, result.status)
        })
        .catch((error) => {
          sendJson(res, 400, { error: 'bad-request', message: error.message })
        })
      return true
    }
    if (url.pathname === TOKEN_PATH) {
      // Rotation: mint a fresh credential and drop every connection that
      // authenticated with the old one, so a leaked token stops working the
      // moment the operator rotates it. The listener itself keeps running.
      token = mintToken()
      notify()
      dropSockets(CLOSE_POLICY)
      log('token rotated from the remote-devices panel; existing connections dropped')
      sendJson(res, 200, status())
      return true
    }
    readJsonBody(req)
      .then(async (body) => {
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'bad-request', message: 'enabled must be a boolean' })
          return
        }
        const result = await configure({ enabled: body.enabled })
        if (!result.ok) {
          sendJson(res, 502, { error: 'bind-failed', message: result.error, ...result.status })
          return
        }
        log(body.enabled ? 'enabled from the remote-devices panel' : 'disabled from the remote-devices panel')
        sendJson(res, 200, result.status)
      })
      .catch((error) => {
        sendJson(res, 400, { error: 'bad-request', message: error.message })
      })
    return true
  }

  if (typeof ctx.webServer?.register === 'function') {
    for (const [path, label] of [
      [STATUS_PATH, 'status'],
      [TOGGLE_PATH, 'toggle'],
      [TOKEN_PATH, 'token'],
      [PORT_PATH, 'port'],
    ]) {
      const route = {
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (!managementHandler(req, res)) sendJson(res, 404, { error: 'not-found' })
        },
      }
      ctx.effect(() => ctx.webServer.register(route), `remote-bridge: ${label} route`)
    }
  } else {
    log('no webServer service; the remote-devices panel routes are not mounted')
  }

  void startListener()

  // The official lifecycle event that drives the Send/Stop button on a Host page.
  // A remote window cannot see this process's event bus, so the bridge relays it:
  // without this the controller kept showing Send while an answer streamed.
  // `api-session/status` is forwarded as `session.status` because the page's
  // composer reads that name; every other one-way event keeps its own name and
  // travels as a `{ type: 'emit', event, args }` item, which is the shape this
  // Host's own `$events` stream uses.
  const disposeStatus = ctx.on?.('api-session/status', (sessionId, running) => {
    hostTrace(`status ${String(sessionId).slice(0, 8)} running=${running} sinks=${statusSinks.size}`)
    if (statusSinks.size === 0) return
    const event = { sessionId: String(sessionId), running: running === true }
    for (const sink of statusSinks) {
      try {
        sink(event)
      } catch (error) {
        hostTrace(`status push failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  /**
   * One-way Host events mirrored to every connected controller.
   *
   * Each entry names the Host event and is subscribed with `ctx.on`; the arguments
   * are forwarded as they arrived, so the page receives the same
   * `{ type: 'emit', event, args }` item its own `$events` stream would carry.
   * Events with no remote meaning (`cordis/*`, plugin market, schedule) are included
   * because the Host forwards them too and a page may render them.
   */
  const MIRRORED_EMITS = [
    'agent-preset/selected',
    'api-session/activity',
    'api-session/added',
    'api-session/error',
    'api-session/removed',
    'commands/change',
    'deepseek-account/session-expired',
    'deepseek-account/model-sign-in-required',
    'credentials/record-updated',
    'credentials/reference-updated',
    'goal/activation-changed',
    'cordis/request-run',
    'cordis/request-run-resolved',
    'cordis/dynamic-package',
    'cordis/dynamic-retract',
    'cordis/inspect-query',
    'cordis/inspect-query-resolved',
    'llm/adapters-updated',
    'permission-presets/catalog-changed',
    'plugin-manager/changed',
    'plugin-manager/install-log',
    'plugin-manager/install-state',
    'plugin-market/changed',
    'settings/document-updated',
    'schedule/changed',
  ]

  /**
   * Turn one Host payload into JSON the page can consume.
   *
   * Host events sometimes carry live objects (Agents, Controllers). Only plain data
   * survives the socket, and a value that cannot be serialized must not break the
   * relay for every other event.
   * @param {unknown} value - one argument.
   * @returns {unknown} a JSON-safe copy, or undefined when it cannot be encoded.
   */
  const toWire = (value) => {
    if (value === undefined) return { ok: true, value: undefined }
    try {
      const text = JSON.stringify(value)
      // `JSON.stringify` returns undefined for a bare function or symbol, and a
      // round-trip is the only way to learn whether the value survived intact.
      if (text === undefined) return { ok: false }
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false }
    }
  }

  /** Push one emitted event to every controller. */
  const pushEmit = (event, args) => {
    if (statusSinks.size === 0) return
    for (const sink of statusSinks) {
      try {
        sink({ event, args })
      } catch (error) {
        hostTrace(`${event} push failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const disposeEmits = MIRRORED_EMITS.map((event) =>
    ctx.on?.(event, (...args) => {
      // Nothing to mirror: do the deep JSON round-trip only when a controller
      // is actually connected. This is the hot path for activity events.
      if (statusSinks.size === 0) return
      const wire = args.map(toWire)
      // The Host rejects a non-JSON ordinary-event argument rather than coercing it,
      // so a payload that cannot round-trip is dropped whole instead of turning into
      // a null the page would read as real data.
      if (wire.some((entry) => entry.ok !== true)) {
        hostTrace(`emit ${event} dropped (not JSON-safe)`)
        return
      }
      hostTrace(`emit ${event} args=${wire.length}`)
      pushEmit(event, wire.map((entry) => entry.value))
    }),
  )

  /**
   * Pending approval requests forwarded to a connected controller.
   *
   * `approval/request` is a waterfall: the Host awaits one outcome per request, so
   * the bridge parks the `next()` continuation here until a controller answers
   * through `$events/result`. Keyed by the event id the caller must echo back.
   * @type {Map<string, { resolve: (outcome: string) => void, timer: NodeJS.Timeout }>}
   */
  const pendingApprovals = new Map()
  /** Connections that accept forwarded waterfall prompts, one writer per socket. */
  const approvalSinks = new Set()
  /** Pending settle timer after the last approval controller disappears. */
  let approvalGrace

  /**
   * Settle every parked prompt with the protocol's empty value. Used by stop,
   * unload, and the post-disconnect grace timer; the Host must never be left
   * waiting five minutes for a controller that is gone.
   * @param {string} reason - diagnostic label.
   */
  const settlePending = (reason) => {
    if (pendingApprovals.size === 0) return
    hostTrace(`settling ${pendingApprovals.size} pending prompt(s): ${reason}`)
    for (const [eventId, entry] of pendingApprovals) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.resolve(entry.frame?.event === 'user-questions/request' ? { answers: [] } : 'cancelled')
      pendingApprovals.delete(eventId)
    }
  }
  const cancelApprovalGrace = () => {
    if (approvalGrace === undefined) return
    clearTimeout(approvalGrace)
    approvalGrace = undefined
  }
  const scheduleApprovalGrace = () => {
    if (approvalGrace !== undefined || pendingApprovals.size === 0 || approvalSinks.size > 0) return
    approvalGrace = setTimeout(() => {
      approvalGrace = undefined
      if (approvalSinks.size === 0) settlePending('no controller after grace')
    }, approvalGraceMs)
    approvalGrace.unref?.()
  }
  let approvalSeq = 0

  /**
   * Relay one approval prompt to the controller and await its decision.
   * @param {object} request - the Host's ApprovalRequestEvent.
   * @param {() => Promise<string>} next - delegate to the next answerer.
   * @returns {Promise<string>} the ApprovalOutcome.
   */
  const relayApproval = async (request, next) => {
    hostTrace(`approval raised sinks=${approvalSinks.size} agent=${request?.agent?.id === undefined ? 'none' : 'yes'}`)
    if (approvalSinks.size === 0) {
      hostTrace('approval skipped: no connected controller')
      return next()
    }
    // The forwarded frame carries a JSON copy only: `agent` and `signal` are live
    // Host objects and the Client rejects a request that contains them.
    // `request.agent` is the live Agent object, not an id: reading it as a string
    // produced "[object Object]" and the page rejected the frame.
    const agentId = request?.agent?.id === undefined ? undefined : String(request.agent.id)
    if (agentId === undefined) return next()
    const frame = {
      type: 'waterfall',
      event: 'approval/request',
      eventId: `remote-control-${instanceId}-approval-${++approvalSeq}`,
      agentId,
      request: {
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.toolName === undefined ? {} : { toolName: String(request.toolName) }),
        ...(request.reason === undefined ? {} : { reason: String(request.reason) }),
        // The localized prompt the Host already prepared; forwarding it keeps the
        // remote card's wording identical to the controlled machine's.
        ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
      },
    }
    hostTrace(`approval forwarded ${frame.eventId} sinks=${approvalSinks.size}`)
    return await waitForRemote(request, frame, 'approval')
  }

  /**
   * Race a forwarded prompt against the Host's own answerers.
   *
   * Both surfaces show the prompt at once and whichever answers first wins; the
   * other is discarded. There is deliberately **no timeout**: the Agent is blocked
   * on a human decision, and the Host's own seams wait for `request.signal` rather
   * than inventing an outcome. Only an abort (the turn was cancelled) or a second
   * answer settles the loser.
   * @param {object} request - the Host event payload (carries `signal`).
   * @param {object} frame - the forwarded waterfall frame.
   * @param {() => Promise<any>} next - the Host's own answerers.
   * @param {string} label - trace label.
   * @returns {Promise<any>} whichever answer arrived first.
   */
  const waitForRemote = async (request, frame, label) => {
    const cause = request?.signal
    let settled = false
    return await new Promise((resolve) => {
      let timer
      const settle = (value, source) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        pendingApprovals.delete(frame.eventId)
        try { cause?.removeEventListener('abort', onAbort) } catch {}
        hostTrace(`${label} ${frame.eventId} settled by ${source}`)
        resolve(value)
      }
      const onAbort = () => settle(label === 'question' ? '__cancelled__' : 'cancelled', 'abort')
      if (cause !== undefined) {
        if (cause.aborted) {
          settled = true
          resolve(label === 'question' ? '__cancelled__' : 'cancelled')
          return
        }
        try { cause.addEventListener('abort', onAbort, { once: true }) } catch {}
      }
      // A remote controller can disappear after the prompt was delivered. The
      // local UI is intentionally not shown while a controller is attached, so
      // without this the Agent would wait forever. Fail closed like the Host's
      // own answerers.
      timer = setTimeout(
        () => settle(label === 'question' ? { answers: [] } : 'cancelled', 'timeout'),
        APPROVAL_TIMEOUT_MS,
      )
      timer.unref?.()
      pendingApprovals.set(frame.eventId, { resolve: (value) => settle(value, 'remote'), frame, timer })
      pushApprovalToSinks(frame)
    })
  }

  /**
   * Deliver one prompt to every connected controller.
   * @param {object} frame - the forwarded waterfall frame.
   * @returns {number} how many writers threw.
   */
  const pushApprovalToSinks = (frame) => {
    let failures = 0
    for (const sink of approvalSinks) {
      try {
        sink(frame)
      } catch (error) {
        failures += 1
        hostTrace(`approval push failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return failures
  }

  /**
   * Re-send every still-pending prompt to the controllers that just connected.
   *
   * The Host's own waterfall keeps its id across a carrier replay, and the client
   * only ever saw the frame on the socket that is now gone, so a reconnect without
   * this leaves the prompt invisible until it times out.
   */
  const replayPendingApprovals = () => {
    if (pendingApprovals.size === 0) return
    // Named per entry so a duplicate-card report can be traced to the exact id a
    // new connection re-received.
    const ids = [...pendingApprovals.values()].map((entry) => entry.frame.eventId)
    hostTrace(`replay ${ids.length} pending: ${ids.join(',')} sinks=${approvalSinks.size}`)
    for (const entry of pendingApprovals.values()) pushApprovalToSinks(entry.frame)
  }

  /**
   * Relay one `ask_user_question` prompt and await the answers.
   *
   * The question vocabulary differs from an approval outcome: the caller receives
   * `{ answers: [{ id, selected, custom? }] }`, where `custom` is what the operator
   * typed into the free-text box. The prompt is a waterfall, so the continuation is
   * parked here exactly like an approval.
   * @param {object} request - the Host's AskUserQuestionRequestEvent.
   * @param {() => Promise<object>} next - delegate to the next answerer.
   * @returns {Promise<object>} the AskUserQuestionAnswer.
   */
  const relayQuestion = async (request, next) => {
    // Unconditional entry trace: if this never appears, the Host never raised the
    // event, which is a different problem from a request we chose not to relay.
    hostTrace(
      `question raised sinks=${approvalSinks.size} agent=${request?.agent?.id === undefined ? 'none' : 'yes'} ` +
        `questions=${Array.isArray(request?.questions) ? request.questions.length : 'none'}`,
    )
    // Each early exit records its reason: "raised but not forwarded" and "never
    // raised" need different fixes, and the line above cannot tell them apart.
    if (approvalSinks.size === 0) {
      hostTrace('question skipped: no connected controller')
      return next()
    }
    const agentId = request?.agent?.id === undefined ? undefined : String(request.agent.id)
    if (agentId === undefined) {
      hostTrace('question skipped: request.agent.id is missing')
      return next()
    }
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0) {
      hostTrace('question skipped: empty questions')
      return next()
    }
    const frame = {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: `remote-control-${instanceId}-question-${++approvalSeq}`,
      agentId,
      request: {
        questions: questions.map((question) => ({
          id: String(question.id),
          question: String(question.question),
          ...(question.detail === undefined ? {} : { detail: String(question.detail) }),
          ...(question.header === undefined ? {} : { header: String(question.header) }),
          ...(Array.isArray(question.options)
            ? {
                options: question.options.map((option) => ({
                  label: String(option.label),
                  ...(option.description === undefined ? {} : { description: String(option.description) }),
                })),
              }
            : {}),
          ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect === true }),
          ...(question.intent === undefined ? {} : { intent: question.intent }),
        })),
        // `wait` is what makes the card removable: the page reads
        // `request.wait?.timed` to claim a live wait, and only the claimed path
        // calls `card.remove()` when the waterfall settles. Dropping it left the
        // card on screen after the answer was accepted.
        ...(request.wait === undefined
          ? {}
          : {
              wait: {
                ...(request.wait.callId === undefined ? {} : { callId: String(request.wait.callId) }),
                ...(request.wait.timed === undefined ? {} : { timed: request.wait.timed === true }),
              },
            }),
      },
    }
    hostTrace(`question forwarded ${frame.eventId} sinks=${approvalSinks.size}`)
    const answer = await waitForRemote(request, frame, 'question')
    // A cancelled question has no answer to return; anything else is the winner's
    // payload, already shaped by whichever side settled first.
    if (answer === '__cancelled__') return { answers: [] }
    return answer
  }

  // Registered exactly like `dsh-plugin-mobile-gateway` does it (several
  // listeners answer these waterfalls; `prepend` puts ours first so a connected
  // controller sees the prompt before the Host's own answerers settle it).
  const disposeQuestion = ctx.on?.(
    'user-questions/request',
    (request, next) => {
      // Separate trace from `relayQuestion`'s own line: this one fires as soon as
      // Cordis admits the hook, before any of our guards can skip it.
      hostTrace('question hook fired')
      return relayQuestion(request, next)
    },
    { prepend: true },
  )
  hostTrace(`question listener registered=${typeof disposeQuestion === 'function'}`)

  const disposeApproval = ctx.on?.('approval/request', (request, next) => relayApproval(request, next), { prepend: true })

  ctx.effect(() => () => {
    // Mark the row disposed before anything asynchronous is awaited: a bind
    // that settles after this point must close its own server instead of
    // attaching to a plugin that no longer exists.
    disposing = true
    enabled = false
    clearServiceTimer()
    disposeStatus?.()
    disposeApproval?.()
    disposeQuestion?.()
    for (const dispose of disposeEmits) dispose?.()
    cancelApprovalGrace()
    // Unloading is not a decision, but the waterfall must still receive a
    // value of the right shape. The Host's own answerers cannot be invoked
    // from here because this listener already owns the continuation.
    settlePending('plugin unloaded')
    statusSinks.clear()
    approvalSinks.clear()
    return stopListener()
  }, 'remote-bridge: listener')

  // The merged plugin's browser half renders this state in the first card tab and
  // drives it through the management routes above; the handle also lets the entry
  // report bridge availability at startup.
  return {
    status,
    /** Whether the listener currently holds a socket. */
    listening: () => listener !== undefined,
    /** Stop the listener and release its socket (used when the row unloads). */
    stop: stopListener,

    /**
     * Apply a target and/or switch atomically. This is the preferred entry point:
     * it validates, serializes stop/start and returns the live status.
     * @param {{ enabled?: boolean, host?: string, port?: number, token?: string }} next - target values.
     * @returns {Promise<{ ok: boolean, error?: string, status: object }>} outcome and live status.
     */
    configure,

    /**
     * Adopt a preset's bind target and credential and re-open on it.
     *
     * Switching presets is an edit of what the bridge serves, not a separate
     * action, so an open listener must move with the selection instead of staying
     * on the previous address.
     * @param {{ host?: string, port?: number, token?: string }} preset - chosen values.
     * @returns {Promise<{ ok: boolean, error?: string, status: object }>} outcome and live status.
     */
    applyPreset(preset) {
      return configure({ host: preset?.host, port: preset?.port, token: preset?.token })
    },

    /**
     * Open or close the listener without going through the HTTP route.
     * @param {boolean} next - target state.
     * @returns {Promise<{ ok: boolean, error?: string, status: object }>} outcome and live status.
     */
    setEnabled(next) {
      return configure({ enabled: next === true })
    },

    /** Replace the remote download policy without restarting the listener. */
    setFileRead,

    /** Replace the service lifetime; a running listener restarts its countdown. */
    setDuration,
  }
}

/** Pure helpers exported for unit tests; not part of the plugin contract. */
export const internals = {
  resolveConfig,
  isWildcard,
  parseRequestedHost,
  parseRequestedPort,
  decodeFrame,
  encodeFrame,
  tokenMatches,
  presentedToken,
  remainingAfterFrame,
}

/**
 * `Object.prototype.toString` class name, used to reject arrays and primitives.
 * @param value - any parsed JSON value.
 * @returns the class name.
 */
function className(value) {
  return Object.prototype.toString.call(value).slice(8, -1)
}

/**
 * Serialize a thrown value for a result/stream-end frame.
 * @param error - the thrown value.
 * @returns wire fields excluding `ok`.
 */
function errorFields(error) {
  const { ok: _ignored, ...rest } = wireError(error)
  return rest
}

/**
 * Terminal fields for a stream the client cancelled.
 * @param reason - the abort reason, usually an Error.
 * @returns wire fields excluding `ok`.
 */
function cancelledFields(reason) {
  return {
    code: 'bridge/cancelled',
    message: reason instanceof Error ? reason.message : 'cancelled by client',
  }
}

/**
 * Given a buffered frame beginning at offset 0, report how many trailing bytes
 * belong to later frames.
 * @param buffer - buffered bytes beginning at a frame header.
 * @returns bytes after this frame.
 */
function remainingAfterFrame(buffer) {
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const masked = (buffer[1] & 0x80) !== 0
  return Math.max(0, buffer.length - (offset + (masked ? 4 : 0) + length))
}
