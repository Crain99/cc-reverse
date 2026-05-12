import { describe, it, expect } from 'vitest';
const { resolveOutputPath } = require('../../src/core/cocos3x/engine3x.js');

describe('resolveOutputPath', () => {
  it('uses cfg.paths[uuid].path when present', () => {
    const cfg = { paths: { abc: { path: 'subdir/foo' } } };
    expect(resolveOutputPath('abc', cfg, 'cc.SpriteFrame', '.png')).toContain('subdir/foo');
  });

  it('falls back to <classDir>/<uuid> when path missing', () => {
    const cfg = { paths: {} };
    const p = resolveOutputPath('abc-1234', cfg, 'cc.SpriteFrame', '.png');
    expect(p).toMatch(/texture\/abc-1234/);
  });
});
