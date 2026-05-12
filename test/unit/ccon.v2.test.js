import { describe, it, expect } from 'vitest';
import { decodeCcon } from '../../src/core/cocos3x/ccon.js';

function makeCconV2(notepackBody) {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x4E4F4343, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(16 + notepackBody.length, 8);
  head.writeUInt32LE(notepackBody.length, 12);
  return Buffer.concat([head, notepackBody]);
}

describe('decodeCcon v2', () => {
  it('decodes notepack body into document', () => {
    const body = Buffer.from([0x93, 0x01, 0xa3, 0x74, 0x77, 0x6f, 0xc3]);
    const out = decodeCcon(makeCconV2(body));
    expect(out.version).toBe(2);
    expect(out.document).toEqual([1, 'two', true]);
    expect(out.rawJson).toBeUndefined();
  });

  it('keeps rawJson + does not throw on undecodable body', () => {
    const body = Buffer.from([0xc1]);
    const out = decodeCcon(makeCconV2(body));
    expect(out.version).toBe(2);
    expect(out.document).toBeUndefined();
    expect(Buffer.isBuffer(out.rawJson)).toBe(true);
  });
});
