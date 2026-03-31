const { typeDefinitions } = require('../src/core/typeDefinitions');

describe('typeDefinitions', () => {
  test('should have property list for cc.Node', () => {
    const props = typeDefinitions.getProperties('cc.Node');
    expect(props).toBeDefined();
    expect(Array.isArray(props)).toBe(true);
    expect(props.length).toBeGreaterThan(0);
  });

  test('should have property list for sp.SkeletonData', () => {
    const props = typeDefinitions.getProperties('sp.SkeletonData');
    expect(props).toBeDefined();
    expect(props).toContain('_name');
    expect(props).toContain('_skeletonJson');
    expect(props).toContain('_atlasText');
    expect(props).toContain('textures');
  });

  test('should have property list for dragonBones.DragonBonesAsset', () => {
    const props = typeDefinitions.getProperties('dragonBones.DragonBonesAsset');
    expect(props).toBeDefined();
    expect(props).toContain('_name');
    expect(props).toContain('_dragonBonesJson');
  });

  test('should return null for unknown type', () => {
    const props = typeDefinitions.getProperties('cc.NonExistent');
    expect(props).toBeNull();
  });

  test('registerType should add custom type', () => {
    typeDefinitions.registerType('custom.MyType', ['_name', '_data']);
    const props = typeDefinitions.getProperties('custom.MyType');
    expect(props).toEqual(['_name', '_data']);
  });
});
