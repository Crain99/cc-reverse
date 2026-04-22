const { decodeCcon, isCcon, CCON_MAGIC } = require('../../src/core/cocos3x/ccon');

function buildCcon({ version = 1, json = '{}', chunks = [] }) {
  const jsonBuf = Buffer.from(json, 'utf-8');
  const jsonLen = jsonBuf.length;
  const headerLen = 16;
  const alignedJsonEnd = ((headerLen + jsonLen) + 7) & ~7;

  const chunkBuffers = chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf-8')));
  // Each chunk block spans [u32 len][payload][padding to next 8-byte boundary].
  let chunkTotal = 0;
  for (const buf of chunkBuffers) {
    chunkTotal += ((4 + buf.length) + 7) & ~7;
  }

  const total = alignedJsonEnd + chunkTotal;
  const out = Buffer.alloc(total, 0);
  out.writeUInt32LE(CCON_MAGIC, 0);
  out.writeUInt32LE(version, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonLen, 12);
  jsonBuf.copy(out, headerLen);

  let offset = alignedJsonEnd;
  for (const buf of chunkBuffers) {
    out.writeUInt32LE(buf.length, offset);
    offset += 4;
    buf.copy(out, offset);
    offset += buf.length;
    offset = (offset + 7) & ~7;
  }
  return out;
}

describe('isCcon', () => {
  it('rejects short buffers', () => {
    expect(isCcon(Buffer.from([0, 1, 2]))).toBe(false);
  });
  it('accepts files with CCON magic', () => {
    expect(isCcon(buildCcon({ json: '[]' }))).toBe(true);
  });
  it('rejects buffers with wrong magic', () => {
    expect(isCcon(Buffer.from([1, 2, 3, 4, 5]))).toBe(false);
  });
});

describe('decodeCcon', () => {
  it('decodes a v1 file with JSON document', () => {
    const buf = buildCcon({ json: JSON.stringify({ hello: 'world' }) });
    const decoded = decodeCcon(buf);
    expect(decoded.version).toBe(1);
    expect(decoded.document).toEqual({ hello: 'world' });
    expect(decoded.chunks).toEqual([]);
  });

  it('decodes v1 with chunks', () => {
    const buf = buildCcon({
      json: '[]',
      chunks: ['alpha', 'beta'],
    });
    const decoded = decodeCcon(buf);
    expect(decoded.version).toBe(1);
    expect(decoded.chunks).toHaveLength(2);
    expect(decoded.chunks[0].toString('utf-8')).toBe('alpha');
    expect(decoded.chunks[1].toString('utf-8')).toBe('beta');
  });

  it('returns rawJson for v2 files', () => {
    const buf = buildCcon({ version: 2, json: 'notepack-payload' });
    const decoded = decodeCcon(buf);
    expect(decoded.version).toBe(2);
    expect(decoded.document).toBeUndefined();
    expect(decoded.rawJson.toString('utf-8')).toBe('notepack-payload');
  });

  it('rejects buffers with wrong magic', () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(0xDEADBEEF, 0);
    expect(() => decodeCcon(buf)).toThrow(/bad magic/);
  });
});
