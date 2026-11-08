/**
 * Download/file-read policy shared by the state record and the bridge Host.
 *
 * There is one optional extra root plus the DSH workspace:
 *  - `off`   — no remote file read at all.
 *  - `shared` — the DSH workspace and, when set, one user-selected directory.
 *  - `home`  — the current user's home directory, minus a static platform
 *              deny list of credential and system locations.
 *
 * The policy is deliberately only a download policy. DSH's own
 * `workspaceFiles/readBytes` endpoint is outside this module; see the package
 * documentation for that boundary.
 *
 * @module dsh-remote-control/lib/file-policy
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir, platform as hostPlatform } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { isAbsolutePath } from './paths.js'

/** Accepted file-read modes. */
export const FILE_READ_MODES = new Set(['off', 'shared', 'home'])

/** Service lifetimes offered by the card, in milliseconds. `0` means permanent. */
export const SERVICE_DURATIONS = [
  5 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  0,
]

/** Default lifetime. */
export const DEFAULT_SERVICE_DURATION = 60 * 60_000

/**
 * Normalize the persisted file-read record.
 * @param {unknown} value - stored `{mode, root}`.
 * @returns {{mode: 'off'|'shared'|'home', root: string | null}} normalized record.
 */
export function normalizeFileRead(value) {
  const mode = typeof value?.mode === 'string' && FILE_READ_MODES.has(value.mode) ? value.mode : 'off'
  const raw = typeof value?.root === 'string' ? value.root.trim() : ''
  const root = raw !== '' && isAbsolutePath(raw) ? raw : null
  return { mode, root }
}

/**
 * Normalize a persisted service lifetime.
 * @param {unknown} value - stored milliseconds.
 * @returns {number} one of {@link SERVICE_DURATIONS}.
 */
export function normalizeServiceDuration(value) {
  const numeric = typeof value === 'number' ? value : Number.NaN
  return SERVICE_DURATIONS.includes(numeric) ? numeric : DEFAULT_SERVICE_DURATION
}

/** Expand `%VAR%` and a leading `~` in one configured deny template. */
function expandTemplate(template, env, home) {
  let text = String(template)
  text = text.replace(/%([^%]+)%/g, (_match, name) => {
    const direct = env[name]
    if (typeof direct === 'string' && direct !== '') return direct
    const lower = Object.keys(env).find((key) => key.toLowerCase() === String(name).toLowerCase())
    return lower === undefined ? '' : env[lower] ?? ''
  })
  if (text === '~') text = home
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = `${home}${text.slice(1)}`
  return text
}

/** Static deny templates for one platform. */
function denyTemplates(platform) {
  if (platform === 'win32') {
    return [
      '%SYSTEMROOT%',
      '%PROGRAMFILES%',
      '%PROGRAMFILES(X86)%',
      '%PROGRAMDATA%',
      '%APPDATA%',
      '%LOCALAPPDATA%',
      '%USERPROFILE%\\.ssh',
      '%USERPROFILE%\\.dsh',
      '%USERPROFILE%\\.aws',
      '%USERPROFILE%\\.azure',
      '%USERPROFILE%\\.kube',
      '%USERPROFILE%\\.docker',
      '%USERPROFILE%\\.git-credentials',
      '%USERPROFILE%\\.npmrc',
      '%USERPROFILE%\\.netrc',
      '%USERPROFILE%\\NTUSER.DAT',
      'C:\\System Volume Information',
      'C:\\$Recycle.Bin',
    ]
  }
  if (platform === 'darwin') {
    return [
      '/System',
      '/Library',
      '/private/etc',
      '/etc',
      '/private/var',
      '/var',
      '/usr',
      '/bin',
      '/sbin',
      '/dev',
      '~/Library',
      '~/.dsh',
      '~/.ssh',
      '~/.gnupg',
      '~/.aws',
      '~/.azure',
      '~/.config',
      '~/.kube',
      '~/.docker',
      '~/.netrc',
      '~/.npmrc',
      '~/.git-credentials',
      '~/.bash_history',
      '~/.zsh_history',
    ]
  }
  return [
    '/etc',
    '/root',
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/boot',
    '/proc',
    '/sys',
    '/dev',
    '/run',
    '/var/lib',
    '/run/secrets',
    '/var/run/secrets',
    '~/.dsh',
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.config',
    '~/.kube',
    '~/.docker',
    '~/.local/share/keyrings',
    '~/.mozilla',
    '~/.netrc',
    '~/.npmrc',
    '~/.git-credentials',
    '~/.bash_history',
    '~/.zsh_history',
  ]
}

/**
 * Resolve the platform deny roots once per process.
 * @param {'darwin'|'win32'|'linux'|string} platform - process platform.
 * @param {Record<string,string|undefined>} env - environment.
 * @param {string} home - current home directory.
 * @returns {string[]} absolute deny roots.
 */
