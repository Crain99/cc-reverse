import { describe, it, expect } from 'vitest';
import { decodeNotepack } from '../../src/core/cocos3x/notepack.js';

describe('decodeNotepack — primitives', () => {
  it('positive fixint', () => {
    expect(decodeNotepack(Buffer.from([0x00]))).toBe(0);
    expect(decodeNotepack(Buffer.from([0x7f]))).toBe(127);
  });
  it('negative fixint', () => {
    expect(decodeNotepack(Buffer.from([0xff]))).toBe(-1);
    expect(decodeNotepack(Buffer.from([0xe0]))).toBe(-32);
  });
  it('uint8/16/32', () => {
    expect(decodeNotepack(Buffer.from([0xcc, 0xff]))).toBe(255);
    expect(decodeNotepack(Buffer.from([0xcd, 0x01, 0x00]))).toBe(256);
    expect(decodeNotepack(Buffer.from([0xce, 0x00, 0x01, 0x00, 0x00]))).toBe(65536);
  });
  it('int8/16/32', () => {
    expect(decodeNotepack(Buffer.from([0xd0, 0x80]))).toBe(-128);
    expect(decodeNotepack(Buffer.from([0xd1, 0x80, 0x00]))).toBe(-32768);
  });
  it('float32 / float64', () => {
    const f32 = Buffer.alloc(5); f32[0] = 0xca; f32.writeFloatBE(1.5, 1);
    expect(decodeNotepack(f32)).toBeCloseTo(1.5);
    const f64 = Buffer.alloc(9); f64[0] = 0xcb; f64.writeDoubleBE(Math.PI, 1);
    expect(decodeNotepack(f64)).toBeCloseTo(Math.PI);
  });
  it('nil / true / false', () => {
    expect(decodeNotepack(Buffer.from([0xc0]))).toBeNull();
    expect(decodeNotepack(Buffer.from([0xc2]))).toBe(false);
    expect(decodeNotepack(Buffer.from([0xc3]))).toBe(true);
  });
  it('fixstr', () => {
    const buf = Buffer.concat([Buffer.from([0xa3]), Buffer.from('foo')]);
    expect(decodeNotepack(buf)).toBe('foo');
  });
  it('str8/16/32', () => {
    const s = 'x'.repeat(40);
    const buf = Buffer.concat([Buffer.from([0xd9, s.length]), Buffer.from(s)]);
    expect(decodeNotepack(buf)).toBe(s);
  });
});

describe('decodeNotepack — collections', () => {
  it('fixarray', () => {
    expect(decodeNotepack(Buffer.from([0x93, 0x01, 0x02, 0x03]))).toEqual([1, 2, 3]);
  });
  it('array16', () => {
    const arr = new Array(20).fill(0).map((_, i) => i);
    const head = Buffer.from([0xdc, 0x00, 20]);
    const body = Buffer.concat(arr.map(n => Buffer.from([n])));
    expect(decodeNotepack(Buffer.concat([head, body]))).toEqual(arr);
  });
  it('fixmap', () => {
    const buf = Buffer.from([
      0x82,
      0xa1, 0x61, 0x01,
      0xa1, 0x62, 0x02,
    ]);
    expect(decodeNotepack(buf)).toEqual({ a: 1, b: 2 });
  });
  it('nested', () => {
    const buf = Buffer.from([
      0x91,
      0x81,
      0xa1, 0x6b,
      0x92, 0x01, 0xa1, 0x78,
    ]);
    expect(decodeNotepack(buf)).toEqual([{ k: [1, 'x'] }]);
  });
});

describe('decodeNotepack — bin', () => {
  it('bin8 returns Buffer', () => {
    const data = Buffer.from([1, 2, 3, 4, 5]);
    const buf = Buffer.concat([Buffer.from([0xc4, 5]), data]);
    const out = decodeNotepack(buf);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(data)).toBe(true);
  });
});

describe('decodeNotepack — errors', () => {
  it('throws on unknown opcode', () => {
    expect(() => decodeNotepack(Buffer.from([0xc1]))).toThrow();
  });
  it('throws on truncated input', () => {
    expect(() => decodeNotepack(Buffer.from([0xa3, 0x66]))).toThrow();
  });
});
