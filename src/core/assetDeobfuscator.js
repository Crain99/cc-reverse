/*
 * De-obfuscation for native binary assets served by games that obfuscate
 * their asset bundles (e.g. Fire Kirin's CommLoading downloader).
 *
 * The server prepends a marker header to certain files. The loader strips
 * that header client-side, and for the arraybuffer branch also XORs the
 * payload. cc-reverse copies bytes verbatim, so recovered images/audio are
 * left obfuscated unless this module is applied on write.
 *
 * Algorithm reverse-engineered from the game's own loader at
 * `CommLoading/downLoadPlugin.fd4e9.js`. Two independent marker schemes,
 * and two independent branches (image vs. binary) with different handling:
 *
 *   - Image branch (responseType === 'blob', used for png/jpg/jpeg):
 *       strip header only, no XOR.
 *   - Binary branch (responseType === 'arraybuffer', used for audio and
 *     other binaries): strip header AND XOR the remaining bytes.
 */

/** MARKER_A header, 11 bytes. */
const MARKER_A = Buffer.from('@@@ADW@@@%%', 'latin1');

/** MARKER_B header, 18 bytes (contains a backtick). */
const MARKER_B = Buffer.from("Gj&e5/S%*z]~)i!O`r", 'latin1');

/** Extra bytes stripped after MARKER_B in the image branch only. */
const MARKER_B_IMAGE_PAD = 74;

/** Rotating XOR key used for MARKER_B in the binary branch. */
const XOR_KEY = [75, 108, 38, 101, 5, 47, 82, 35, 41, 93, 126, 43, 105, 79, 96, 118];

/** Extensions routed through the image branch (blob, header-strip only). */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * @param {Buffer} buffer
 * @param {Buffer} marker
 * @returns {boolean}
 */
function startsWith(buffer, marker) {
  if (buffer.length < marker.length) return false;
  return buffer.subarray(0, marker.length).equals(marker);
}

/**
 * Image branch: strip the marker header only. No XOR is ever applied here.
 *
 * @param {Buffer} buffer
 * @returns {{ data: Buffer, scheme: 'plain'|'ADW'|'Gj' }}
 */
function deobfuscateImage(buffer) {
  if (startsWith(buffer, MARKER_A)) {
    return { data: buffer.subarray(MARKER_A.length), scheme: 'ADW' };
  }
  if (startsWith(buffer, MARKER_B)) {
    return { data: buffer.subarray(MARKER_B.length + MARKER_B_IMAGE_PAD), scheme: 'Gj' };
  }
  return { data: buffer, scheme: 'plain' };
}

/**
 * Binary branch: strip the marker header, then XOR the remaining bytes.
 * MARKER_A uses a constant XOR of 1. MARKER_B uses a 16-byte rotating key.
 *
 * @param {Buffer} buffer
 * @returns {{ data: Buffer, scheme: 'plain'|'ADW'|'Gj' }}
 */
function deobfuscateBinary(buffer) {
  if (startsWith(buffer, MARKER_A)) {
    const d = Buffer.from(buffer.subarray(MARKER_A.length));
    for (let i = 0; i < d.length; i += 1) {
      d[i] ^= 1;
    }
    return { data: d, scheme: 'ADW' };
  }
  if (startsWith(buffer, MARKER_B)) {
    const d = Buffer.from(buffer.subarray(MARKER_B.length));
    let c = 0;
    for (let i = 0; i < d.length; i += 1) {
      if (c >= XOR_KEY.length) c = 0;
      d[i] ^= XOR_KEY[c];
      c += 1;
    }
    return { data: d, scheme: 'Gj' };
  }
  return { data: buffer, scheme: 'plain' };
}

/**
 * De-obfuscate a native asset buffer, routing to the image or binary branch
 * based on file extension. Files without a recognised marker are returned
 * byte-identical (scheme: 'plain').
 *
 * @param {Buffer} buffer  Raw bytes as received from the server.
 * @param {string} ext     File extension, including the leading dot (e.g. '.png').
 * @returns {{ data: Buffer, scheme: 'plain'|'ADW'|'Gj' }}
 */
function deobfuscateAsset(buffer, ext) {
  const normalizedExt = (ext || '').toLowerCase();
  if (IMAGE_EXTS.has(normalizedExt)) {
    return deobfuscateImage(buffer);
  }
  return deobfuscateBinary(buffer);
}

module.exports = {
  deobfuscateAsset,
  MARKER_A,
  MARKER_B,
  MARKER_B_IMAGE_PAD,
  XOR_KEY,
  IMAGE_EXTS,
};
