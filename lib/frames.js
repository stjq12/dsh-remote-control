/**
 * Incremental WebSocket byte buffering shared by the bridge's two frame pumps.
 *
 * The old implementations concatenated every arriving chunk onto the buffer,
 * which copied a partially received 16 MB message once per chunk (quadratic).
 * This queue keeps chunks and only copies when a complete frame is taken.
 *
 * @module dsh-remote-control/lib/frames
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** A queue of received byte chunks with cheap append and one-copy take. */
export class ByteQueue {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = []
    this.offset = 0
    this.length = 0
  }

  /** Append one chunk without copying existing bytes. */
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  /** Return the first `n` bytes without consuming them. */
  peek(n) {
    const want = Math.min(Math.max(0, n), this.length)
    if (want === 0) return Buffer.alloc(0)
    const first = this.chunks[0]
    if (first !== undefined && first.length - this.offset >= want) {
      return first.subarray(this.offset, this.offset + want)
    }
    const out = Buffer.allocUnsafe(want)
    let written = 0
    let index = 0
    let offset = this.offset
    while (written < want) {
      const chunk = this.chunks[index]
      const take = Math.min(chunk.length - offset, want - written)
      chunk.copy(out, written, offset, offset + take)
      written += take
      index += 1
      offset = 0
    }
    return out
  }

  /** Remove `n` bytes from the front. */
  consume(n) {
    let left = Math.min(Math.max(0, n), this.length)
    this.length -= left
    while (left > 0) {
      const first = this.chunks[0]
      const available = first.length - this.offset
      if (left < available) {
        this.offset += left
        return
      }
      left -= available
      this.chunks.shift()
      this.offset = 0
    }
  }

  /** Return and consume the first `n` bytes in one copy. */
  take(n) {
    const out = this.peek(n)
    this.consume(out.length)
    return out
  }

  /** Drop all buffered bytes. */
  clear() {
    this.chunks.length = 0
    this.length = 0
    this.offset = 0
  }
}

/**
 * Parse one frame header and report the complete frame size.
 *
 * Client-to-server frames must be masked. The caller passes at most 14 header
 * bytes; `total` includes the 2–10 byte header, 4 byte mask, and payload.
 *
 * @param {Buffer} header - buffered bytes starting at a frame header.
 * @param {number} maxPayload - largest accepted payload in bytes.
 * @returns {{fin: boolean, opcode: number, length: number, payloadOffset: number, total: number} | {error: string}}
 */
export function frameSize(header, maxPayload) {
  if (header.length < 2) return { error: 'truncated frame' }
  const first = header[0]
  const second = header[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (header.length < 4) return { error: 'truncated frame' }
    length = header.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (header.length < 10) return { error: 'truncated frame' }
    const wide = header.readBigUInt64BE(2)
    if (wide > MAX_SAFE) return { error: 'frame too large' }
    length = Number(wide)
    offset = 10
  }
  if (length > maxPayload) return { error: 'frame exceeds maxRequestBytes' }
  if (!masked) return { error: 'client frames must be masked' }
  const payloadOffset = offset + 4
  return { fin, opcode, length, payloadOffset, total: payloadOffset + length }
}
