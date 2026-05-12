import { describe, it, expect } from 'vitest';
import { KLASS_TO_IMPORTER } from '../../src/core/cocos3x/engine3x.js';

describe('PR6 baseline', () => {
  it('exposes KLASS_TO_IMPORTER from engine3x', () => {
    expect(KLASS_TO_IMPORTER).toBeTypeOf('object');
    expect(KLASS_TO_IMPORTER['cc.SpriteFrame']).toBe('sprite-frame');
  });
});
