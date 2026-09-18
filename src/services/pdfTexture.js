import zlib from 'node:zlib'

/**
 * The catalogue's background texture.
 *
 * Drawn as one small repeating tile rather than a full-page picture: the
 * image is embedded once and placed many times, so a 38-page catalogue pays
 * a few kilobytes for it instead of megabytes. Kept very faint — a price
 * list is printed as often as it is read, and a strong texture prints muddy.
 */

const SIZE = 128 // pixels, drawn at 128pt so the weave stays fine

/** CRC-32, as PNG chunks require. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A truecolour PNG from a pixel painter, as a Buffer. */
function png(size, paint) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y += 1) {
    const line = y * (size * 3 + 1)
    raw[line] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = paint(x, y)
      raw[line + 1 + x * 3] = r
      raw[line + 2 + x * 3] = g
      raw[line + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let paper = null
let band = null

/** Off-white paper with a faint diagonal weave, for the body of every page. */
export function paperTile() {
  if (!paper) {
    paper = png(SIZE, (x, y) => {
      const weave = (x + y) % 16 === 0 || (x - y + SIZE) % 16 === 0
      return weave ? [246, 249, 247] : [252, 253, 252]
    })
  }
  return paper
}

/** The same weave in brand green, for the cover band. */
export function bandTile() {
  if (!band) {
    band = png(SIZE, (x, y) => {
      const weave = (x + y) % 16 === 0 || (x - y + SIZE) % 16 === 0
      return weave ? [20, 92, 60] : [15, 81, 50]
    })
  }
  return band
}

export const TILE_SIZE = SIZE
