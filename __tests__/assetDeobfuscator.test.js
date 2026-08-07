const {
  deobfuscateAsset,
  MARKER_A,
  MARKER_B,
  MARKER_B_IMAGE_PAD,
  XOR_KEY,
} = require('../src/core/assetDeobfuscator');

/** Build a fake PNG-ish plaintext payload of the given length. */
function makePlaintext(length, fill = 0x41) {
  return Buffer.alloc(length, fill);
}

describe('deobfuscateAsset', () => {
  it('MARKER_A image: strips the 11-byte header, applies no XOR', () => {
    const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const obfuscated = Buffer.concat([MARKER_A, plaintext]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.png');

    expect(scheme).toBe('ADW');
    expect(data).toEqual(plaintext);
  });

  it('MARKER_B image: strips 18 + 74 = 92 bytes, applies no XOR', () => {
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const padding = makePlaintext(MARKER_B_IMAGE_PAD, 0x00);
    const obfuscated = Buffer.concat([MARKER_B, padding, plaintext]);

    expect(MARKER_B.length + MARKER_B_IMAGE_PAD).toBe(92);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.jpg');

    expect(scheme).toBe('Gj');
    expect(data).toEqual(plaintext);
  });

  it('MARKER_A binary: strips the 11-byte header, then XORs every byte with 1', () => {
    const plaintext = Buffer.from('ID3plaintextpayload', 'latin1');
    const xored = Buffer.from(plaintext.map((b) => b ^ 1));
    const obfuscated = Buffer.concat([MARKER_A, xored]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.mp3');

    expect(scheme).toBe('ADW');
    expect(data).toEqual(plaintext);
  });

  it('MARKER_B binary: strips the 18-byte header, then applies rotating-key XOR that wraps past 16 bytes', () => {
    // 20 bytes of plaintext — longer than the 16-byte key, so the key must wrap.
    const plaintext = Buffer.from('ID3-payload-longer!!', 'latin1');
    expect(plaintext.length).toBeGreaterThan(XOR_KEY.length);

    const xored = Buffer.alloc(plaintext.length);
    let c = 0;
    for (let i = 0; i < plaintext.length; i += 1) {
      if (c >= XOR_KEY.length) c = 0;
      xored[i] = plaintext[i] ^ XOR_KEY[c];
      c += 1;
    }
    const obfuscated = Buffer.concat([MARKER_B, xored]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.mp3');

    expect(scheme).toBe('Gj');
    expect(data).toEqual(plaintext);
    // Sanity: verify the key actually wrapped for this fixture (length > 16).
    expect(plaintext.length).toBeGreaterThan(16);
  });

  it('plain input (no marker) is returned byte-identical for both branches', () => {
    const plainImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const plainBinary = Buffer.from('ID3 no marker here', 'latin1');

    const imageResult = deobfuscateAsset(plainImage, '.png');
    const binaryResult = deobfuscateAsset(plainBinary, '.mp3');

    expect(imageResult.scheme).toBe('plain');
    expect(imageResult.data).toEqual(plainImage);
    expect(binaryResult.scheme).toBe('plain');
    expect(binaryResult.data).toEqual(plainBinary);
  });

  it('routes .jpeg to the image branch too', () => {
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const obfuscated = Buffer.concat([MARKER_A, plaintext]);

    const { data, scheme } = deobfuscateAsset(obfuscated, '.jpeg');

    expect(scheme).toBe('ADW');
    expect(data).toEqual(plaintext);
  });
});
