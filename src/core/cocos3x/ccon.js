/*
 * Cocos Creator 3.x CCON binary decoder.
 *
 * Port of the reader in cocos/serialization/ccon.ts.
 *
 * File layout:
 *   u32 magic   = 0x4E4F4343  ("CCON" little-endian)
 *   u32 version                (1 = JSON body, 2 = notepack body)
 *   u32 totalByteLength
 *   u32 jsonLen
 *   u8[jsonLen]  jsonBlob
 *   -- 8-byte aligned chunks follow --
 *   for each chunk:
 *     u32 chunkLen
 *     u8[chunkLen] data
 */

const CCON_MAGIC = 0x4E4F4343;

/**
 * Decode a CCON buffer.
 *
 * Version 1 files are returned fully decoded: `.document` is the parsed JSON
 * (an IFileData tuple).
 *
 * Version 2 files use a notepack body; we do not ship a notepack decoder yet,
 * so we return `{ version: 2, rawJson: <Buffer>, chunks: [...] }` and let the
 * caller decide whether to fail, or to hand the raw json buffer to an external
 * decoder.
 *
 * @param {Buffer} buf
 * @returns {{ version: number, document: any, chunks: Buffer[], rawJson?: Buffer }}
 */
function decodeCcon(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('decodeCcon: expected Buffer');
  }
  if (buf.length < 16) {
    throw new Error('decodeCcon: buffer too small to be a CCON file');
  }

  const magic = buf.readUInt32LE(0);
  if (magic !== CCON_MAGIC) {
    throw new Error(
      `decodeCcon: bad magic 0x${magic.toString(16)} (expected 0x${CCON_MAGIC.toString(16)})`
    );
  }

  const version = buf.readUInt32LE(4);
  const totalByteLength = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);

  if (totalByteLength > buf.length) {
    throw new Error(
      `decodeCcon: declared totalByteLength ${totalByteLength} > buffer ${buf.length}`
    );
  }

  const jsonStart = 16;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonEnd > buf.length) {
    throw new Error('decodeCcon: json blob exceeds buffer');
  }

  const rawJson = buf.slice(jsonStart, jsonEnd);

  let document = null;
  if (version === 1) {
    const text = rawJson.toString('utf-8');
    document = JSON.parse(text);
  }

  // Chunks follow, aligned to 8 bytes after the JSON blob.
  const chunks = [];
  let offset = (jsonEnd + 7) & ~7;

  while (offset + 4 <= totalByteLength) {
    const chunkLen = buf.readUInt32LE(offset);
    offset += 4;
    if (chunkLen === 0) {
      // Terminator / padding.
      break;
    }
    if (offset + chunkLen > buf.length) {
      throw new Error(
        `decodeCcon: chunk at offset ${offset - 4} (len ${chunkLen}) overruns buffer`
      );
    }
    chunks.push(buf.slice(offset, offset + chunkLen));
    offset += chunkLen;
    // Align to 8 bytes.
    offset = (offset + 7) & ~7;
  }

  const result = { version, chunks };
  if (document !== null) {
    result.document = document;
  } else {
    result.rawJson = rawJson;
  }
  return result;
}

/**
 * Cheap check: is this buffer a CCON file?
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isCcon(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === CCON_MAGIC;
}

module.exports = { decodeCcon, isCcon, CCON_MAGIC };