export function denyRoots(platform = hostPlatform(), env = process.env, home = homedir()) {
  const out = []
  const seen = new Set()
  for (const template of denyTemplates(platform)) {
    const expanded = expandTemplate(template, env, home)
    if (expanded === '' || !isAbsolute(expanded)) continue
    const normalized = resolve(expanded)
    const key = platform === 'linux' ? normalized : normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? resolve(env.DSH_HOME) : resolve(home, '.dsh')
  const dshKey = platform === 'linux' ? dshHome : dshHome.toLowerCase()
  if (!seen.has(dshKey)) out.push(dshHome)
  return out
}

/** Whether `target` is `root` or lies beneath it. */
function contains(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Canonicalize a path, or return undefined when it does not exist. */
async function real(path) {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/**
 * Every workspace root that may contain a file for this bridge request.
 *
 * The bridge's `file-read` frame has no session id, so `sandboxPolicy.resolve()`
 * without a session returns the deployment fallback, not the session's current
 * cwd. The live `workspaceRegistry` is the authoritative, dynamically updated
 * list of registered workspace directories: it follows workspace switches and
 * newly opened workspaces without persisting a path in state.
 * @param {object} ctx - Host plugin context.
 * @param {string} [workspaceRoot] - already resolved workspace root.
 * @returns {string[]} absolute workspace roots.
 */
export function resolveWorkspaceRoots(ctx, workspaceRoot) {
  const roots = []
  const add = (value) => {
    if (typeof value !== 'string' || !isAbsolute(value)) return
    if (!roots.includes(value)) roots.push(value)
  }
  add(workspaceRoot)
  try {
    const policy = ctx?.get?.('sandboxPolicy')
    const resolved = policy?.resolve?.()
    add(resolved?.workspaceRoot)
  } catch {
    // A missing policy service simply means "no deployment fallback"; the
    // registry below and the user-selected root still apply.
  }
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    const workspaces = registry?.list?.()
    if (Array.isArray(workspaces)) {
      for (const workspace of workspaces) add(workspace?.path)
    }
  } catch {
    // A deployment without the registry keeps the old fallback behavior.
  }
  try {
    // Live sessions carry the actual cwd that may not yet be duplicated in the
    // durable registry (for example, a just-created session).
    const sessions = ctx?.get?.('sessions')
    const live = sessions?.list?.()
    if (Array.isArray(live)) {
      for (const session of live) add(session?.header?.cwd ?? session?.cwd)
    }
  } catch {
    // Session service is optional; the registry and policy roots remain.
  }
  return roots
}

/**
 * Backward-compatible single-root helper.
 * @param {object} ctx - Host plugin context.
 * @param {string} [workspaceRoot] - already resolved workspace root.
 * @returns {string|undefined} first available workspace root.
 */
export function resolveWorkspaceRoot(ctx, workspaceRoot) {
  return resolveWorkspaceRoots(ctx, workspaceRoot)[0]
}

/**
 * Decide whether one path may be read over the bridge.
 * @param {object} ctx - Host plugin context.
 * @param {{mode: string, root: string|null}} policy - normalized file-read policy.
 * @param {unknown} requestedPath - absolute path from the controller.
 * @param {string} [workspaceRoot] - optional resolved session workspace root.
 * @returns {Promise<{allowed: boolean, code?: string, message?: string}>} decision.
 */
export async function decideFileRead(ctx, policy, requestedPath, workspaceRoot) {
  if (policy?.mode === 'off' || !FILE_READ_MODES.has(policy?.mode)) {
    return { allowed: false, code: 'remote-control/file-read-off', message: 'remote file access is off' }
  }
  if (typeof requestedPath !== 'string' || requestedPath === '' || !isAbsolutePath(requestedPath)) {
    return { allowed: false, code: 'bad-request', message: 'an absolute path is required' }
  }
  const target = await real(requestedPath)
  if (target === undefined) {
    return { allowed: false, code: 'remote-control/not-found', message: 'the file does not exist' }
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      return { allowed: false, code: 'remote-control/not-file', message: 'not a regular file' }
    }
  } catch {
    return { allowed: false, code: 'remote-control/not-found', message: 'the file does not exist' }
  }
  if (policy.mode === 'shared') {
    const roots = resolveWorkspaceRoots(ctx, workspaceRoot)
    if (typeof policy.root === 'string' && policy.root !== '') roots.push(policy.root)
    for (const candidate of roots) {
      const root = await real(candidate)
      if (root !== undefined && contains(root, target)) return { allowed: true, target }
    }
    return { allowed: false, code: 'remote-control/not-shared', message: 'the path is not in a shared directory' }
  }
  const home = await real(homedir())
  if (home === undefined || !contains(home, target)) {
    return { allowed: false, code: 'remote-control/not-home', message: 'the path is outside the home directory' }
  }
  for (const root of denyRoots()) {
    const canonical = await real(root)
    if (canonical !== undefined && contains(canonical, target)) {
      return { allowed: false, code: 'remote-control/denied', message: 'the path is in a protected location' }
    }
  }
  return { allowed: true, target }
}
