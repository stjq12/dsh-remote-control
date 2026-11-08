/**
 * Shared on-disk state for both directions of remote control.
 *
 * One JSON file holds two independent sections — `local` (this machine as the
 * controlled end) and `remote` (this window as the controller) — each with its
 * own switch, selected preset, and preset list. A single file keeps them atomic
 * with respect to each other: the card can flip `local.enabled` and
 * `remote.enabled` in one write, and a reader never sees one side updated and
 * the other stale.
 *
 * Writes are atomic (temp file + rename) and owner-only (`0600`), matching the
 * convention `dsh-plugin-mobile-gateway` and the standalone `dsh-remote-control`
 * already use for their state files. The profile patch is *not* written: it
 * supplies first-use defaults only, so a deployment stays reproducible.
 *
 * @module dsh-remote-control/lib/state
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeFileRead, normalizeServiceDuration, DEFAULT_SERVICE_DURATION } from './file-policy.js'

/** Current on-disk schema version. */
export const STATE_VERSION = 2

/** Per-file write queue: a mutation must not race another rename. */
const pendingWrites = new Map()

/** Preset id used when a section has never held one. */
const DEFAULT_PRESET_NAME = '默认'

/**
 * Resolve the state file for the active Harness home.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {string} absolute path.
 */
export function stateFile(ctx) {
  // The Host exposes its home through the plugin context; fall back to the
  // conventional layout when a test supplies a bare context object.
  const home =
    (typeof ctx?.get === 'function' ? ctx.get('dshHome') : undefined) ??
    process.env.DSH_HOME ??
    join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'remote-control.json')
}

/**
 * Build a fresh preset.
 * @param {{ host?: string, port?: number, token?: string, name?: string }} seed - initial values.
 * @returns {object} preset record.
 */
export function makePreset(seed = {}) {
  const host = typeof seed.host === 'string' ? seed.host.trim() : ''
  const port = Number.isInteger(seed.port) ? seed.port : 7400
  const token = typeof seed.token === 'string' ? seed.token.trim() : ''
  return {
    id: randomUUID(),
    name: typeof seed.name === 'string' && seed.name.trim() !== '' ? seed.name.trim() : `${host}:${port}`,
    host,
    port,
    token,
  }
}

/**
 * One section with a guaranteed non-empty preset list.
 * @param {string} section - `local` or `remote`.
 * @param {object} seed - first-use values.
 * @returns {object} the section.
 */
function makeSection(section, seed = {}) {
  const token = typeof seed.token === 'string' ? seed.token.trim() : ''
  const host = typeof seed.host === 'string' ? seed.host.trim() : ''
  // Only an explicit address from the profile patch creates a first preset. A
  // bare token still lives on the section, so a fresh install does not get a
  // meaningless `:7400` row it has to delete.
  const presets = []
  if (host !== '') {
    presets.push(makePreset({ host, port: seed.port, token, name: seed.name }))
  }
  return {
    section,
    enabled: false,
    activeId: presets[0]?.id ?? '',
    presets,
    token,
    fileRead: normalizeFileRead(undefined),
    durationMs: normalizeServiceDuration(DEFAULT_SERVICE_DURATION),
  }
}

/**
 * Normalize one section read from disk, repairing anything unusable.
 * @param {unknown} raw - stored value.
 * @param {string} section - `local` or `remote`.
 * @param {object} seed - first-use values used when nothing survives.
 * @returns {object} a valid section.
 */
function normalizeSection(raw, section, seed) {
  const fallback = makeSection(section, seed)
  // A section that was never written takes the seed. A section that exists but
  // holds zero presets is a deliberate state — the operator deleted them all —
  // so it stays empty instead of resurrecting a seed preset on every load.
  if (raw === null || typeof raw !== 'object') return fallback
  const presets = Array.isArray(raw.presets)
    ? raw.presets
        .filter((entry) => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : randomUUID(),
          name:
            typeof entry.name === 'string' && entry.name.trim() !== ''
              ? entry.name.trim().slice(0, 80)
              : `${String(entry.host ?? '')}:${Number(entry.port) || 7400}`,
          host: typeof entry.host === 'string' ? entry.host.trim() : '',
          port: Number.isInteger(entry.port) ? entry.port : 7400,
          token: typeof entry.token === 'string' ? entry.token.trim() : '',
        }))
    : []
  // A section-level token outlives the presets: it is this machine's identity, so
  // deleting every endpoint must not force a re-pair for an already-paired peer.
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const fileRead = normalizeFileRead(raw.fileRead)
  const durationMs = normalizeServiceDuration(raw.durationMs)
  if (presets.length === 0) {
    // No presets means nothing to enable: the switch is forced off so a reload
    // cannot bring back a listener with no endpoint behind it.
    return { section, enabled: false, activeId: '', presets: [], token, fileRead, durationMs }
  }
  const activeId = presets.some((preset) => preset.id === raw.activeId) ? raw.activeId : presets[0].id
  return { section, enabled: raw.enabled === true, activeId, presets, token, fileRead, durationMs }
}

/**
 * Read the state file, seeding a fresh record when it does not exist.
 * @param {string} file - absolute path.
 * @param {{ local?: object, remote?: object }} seeds - first-use values per section.
 * @returns {Promise<object>} the normalized state.
 */
export async function loadState(file, seeds = {}) {
  let parsed
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // A corrupt file must not take the plugin down: fall back to the seeds and
      // let the next save rewrite it. The unreadable copy stays on disk for
      // inspection because we never delete it.
      parsed = undefined
    }
  }
  return {
    version: STATE_VERSION,
    local: normalizeSection(parsed?.local, 'local', seeds.local ?? {}),
    remote: normalizeSection(parsed?.remote, 'remote', seeds.remote ?? {}),
  }
}

/**
 * Persist the state atomically with owner-only permissions.
 * @param {string} file - absolute path.
 * @param {object} state - the state to store.
 * @returns {Promise<object>} the stored state.
 */
export function saveState(file, state) {
  const previous = pendingWrites.get(file) ?? Promise.resolve()
  const task = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(file), { recursive: true })
      // The pid alone was not unique: two overlapping saves in one process wrote
      // the same temp file, so one rename could read the other's half-written
      // payload or fail with ENOENT.
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        try { await unlink(temp) } catch {}
        throw error
      }
      return state
    })
  pendingWrites.set(file, task)
  void task.finally(() => {
    if (pendingWrites.get(file) === task) pendingWrites.delete(file)
  }).catch(() => {})
  return task
}

/**
 * Reduce a section to the fields the card renders.
 * @param {object} section - normalized section.
 * @returns {{ enabled: boolean, activeId: string, presets: object[], active: object | undefined }}
 */
export function sectionView(section) {
  return {
    enabled: section.enabled === true,
    activeId: section.activeId,
    presets: section.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      host: preset.host,
      port: preset.port,
    })),
    // The token is included: the panel shows it so an operator can copy it into
    // the other machine, and these routes are loopback-only.
    active: section.presets.find((preset) => preset.id === section.activeId),
    // Machine-level token, kept when no preset holds it.
    token: section.token ?? '',
    fileRead: normalizeFileRead(section.fileRead),
    durationMs: normalizeServiceDuration(section.durationMs),
  }
}
