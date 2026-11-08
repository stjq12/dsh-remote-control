/**
 * Address validation shared by the bridge listener and its tests.
 *
 * A string allow/deny list is not enough for IPv6: `0:0:0:0:0:0:0:0` is the
 * same unspecified address as `::`, and `::ffff:0.0.0.0` is IPv4 any. This
 * module expands the literal and rejects every unspecified spelling, so the
 * "never bind every interface" guard cannot be bypassed with an equivalent
 * textual form.
 *
 * @module dsh-remote-control/lib/ip
 */

/** Strip a trailing `%zone`. */
function withoutZone(host) {
  const text = String(host ?? '')
  const at = text.indexOf('%')
  return at === -1 ? text : text.slice(0, at)
}

/** Parse an IPv4 dotted quad into its four octets, or undefined. */
function ipv4Octets(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (match === null) return undefined
  const parts = match.slice(1).map((part) => Number(part))
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return parts
}

/** Expand an IPv6 literal (including IPv4 tails) into eight 16-bit groups. */
function ipv6Groups(text) {
  let value = text.toLowerCase()
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value)
  if (tail !== null) {
    const octets = ipv4Octets(tail[1])
    if (octets === undefined) return undefined
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    value = `${value.slice(0, -tail[1].length)}${high}:${low}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  let groups
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 0) return undefined
    groups = [...head, ...Array.from({ length: fill }, () => '0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return undefined
  return groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
}

/**
 * Whether an address literal is an unspecified/wildcard address.
 * @param {string} host - IPv4/IPv6 literal, optionally zone-qualified.
 * @returns {boolean} true for `0.0.0.0`, `::`, every expanded equivalent, and IPv4-mapped any.
 */
export function isUnspecifiedAddress(host) {
  const bare = withoutZone(host)
  const v4 = ipv4Octets(bare)
  if (v4 !== undefined) return v4.every((octet) => octet === 0)
  const groups = ipv6Groups(bare)
  if (groups === undefined || groups.some((group) => Number.isNaN(group))) return false
  if (groups.every((group) => group === 0)) return true
  // ::ffff:a.b.c.d — the low 32 bits name IPv4 any.
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff &&
    groups[6] === 0 &&
    groups[7] === 0
  )
}
