import { describe, it, expect } from 'vitest';
import { rehydrateIPackedFileData } from '../../src/core/cocos3x/rehydrate.js';

describe('rehydrateIPackedFileData', () => {
  it('returns null on non-packed input', () => {
    expect(rehydrateIPackedFileData(null)).toBeNull();
    expect(rehydrateIPackedFileData([])).toBeNull();
    expect(rehydrateIPackedFileData([1, 2, 3])).toBeNull();
  });

  it('rehydrates each section against the shared header', () => {
    const arrForm = [
      1,                                                  // version
      [],                                                 // sharedUuids
      [],                                                 // sharedStrings
      [['cc.Foo', ['_name', 'value'], 2, 0, 0]],          // sharedClasses
      [[0, 0, 1, 3]],                                     // sharedMasks
      [
        [ [[0, 'A', 1]], 0, null, [], [], [] ],
        [ [[0, 'B', 2]], 0, null, [], [], [] ],
      ],
    ];
    const out = rehydrateIPackedFileData(arrForm);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toMatchObject({ __type__: 'cc.Foo', _name: 'A', value: 1 });
    expect(out[1][0]).toMatchObject({ __type__: 'cc.Foo', _name: 'B', value: 2 });
  });
});
