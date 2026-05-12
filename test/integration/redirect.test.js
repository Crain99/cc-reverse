import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reverseProject3x } from '../../src/core/cocos3x/engine3x.js';

let buildRoot;
let outDir;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-build-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redir-out-'));

  // Two bundles: main has a redirect entry to shared; shared owns the import.
  // UUID layout: 'aa******' so first-2-byte path-shard is 'aa'.
  const sharedUuid = 'aabbccdd-eeff-0011-2233-445566778899';

  const mainBundle = path.join(buildRoot, 'assets/main');
  const sharedBundle = path.join(buildRoot, 'assets/shared');
  fs.mkdirSync(path.join(mainBundle, 'import/aa'),    { recursive: true });
  fs.mkdirSync(path.join(sharedBundle, 'import/aa'), { recursive: true });

  // sharedBundle owns the asset (import file present).
  fs.writeFileSync(
    path.join(sharedBundle, 'import/aa', `${sharedUuid}.json`),
    JSON.stringify([{ __type__: 'cc.Asset', _name: 'redirected' }])
  );
  // sharedBundle config: declares the uuid in paths.
  fs.writeFileSync(path.join(sharedBundle, 'config.json'), JSON.stringify({
    name: 'shared',
    importBase: 'import',
    nativeBase: 'native',
    deps: [],
    types: ['cc.Asset'],
    uuids: [sharedUuid],
    paths: { '0': ['shared/redirected', 0] },
    scenes: {},
    packs: {},
    redirect: [],
    extensionMap: {},
    versions: { import: [], native: [] },
    debug: true,
  }));

  // mainBundle: declares uuid + redirect to 'shared'.
  fs.writeFileSync(path.join(mainBundle, 'config.json'), JSON.stringify({
    name: 'main',
    importBase: 'import',
    nativeBase: 'native',
    deps: ['shared'],
    types: ['cc.Asset'],
    uuids: [sharedUuid],
    paths: { '0': ['main/proxy', 0] },
    scenes: {},
    packs: {},
    redirect: [0, 0],   // uuid index 0 → dep index 0 ('shared')
    extensionMap: {},
    versions: { import: [], native: [] },
    debug: true,
  }));
});

describe('integration: cross-bundle redirect', () => {
  it('writes the redirected asset under the requesting bundle', async () => {
    await reverseProject3x({ sourcePath: buildRoot, outputPath: outDir });
    const expected = path.join(outDir, 'assets/main/main/proxy.json');
    expect(fs.existsSync(expected)).toBe(true);
    const written = JSON.parse(fs.readFileSync(expected, 'utf-8'));
    const flat = JSON.stringify(written);
    expect(flat).toContain('redirected');
  }, 30_000);
});
