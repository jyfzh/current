// Self-contained MD5 implementation (RFC 1321).
//
// The Fever API authenticates with md5("{email}:{password}") and the Workers
// runtime has no built-in MD5 (WebCrypto does not provide it), so we ship a
// small, dependency-free implementation.

// Per-round left rotation amounts.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 * abs(sin(i + 1))), the standard MD5 constant table.
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function wordToHex(word) {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Computes the lowercase hex MD5 digest of a string, hashing its UTF-8 bytes.
 *
 * @param {string} input
 * @returns {string} 32-character hex digest
 */
export function md5(input) {
  const message = new TextEncoder().encode(input);
  const length = message.length;

  // Pad the message: 0x80, zeros, then the 64-bit little-endian bit length.
  const totalLength = (((length + 1 + 8) + 63) >> 6) << 6;
  const bytes = new Uint8Array(totalLength);
  bytes.set(message);
  bytes[length] = 0x80;

  const view = new DataView(bytes.buffer);
  const bitLength = length * 8;
  view.setUint32(totalLength - 8, bitLength >>> 0, true);
  view.setUint32(totalLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint32Array(16);

  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      block[i] = view.getUint32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      f = (f + a + K[i] + block[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, S[i])) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return wordToHex(a0) + wordToHex(b0) + wordToHex(c0) + wordToHex(d0);
}
