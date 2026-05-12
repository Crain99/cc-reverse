/*
 * Minimal msgpack decoder used to read CCON v2 bodies.
 *
 * Implements the subset Cocos Creator's serialize-ccon.ts emits via
 * @cocos/notepack-lite. Reading is strictly big-endian per the msgpack spec.
 * https://github.com/msgpack/msgpack/blob/master/spec.md
 *
 * Not handled (errors loudly): ext types, timestamp, str32 over 2GB.
 */

function decodeNotepack(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('decodeNotepack: expected Buffer');
  const r = { buf, off: 0 };
  return readValue(r);
}

function readValue(r) {
  if (r.off >= r.buf.length) throw new Error('notepack: unexpected EOF');
  const b = r.buf[r.off++];
  if (b <= 0x7f) return b;
  if (b >= 0xe0) return b - 0x100;
  if (b >= 0xa0 && b <= 0xbf) return readStr(r, b - 0xa0);
  if (b >= 0x90 && b <= 0x9f) return readArr(r, b - 0x90);
  if (b >= 0x80 && b <= 0x8f) return readMap(r, b - 0x80);

  switch (b) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBin(r, readU8(r));
    case 0xc5: return readBin(r, readU16(r));
    case 0xc6: return readBin(r, readU32(r));
    case 0xca: { ensure(r, 4); const v = r.buf.readFloatBE(r.off); r.off += 4; return v; }
    case 0xcb: { ensure(r, 8); const v = r.buf.readDoubleBE(r.off); r.off += 8; return v; }
    case 0xcc: return readU8(r);
    case 0xcd: return readU16(r);
    case 0xce: return readU32(r);
    case 0xcf: return readU64(r);
    case 0xd0: { ensure(r, 1); const v = r.buf.readInt8(r.off); r.off += 1; return v; }
    case 0xd1: { ensure(r, 2); const v = r.buf.readInt16BE(r.off); r.off += 2; return v; }
    case 0xd2: { ensure(r, 4); const v = r.buf.readInt32BE(r.off); r.off += 4; return v; }
    case 0xd3: return readI64(r);
    case 0xd9: return readStr(r, readU8(r));
    case 0xda: return readStr(r, readU16(r));
    case 0xdb: return readStr(r, readU32(r));
    case 0xdc: return readArr(r, readU16(r));
    case 0xdd: return readArr(r, readU32(r));
    case 0xde: return readMap(r, readU16(r));
    case 0xdf: return readMap(r, readU32(r));
    default:
      throw new Error(`notepack: unsupported opcode 0x${b.toString(16)} at offset ${r.off - 1}`);
  }
}

function readU8(r)  { ensure(r, 1); const v = r.buf.readUInt8(r.off);    r.off += 1; return v; }
function readU16(r) { ensure(r, 2); const v = r.buf.readUInt16BE(r.off); r.off += 2; return v; }
function readU32(r) { ensure(r, 4); const v = r.buf.readUInt32BE(r.off); r.off += 4; return v; }
function readU64(r) { ensure(r, 8); const v = Number(r.buf.readBigUInt64BE(r.off)); r.off += 8; return v; }
function readI64(r) { ensure(r, 8); const v = Number(r.buf.readBigInt64BE(r.off));  r.off += 8; return v; }

function readStr(r, n) {
  ensure(r, n);
  const s = r.buf.toString('utf-8', r.off, r.off + n);
  r.off += n;
  return s;
}
function readBin(r, n) {
  ensure(r, n);
  const slice = Buffer.from(r.buf.subarray(r.off, r.off + n));
  r.off += n;
  return slice;
}
function readArr(r, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readValue(r);
  return out;
}
function readMap(r, n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = readValue(r);
    const v = readValue(r);
    out[String(k)] = v;
  }
  return out;
}
function ensure(r, n) {
  if (r.off + n > r.buf.length) throw new Error(`notepack: unexpected EOF (need ${n} bytes at ${r.off})`);
}

module.exports = { decodeNotepack };
