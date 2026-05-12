import { describe, it, expect } from 'vitest';
import { rehydrateIFileData, DataTypeID } from '../../src/core/cocos3x/rehydrate.js';

describe('TypedArray DataTypeID', () => {
  it('exposes the enum constants', () => {
    expect(DataTypeID.TypedArray).toBe(13);
    expect(DataTypeID.TypedArray_Class).toBe(14);
  });

  it('rehydrates a single TypedArray field', () => {
    const doc = [
      1,
      [],
      [],
      [['cc.Foo', ['buf'], 3, 13]],
      [[0, 0, 1]],
      [[0, [6, 'AQID']]],
      0,
      null,
      [], [], [],
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0]).toMatchObject({
      __type__: 'cc.Foo',
      buf: { __type__: 'Float32Array', __data__: 'AQID' },
    });
  });

  it('rehydrates Array_TypedArray (TypedArray_Class as array element)', () => {
    const doc = [
      1, [], [],
      [['cc.Bar', ['arr'], 3, 14]],
      [[0, 0, 1]],
      [[0, [[6, 'AQID'], [7, 'BAUG']]]],
      0, null, [], [], [],
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0].arr).toEqual([
      { __type__: 'Float32Array', __data__: 'AQID' },
      { __type__: 'Float64Array', __data__: 'BAUG' },
    ]);
  });

  it('handles zero-length and unknown ctor', () => {
    const doc = [
      1, [], [],
      [['cc.Empty', ['a', 'b'], 3, 13, 13]],
      [[0, 0, 1, 1]],
      [[0, [6, ''], [99, 'XX']]],
      0, null, [], [], [],
    ];
    const out = rehydrateIFileData(doc);
    expect(out[0].a).toEqual({ __type__: 'Float32Array', __data__: '' });
    expect(out[0].b).toEqual({ __type__: 'unknown', __data__: 'XX', __ctor__: 99 });
  });
});
