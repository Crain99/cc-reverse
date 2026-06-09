/*
 * Minimal MessagePack decoder.
 *
 * Cocos Creator 3.x CCON version-2 files encode their JSON body with
 * "notepack" (https://github.com/darrachequesne/notepack), a MessagePack
 * implementation. This is a dependency-free decoder covering the MessagePack
 * wire format that notepack emits, so we can turn a v2 body back into the same
 * IFileData tuple a v1 body would have carried.
 *
 * Spec: https://github.com/msgpack/msgpack/blob/master/spec.md
 */

class Decoder {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  parse() {
    if (this.offset >= this.buf.length) {
      throw new RangeError('notepack: unexpected end of buffer');
    }
    const prefix = this.buf[this.offset];
    this.offset += 1;

    // positive fixint
    if (prefix < 0x80) return prefix;
    // negative fixint
    if (prefix >= 0xe0) return prefix - 0x100;
    // fixstr
    if (prefix >= 0xa0 && prefix <= 0xbf) return this.readStr(prefix & 0x1f);
    // fixmap
    if (prefix >= 0x80 && prefix <= 0x8f) return this.readMap(prefix & 0x0f);
    // fixarray
    if (prefix >= 0x90 && prefix <= 0x9f) return this.readArray(prefix & 0x0f);

    switch (prefix) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;

      case 0xc4: return this.readBin(this.readUInt(1));
      case 0xc5: return this.readBin(this.readUInt(2));
      case 0xc6: return this.readBin(this.readUInt(4));

      case 0xc7: return this.readExt(this.readUInt(1));
      case 0xc8: return this.readExt(this.readUInt(2));
      case 0xc9: return this.readExt(this.readUInt(4));

      case 0xca: return this.readFloat(4);
      case 0xcb: return this.readFloat(8);

      case 0xcc: return this.readUInt(1);
      case 0xcd: return this.readUInt(2);
      case 0xce: return this.readUInt(4);
      case 0xcf: return this.readUInt64();

      case 0xd0: return this.readInt(1);
      case 0xd1: return this.readInt(2);
      case 0xd2: return this.readInt(4);
      case 0xd3: return this.readInt64();

      case 0xd4: return this.readExtFixed(1);
      case 0xd5: return this.readExtFixed(2);
      case 0xd6: return this.readExtFixed(4);
      case 0xd7: return this.readExtFixed(8);
      case 0xd8: return this.readExtFixed(16);

      case 0xd9: return this.readStr(this.readUInt(1));
      case 0xda: return this.readStr(this.readUInt(2));
      case 0xdb: return this.readStr(this.readUInt(4));

      case 0xdc: return this.readArray(this.readUInt(2));
      case 0xdd: return this.readArray(this.readUInt(4));

      case 0xde: return this.readMap(this.readUInt(2));
      case 0xdf: return this.readMap(this.readUInt(4));

      default:
        throw new Error(`notepack: unknown prefix 0x${prefix.toString(16)} at ${this.offset - 1}`);
    }
  }

  require(n) {
    if (this.offset + n > this.buf.length) {
      throw new RangeError('notepack: unexpected end of buffer');
    }
  }

  readUInt(size) {
    this.require(size);
    let v;
    switch (size) {
      case 1: v = this.buf.readUInt8(this.offset); break;
      case 2: v = this.buf.readUInt16BE(this.offset); break;
      case 4: v = this.buf.readUInt32BE(this.offset); break;
      default: throw new Error(`notepack: bad uint size ${size}`);
    }
    this.offset += size;
    return v;
  }

  readInt(size) {
    this.require(size);
    let v;
    switch (size) {
      case 1: v = this.buf.readInt8(this.offset); break;
      case 2: v = this.buf.readInt16BE(this.offset); break;
      case 4: v = this.buf.readInt32BE(this.offset); break;
      default: throw new Error(`notepack: bad int size ${size}`);
    }
    this.offset += size;
    return v;
  }

  readUInt64() {
    this.require(8);
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }

  readInt64() {
    this.require(8);
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return v >= min && v <= max ? Number(v) : v;
  }

  readFloat(size) {
    this.require(size);
    const v = size === 4
      ? this.buf.readFloatBE(this.offset)
      : this.buf.readDoubleBE(this.offset);
    this.offset += size;
    return v;
  }

  readStr(len) {
    this.require(len);
    const s = this.buf.toString('utf-8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  readBin(len) {
    this.require(len);
    const b = this.buf.slice(this.offset, this.offset + len);
    this.offset += len;
    return b;
  }

  readArray(len) {
    const arr = new Array(len);
    for (let i = 0; i < len; i += 1) arr[i] = this.parse();
    return arr;
  }

  readMap(len) {
    const obj = {};
    for (let i = 0; i < len; i += 1) {
      const key = this.parse();
      obj[String(key)] = this.parse();
    }
    return obj;
  }

  readExt(len) {
    // type byte, then `len` bytes of data — preserved as raw bytes.
    this.require(len + 1);
    const type = this.buf.readInt8(this.offset);
    const data = this.buf.slice(this.offset + 1, this.offset + 1 + len);
    this.offset += len + 1;
    return { __ext__: type, data };
  }

  readExtFixed(len) {
    return this.readExt(len);
  }
}

/**
 * Decode a MessagePack (notepack) buffer into a JS value.
 * @param {Buffer} buf
 * @returns {any}
 */
function decode(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('notepack.decode: expected Buffer');
  }
  if (buf.length === 0) {
    throw new RangeError('notepack.decode: empty buffer');
  }
  const dec = new Decoder(buf);
  const value = dec.parse();
  // A well-formed body encodes exactly one value and consumes the whole
  // buffer. Trailing bytes mean this isn't notepack (or it's corrupt), so we
  // reject rather than silently returning a partial decode.
  if (dec.offset !== buf.length) {
    throw new Error(`notepack.decode: ${buf.length - dec.offset} trailing byte(s)`);
  }
  return value;
}

module.exports = { decode };
