import { describe, it, expect } from 'vitest';
import { runScriptRecoveryPipeline } from '../../src/core/cocos3x/scriptRecovery/pipeline.js';

describe('scriptRecovery pipeline', () => {
  it('returns empty modules array for empty input', async () => {
    const result = await runScriptRecoveryPipeline({ chunks: [] });
    expect(result.modules).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('fails closed: layer crash leaves modules at last good state', async () => {
    const chunk = { name: 'fake.js', source: 'System.register("m", [], function(){return {execute:function(){}}})' };
    const result = await runScriptRecoveryPipeline({
      chunks: [chunk],
      layers: { esmRebuilder: () => { throw new Error('boom'); } },
    });
    expect(result.modules.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.layer === 'esmRebuilder')).toBe(true);
  });
});
