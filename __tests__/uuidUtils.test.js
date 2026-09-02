const { uuidUtils } = require('../src/utils/uuidUtils');

describe('uuidUtils.decodeUuid', () => {
  it('decodes a plain 22-char compressed uuid', () => {
    const out = uuidUtils.decodeUuid('fcmR3XADNLgJ1ByKhqcC5Z');
    expect(out).toBe('fc991dd7-0033-4b80-9d41-c8a86a702e59');
  });

  it('decodes base and preserves @subAsset suffix', () => {
    expect(uuidUtils.decodeUuid('20g1ukYUVPvKWKBRznAKo+@6c48a'))
      .toBe('20835ba4-6145-4fbc-a58a-051ce700aa3e@6c48a');
    expect(uuidUtils.decodeUuid('20g1ukYUVPvKWKBRznAKo+@f9941'))
      .toBe('20835ba4-6145-4fbc-a58a-051ce700aa3e@f9941');
  });

  it('decodes multi-@ compressed native ids (mip + format)', () => {
    expect(uuidUtils.decodeUuid('6fAc9/gb9Kfr1dCvwZaWSA@b47c0@40c10'))
      .toBe('6f01cf7f-81bf-4a7e-bd5d-0afc19696480@b47c0@40c10');
  });

  it('passes through already-decoded / non-22-char ids', () => {
    const full = '20835ba4-6145-4fbc-a58a-051ce700aa3e';
    expect(uuidUtils.decodeUuid(full)).toBe(full);
    expect(uuidUtils.decodeUuid(`${full}@6c48a`)).toBe(`${full}@6c48a`);
  });
});
