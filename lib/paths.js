/**
 * Cross-platform absolute-path recognition for the file/download helpers.
 *
 * The plugin runs on macOS, Linux, and Windows. A leading `/` is not the only
 * absolute form: Windows also accepts `C:\...`, `C:/...`, and UNC `\\server\...`.
 * @module dsh-remote-control/lib/paths
 */

/**
 * Whether a string is an absolute path in the current platform's spelling that
 * the bridge Host can stat. Both Windows forms are recognized on every platform
 * so a controller can pass a path from a Windows peer without local guessing.
 * @param {unknown} value - candidate path.
 * @returns {boolean} true for POSIX, drive-letter, or UNC absolute forms.
 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value === '') return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
