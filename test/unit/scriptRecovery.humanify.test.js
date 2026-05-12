import { describe, it, expect } from 'vitest';

const { runHumanify, buildHumanifyArgs } = require('../../src/core/cocos3x/scriptRecovery/humanify.js');

describe('humanify wrapper', () => {
  it('buildHumanifyArgs default provider local', () => {
    const args = buildHumanifyArgs('/out', { provider: 'local' });
    expect(args[0]).toBe('local');
    expect(args).toContain('-o');
    expect(args).toContain('/out/humanified');
  });

  it('buildHumanifyArgs openai includes api base when given', () => {
    const args = buildHumanifyArgs('/out', { provider: 'openai', baseUrl: 'http://x', apiKey: 'k' });
    expect(args[0]).toBe('openai');
    expect(args.join(' ')).toContain('--api-key');
    expect(args.join(' ')).toContain('--base-url');
  });

  it('buildHumanifyArgs rejects unsupported provider', () => {
    expect(() => buildHumanifyArgs('/out', { provider: 'copilot' })).toThrow(/unsupported/i);
  });

  it('runHumanify returns { ok: false } when binary missing', async () => {
    const r = await runHumanify('/tmp/no-such-dir', {
      provider: 'local',
      _bin: '/definitely/no/such/binary/humanify-xyz',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not.*found|missing/i);
  });
});
