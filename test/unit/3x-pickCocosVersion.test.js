import { describe, it, expect } from 'vitest';
import { pickCocosVersion } from '../../src/core/cocos3x/projectScaffold.js';

describe('pickCocosVersion (PR6 carry-over #2)', () => {
  it('accepts engineVersion verbatim', () => {
    expect(pickCocosVersion({ engineVersion: '3.8.2' })).toBe('3.8.2');
  });
  it('accepts creator.version', () => {
    expect(pickCocosVersion({ creator: { version: '3.7.0' } })).toBe('3.7.0');
  });
  it('accepts settings.version when it begins with 3.', () => {
    expect(pickCocosVersion({ version: '3.6.1' })).toBe('3.6.1');
  });
  it('rejects 2.x version strings (PR5 review nit)', () => {
    expect(pickCocosVersion({ version: '2.4.14' })).toBeNull();
  });
  it('returns null for empty/null', () => {
    expect(pickCocosVersion({})).toBeNull();
    expect(pickCocosVersion(null)).toBeNull();
  });
});
