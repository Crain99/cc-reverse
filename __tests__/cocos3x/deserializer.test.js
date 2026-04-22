const { inspect } = require('../../src/core/cocos3x/deserializer');

describe('inspect (IFileData)', () => {
  it('returns unknown for null/undefined', () => {
    expect(inspect(null).form).toBe('unknown');
  });

  it('recognises a plain __type__ document (legacy 3.x / 2.x)', () => {
    const doc = { __type__: 'cc.SceneAsset', _name: 'Main' };
    const info = inspect(doc);
    expect(info.form).toBe('plain');
    expect(info.rootClass).toBe('cc.SceneAsset');
    expect(info.name).toBe('Main');
  });

  it('gathers __uuid__ dependencies from plain docs', () => {
    const doc = {
      __type__: 'cc.Prefab',
      _name: 'Player',
      texture: { __uuid__: 'aaa-111' },
      nested: [{ __uuid__: 'bbb-222' }, { other: { __uuid__: 'ccc-333' } }],
    };
    const info = inspect(doc);
    expect(info.depends.sort()).toEqual(['aaa-111', 'bbb-222', 'ccc-333']);
  });

  it('recognises a packed IFileData tuple', () => {
    // [version, sharedUuids, sharedStrings, sharedClasses, sharedMasks, instances, ...]
    const doc = [
      1,
      ['dep-uuid-1'],
      ['SomeName'],
      [['cc.SpriteFrame', ['_name', '_texture'], 2]],
      [[0, 0, 1, 2]],  // mask
      [[0, 'Frame1', null]],  // instance
      0,
      null,
      [],
      [],
      [0],  // dependUuidIndices → sharedUuids[0]
    ];
    const info = inspect(doc);
    expect(info.form).toBe('packed');
    expect(info.rootClass).toBe('cc.SpriteFrame');
    expect(info.depends).toEqual(['dep-uuid-1']);
  });

  it('recurses into multi-packed sections', () => {
    const sectionA = [
      1, [], [], [['cc.Prefab', ['_name'], 1]], [[0, 0, 1]], [[0, 'A']], 0, null, [], [], [],
    ];
    const sectionB = [
      1, ['u-1'], [], [['cc.Texture2D', ['_name'], 1]], [[0, 0, 1]], [[0, 'B']], 0, null, [], [], [0],
    ];
    const doc = { sections: [sectionA, sectionB] };
    const info = inspect(doc);
    expect(info.form).toBe('multi-packed');
    expect(info.rootClass).toBe('cc.Prefab');
    expect(info.depends).toEqual(['u-1']);
  });
});
