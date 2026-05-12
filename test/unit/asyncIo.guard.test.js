import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORBIDDEN = /\bfs\.(readFileSync|writeFileSync|statSync|readdirSync|mkdirSync|copyFileSync|existsSync|rmSync|unlinkSync)\b/;

const FILES = [
  'src/core/jscDecryptor.js',
  'src/core/cocos3x/engine3x.js',
];

describe('async io guard', () => {
  for (const rel of FILES) {
    it(`${rel} contains no fs.*Sync`, () => {
      const body = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf-8');
      const m = body.match(FORBIDDEN);
      expect(m, `Found ${m?.[0]} in ${rel}`).toBeNull();
    });
  }
});
