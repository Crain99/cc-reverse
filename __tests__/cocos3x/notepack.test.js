const { decode } = require('../../src/core/cocos3x/notepack');

/**
 * Minimal MessagePack encoder for tests — covers the subset the decoder needs
 * to round-trip: null, bool, ints, float64, str, array, map.
 */
function encode(value) {
  const out = [];
  enc(value, out);
  return Buffer.from(out);
}

function enc(v, out) {
  if (v === null || v === undefined) { out.push(0xc0); return; }
  if (v === false) { out.push(0xc2); return; }
  if (v === true) { out.push(0xc3); return; }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0 && v <= 0x7f) { out.push(v); return; }
    if (Number.isInteger(v) && v < 0 && v >= -32) { out.push(v + 0x100); return; }
    if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) {
      out.push(0xce, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      return;
    }
    // float64
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    out.push(0xcb, ...b);
    return;
  }
  if (typeof v === 'string') {
    const sb = Buffer.from(v, 'utf-8');
    if (sb.length <= 31) out.push(0xa0 | sb.length);
    else { out.push(0xdb, (sb.length >>> 24) & 0xff, (sb.length >>> 16) & 0xff, (sb.length >>> 8) & 0xff, sb.length & 0xff); }
    out.push(...sb);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length <= 15) out.push(0x90 | v.length);
    else out.push(0xdc, (v.length >>> 8) & 0xff, v.length & 0xff);
    for (const item of v) enc(item, out);
    return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length <= 15) out.push(0x80 | keys.length);
    else out.push(0xde, (keys.length >>> 8) & 0xff, keys.length & 0xff);
    for (const k of keys) { enc(k, out); enc(v[k], out); }
    return;
  }
  throw new Error(`test encoder: unsupported ${typeof v}`);
}

describe('notepack.decode', () => {
  it('round-trips primitives', () => {
    expect(decode(encode(null))).toBeNull();
    expect(decode(encode(true))).toBe(true);
    expect(decode(encode(false))).toBe(false);
    expect(decode(encode(0))).toBe(0);
    expect(decode(encode(42))).toBe(42);
    expect(decode(encode(-7))).toBe(-7);
    expect(decode(encode(70000))).toBe(70000);
    expect(decode(encode(3.5))).toBeCloseTo(3.5);
  });

  it('round-trips strings', () => {
    expect(decode(encode('hello'))).toBe('hello');
    expect(decode(encode(''))).toBe('');
    expect(decode(encode('版本'))).toBe('版本');
    const long = 'x'.repeat(100);
    expect(decode(encode(long))).toBe(long);
  });

  it('round-trips arrays and maps', () => {
    expect(decode(encode([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(decode(encode({ a: 1, b: 'two' }))).toEqual({ a: 1, b: 'two' });
  });

  it('round-trips a nested IFileData-like tuple', () => {
    const doc = [
      [[{ __type__: 'cc.SpriteFrame', _name: 'icon' }]],
      [0],
      [],
      [],
      [],
      [],
    ];
    expect(decode(encode(doc))).toEqual(doc);
  });

  it('rejects buffers with trailing bytes', () => {
    const buf = Buffer.concat([encode(1), Buffer.from([0xff])]);
    expect(() => decode(buf)).toThrow(/trailing/);
  });

  it('throws on empty buffer', () => {
    expect(() => decode(Buffer.alloc(0))).toThrow();
  });

  it('throws on unknown prefix', () => {
    expect(() => decode(Buffer.from([0xc1]))).toThrow(/unknown prefix/);
  });
});

module.exports = { encode };
