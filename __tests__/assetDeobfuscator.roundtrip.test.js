/**
 * Round-trip decodability tests for assetDeobfuscator, covering the full
 * 2x2 matrix of (scheme x loader path):
 *
 *   | Scheme  | Loader path  | Expected transform          |
 *   |---------|--------------|------------------------------|
 *   | 11-byte | image/blob   | strip 11                    |
 *   | 11-byte | arraybuffer  | strip 11 + XOR 1             |
 *   | 18-byte | image/blob   | strip 18 + 74               |
 *   | 18-byte | arraybuffer  | strip 18 + rotating-key XOR  |
 *
 * __tests__/assetDeobfuscator.test.js already covers the transforms with
 * synthetic buffers (prefix arithmetic only). This file additionally proves
 * each branch produces a *decodable* artifact: for the image rows, a real
 * minimal valid PNG is built in-code, obfuscated, deobfuscated, and the
 * result is asserted byte-exact against the original PNG AND independently
 * decodable via `image-size` (a real PNG parser, not just a byte compare).
 * For the arraybuffer rows, a synthetic binary payload proves the XOR is
 * correctly inverted (XOR is its own inverse).
 *
 * No real game assets are used as fixtures; everything is constructed here.
 */

const zlib = require('zlib');
const sizeOf = require('image-size');
const {
  deobfuscateAsset,
  MARKER_A,
  MARKER_B,
  MARKER_B_IMAGE_PAD,
  XOR_KEY,
} = require('../src/core/assetDeobfuscator');

// ---------------------------------------------------------------------------
// Minimal real PNG builder (no external deps; hand-rolled CRC32 + Node's
// built-in zlib for the IDAT deflate stream).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} tag 4-char chunk type @param {Buffer} data @returns {Buffer} */
function pngChunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tagAndData = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagAndData), 0);
  return Buffer.concat([len, tagAndData, crc]);
}

/**
 * Build a real, valid, minimal 2x2 RGB PNG (8-bit, no filter tricks beyond
 * "none") entirely in-code. Independently decodable by any PNG parser.
 * @returns {Buffer}
 */
function buildMinimalPng() {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = 2;
  const height = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace

  // 2 scanlines, each: 1 filter-type byte (0 = none) + 2 RGB pixels (6 bytes).
  const raw = Buffer.from([
    0, 255, 0, 0, 0, 255, 0, // row 0: red, green
    0, 0, 0, 255, 128, 128, 128, // row 1: blue, gray
  ]);
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** @param {Buffer[]} keyBytes @param {Buffer} data @returns {Buffer} */
function rotatingXor(data, key) {
  const out = Buffer.alloc(data.length);
  let c = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (c >= key.length) c = 0;
    out[i] = data[i] ^ key[c];
    c += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures shared across tests
// ---------------------------------------------------------------------------

const REAL_PNG = buildMinimalPng();
const REAL_PNG_DIMS = sizeOf(REAL_PNG);

describe('assetDeobfuscator round-trip decodability (2x2 scheme x loader-path matrix)', () => {
  beforeAll(() => {
    // Sanity: the fixture itself must be a real, decodable PNG before we
    // start obfuscating/deobfuscating it, otherwise every test below is
    // meaningless.
    expect(REAL_PNG_DIMS).toEqual({ width: 2, height: 2, type: 'png' });
  });

  it('11-byte marker (ADW), image/blob path: strip 11, byte-exact PNG, still decodable', () => {
    const obfuscated = Buffer.concat([MARKER_A, REAL_PNG]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.png');

    expect(scheme).toBe('ADW');
    expect(data).toEqual(REAL_PNG);
    expect(sizeOf(data)).toEqual(REAL_PNG_DIMS);
  });

  it('11-byte marker (ADW), arraybuffer path: strip 11 + XOR 1, round-trips a binary payload', () => {
    const plaintext = Buffer.from('BINARY-PAYLOAD-not-a-real-mp3-just-bytes-0123456789', 'latin1');
    const xored = Buffer.from(plaintext.map((b) => b ^ 1));
    const obfuscated = Buffer.concat([MARKER_A, xored]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.mp3');

    expect(scheme).toBe('ADW');
    expect(data).toEqual(plaintext);
    // XOR is its own inverse: re-applying XOR 1 to the recovered plaintext
    // must reproduce exactly the bytes that were on the wire.
    expect(Buffer.from(data.map((b) => b ^ 1))).toEqual(xored);
  });

  it('18-byte marker (Gj) + 74-byte pad, image/blob path: strip 92, byte-exact PNG, still decodable', () => {
    const pad = Buffer.alloc(MARKER_B_IMAGE_PAD, 0x00);
    expect(MARKER_B.length + MARKER_B_IMAGE_PAD).toBe(92);
    const obfuscated = Buffer.concat([MARKER_B, pad, REAL_PNG]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.png');

    expect(scheme).toBe('Gj');
    expect(data).toEqual(REAL_PNG);
    expect(sizeOf(data)).toEqual(REAL_PNG_DIMS);
  });

  it('18-byte marker (Gj), arraybuffer path: strip 18 + rotating-key XOR, round-trips a binary payload', () => {
    // Longer than the 16-byte key so the rotation must wrap at least once.
    const plaintext = Buffer.from('BINARY-PAYLOAD-longer-than-the-sixteen-byte-rotating-key-0123456789', 'latin1');
    expect(plaintext.length).toBeGreaterThan(XOR_KEY.length);
    const xored = rotatingXor(plaintext, XOR_KEY);
    const obfuscated = Buffer.concat([MARKER_B, xored]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.mp3');

    expect(scheme).toBe('Gj');
    expect(data).toEqual(plaintext);
    // XOR is its own inverse: re-applying the rotating key to the recovered
    // plaintext must reproduce exactly the bytes that were on the wire.
    expect(rotatingXor(data, XOR_KEY)).toEqual(xored);
  });

  it('jpeg through the Gj+74 image branch also round-trips byte-exact', () => {
    // Confidence check that .jpeg (not just .png) is routed through the
    // same header-strip-only image branch and comes out byte-exact.
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const pad = Buffer.alloc(MARKER_B_IMAGE_PAD, 0x00);
    const obfuscated = Buffer.concat([MARKER_B, pad, fakeJpeg]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.jpeg');

    expect(scheme).toBe('Gj');
    expect(data).toEqual(fakeJpeg);
  });
});
