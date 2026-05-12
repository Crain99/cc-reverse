import { describe, it, expect } from 'vitest';
import { RecoveryReport } from '../../src/core/cocos3x/recoveryReport.js';

describe('RecoveryReport', () => {
  it('records ok and failure counts per bundle', () => {
    const r = new RecoveryReport();
    r.ok('main', 'fc991dd7', 'cc.SpriteFrame');
    r.fail('main', 'aabb', 'cc.Mesh', new Error('CCON v2 not supported'));
    const s = r.summary();
    expect(s.bundles.main).toEqual({ ok: 1, failed: 1, missed: 0, byClass: { 'cc.SpriteFrame': 1, 'cc.Mesh': 0 } });
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].reason).toMatch(/CCON v2/);
  });

  it('records miss separately from ok and fail', () => {
    const r = new RecoveryReport();
    r.ok('main', 'a', 'cc.Prefab');
    r.miss('main', 'b', 'cc.Mesh');
    r.fail('main', 'c', 'cc.Texture2D', new Error('decode'));
    const s = r.summary();
    expect(s.bundles.main).toMatchObject({ ok: 1, failed: 1, missed: 1 });
    expect(r.toMarkdown()).toMatch(/missed=1/);
  });

  it('serialises to a markdown report', () => {
    const r = new RecoveryReport();
    r.ok('main', 'a', 'cc.Prefab');
    r.fail('main', 'b', 'cc.Mesh', new Error('boom'));
    const md = r.toMarkdown();
    expect(md).toMatch(/# Recovery Report/);
    expect(md).toMatch(/main.*ok=1/);
    expect(md).toMatch(/cc\.Mesh.*boom/);
  });
});
