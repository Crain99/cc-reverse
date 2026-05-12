import { describe, it, expect } from 'vitest';
import { resolveImportThroughRedirect } from '../../src/core/cocos3x/engine3x.js';

const cfgA = {
  name: 'main',
  baseDir: '/A',
  importBase: 'import',
  nativeBase: 'native',
  versions: { import: {}, native: {} },
  redirect: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': 'shared' },
};
const cfgShared = {
  name: 'shared',
  baseDir: '/B',
  importBase: 'import',
  nativeBase: 'native',
  versions: { import: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': '1' }, native: {} },
  redirect: {},
};

describe('resolveImportThroughRedirect', () => {
  it('returns null when no redirect entry', () => {
    expect(resolveImportThroughRedirect(cfgA, 'unrelated', new Map())).toBeNull();
  });

  it('returns null when redirect target not in registry', () => {
    expect(
      resolveImportThroughRedirect(cfgA, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', new Map())
    ).toBeNull();
  });

  it('returns the dep-bundle import path when both side present', () => {
    const reg = new Map([['shared', cfgShared]]);
    const r = resolveImportThroughRedirect(cfgA, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', reg);
    expect(r).toMatchObject({ depName: 'shared', cfg: cfgShared });
    expect(r.importJsonPath.endsWith('aa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.1.json')).toBe(true);
    expect(r.importCconPath.endsWith('aa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.1.cconb')).toBe(true);
  });
});
