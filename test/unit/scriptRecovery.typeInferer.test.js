import { describe, it, expect } from 'vitest';
import { inferFieldTypes, inferType } from '../../src/core/cocos3x/scriptRecovery/typeInferer.js';

describe('Layer 5: typeInferer', () => {
  it('infers number / string / boolean from scalar field values', async () => {
    const modules = [
      {
        name: 'Player',
        ccclassName: 'Player',
        uuid: 'p-uuid',
        uuidMap: { 'p-uuid': { className: 'Player', moduleName: 'Player' } },
      },
    ];
    const context = {
      scenes: [
        [{ __type__: 'Player', _speed: 5, _name: 'hero', _alive: true }],
      ],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes).toEqual({
      _speed: 'number',
      _name: 'string',
      _alive: 'boolean',
    });
  });

  it('maps cc.* node references to engine type names', async () => {
    const modules = [
      { name: 'P', ccclassName: 'P', uuid: 'p', uuidMap: { p: { className: 'P', moduleName: 'P' } } },
    ];
    const context = {
      scenes: [
        [
          { __type__: 'P', _node: { __id__: 1 }, _sprite: { __id__: 2 } },
          { __type__: 'cc.Node' },
          { __type__: 'cc.Sprite' },
        ],
      ],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._node).toBe('Node');
    expect(out[0].fieldTypes._sprite).toBe('Sprite');
  });

  it('resolves __uuid__ asset refs to the matching ccclass when known', async () => {
    const modules = [
      { name: 'A', ccclassName: 'A', uuid: 'a', uuidMap: { a: { className: 'A', moduleName: 'A' } } },
      {
        name: 'Cfg',
        ccclassName: 'Cfg',
        uuid: 'cfg-u',
        uuidMap: { 'cfg-u': { className: 'Cfg', moduleName: 'Cfg' } },
      },
    ];
    const context = {
      scenes: [[{ __type__: 'A', _config: { __uuid__: 'cfg-u' } }]],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._config).toBe('Cfg');
  });

  it('falls back to any[] for arrays of unknown shape', async () => {
    const modules = [
      { name: 'X', ccclassName: 'X', uuid: 'x', uuidMap: { x: { className: 'X', moduleName: 'X' } } },
    ];
    const context = {
      scenes: [[{ __type__: 'X', _items: [{ __id__: 5 }, { __id__: 6 }] }]],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._items).toBe('any[]');
  });

  it('passthrough when no scenes provided', async () => {
    const modules = [{ name: 'P', ccclassName: 'P', uuid: null, uuidMap: {} }];
    const out = await inferFieldTypes(modules, {});
    expect(out[0].fieldTypes).toEqual({});
  });

  it('inferType: __uuid__ miss falls back to "any" (MVP)', () => {
    expect(inferType({ __uuid__: 'unknown-uuid' }, {}, [])).toBe('any');
  });

  it('inferType: __id__ out of bounds falls back to "any"', () => {
    const scene = [{ __type__: 'cc.Node' }];
    expect(inferType({ __id__: 99 }, {}, scene)).toBe('any');
  });

  it('aggregates uuidMap across modules: A._target → B', async () => {
    const modules = [
      {
        name: 'A',
        ccclassName: 'A',
        uuid: 'ua',
        uuidMap: { ua: { className: 'A', moduleName: 'A' } },
      },
      {
        name: 'B',
        ccclassName: 'B',
        uuid: 'ub',
        uuidMap: { ub: { className: 'B', moduleName: 'B' } },
      },
    ];
    const context = {
      scenes: [[{ __type__: 'A', _target: { __uuid__: 'ub' } }]],
    };
    const out = await inferFieldTypes(modules, context);
    expect(out[0].fieldTypes._target).toBe('B');
  });
});
