# Resource Processor Rebuild + Skeleton Support

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor resourceProcessor.js to use a registry-based type handler system, fix 3 known bugs, and add Spine/DragonBones skeleton resource extraction.

**Architecture:** Replace the if/else type routing with a handler registry (`Map<string, HandlerFn>`). Each resource type registers a handler function that receives `(data, key, context)`. The context object provides `fileMap`, `fileList`, and helper methods for multi-file lookup (needed by skeleton resources). Bug fixes are applied as part of the refactor.

**Tech Stack:** Node.js, Jest for testing, no new dependencies.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/core/resourceProcessor.js` | Core refactor: registry, bug fixes, skeleton handlers |
| Modify | `__tests__/resourceProcessor.test.js` | Add tests for bug fixes and skeleton handlers |

All changes in 2 files. No new files created.

---

### Task 1: Fix `fileMap` key extraction bug

**Files:**
- Modify: `__tests__/resourceProcessor.test.js`
- Modify: `src/core/resourceProcessor.js:98`

- [ ] **Step 1: Write failing test**

```js
test('fileMap key should handle paths with dots correctly', async () => {
  const mockStat = jest.fn().mockResolvedValue({ isFile: () => true });
  jest.spyOn(require('fs'), 'readdir').mockImplementation((p, cb) => cb(null, ['a1b2c3.json']));
  jest.spyOn(require('fs'), 'stat').mockImplementation((p, cb) => cb(null, { isFile: () => true }));

  // Reset state
  resourceProcessor.resetState();
  resourceProcessor.fileList = [];
  resourceProcessor.fileMap = new Map();

  // Simulate adding a file with UUID-style name
  const fullPath = '/tmp/res/import/a1b2c3.json';
  resourceProcessor.fileList.push(fullPath);
  // Current buggy logic: path.basename(fullPath.split('.')[0])
  // Would produce basename of '/tmp/res/import/a1b2c3' = 'a1b2c3' ✓
  // But for '/tmp/res/import/a1.b2c3.json' it produces 'a1' ✗

  const fullPathWithDot = '/tmp/res/import/a1.b2c3.json';
  const key = path.basename(fullPathWithDot, path.extname(fullPathWithDot));
  expect(key).toBe('a1.b2c3');
});
```

- [ ] **Step 2: Run test to verify understanding**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js --verbose`

- [ ] **Step 3: Fix the key extraction in resourceProcessor.js**

Replace line 98:
```js
// Before (buggy):
this.fileMap.set(path.basename(fullPath.split('.')[0]), fullPath);

// After (fixed):
const basename = path.basename(fullPath);
const key = basename.substring(0, basename.lastIndexOf('.')) || basename;
this.fileMap.set(key, fullPath);
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "fix: fileMap key extraction for paths with dots"
```

---

### Task 2: Fix `nodeData` overwrite bug

**Files:**
- Modify: `__tests__/resourceProcessor.test.js`
- Modify: `src/core/resourceProcessor.js:143`

- [ ] **Step 1: Write failing test**

```js
test('processJsonFiles should accumulate nodeData per key, not overwrite', async () => {
  resourceProcessor.resetState();

  // Simulate two JSON files already loaded
  resourceProcessor.fileList = ['/tmp/res/aaa.json', '/tmp/res/bbb.json'];
  resourceProcessor.fileMap = new Map();

  jest.spyOn(require('fs'), 'readFile').mockImplementation((p, cb) => {
    if (p.includes('aaa')) {
      cb(null, Buffer.from(JSON.stringify({ scene: { __type__: 'cc.SceneAsset' } })));
    } else {
      cb(null, Buffer.from(JSON.stringify({ clip: { __type__: 'cc.AnimationClip' } })));
    }
  });

  jest.spyOn(resourceProcessor, 'processData').mockResolvedValue();

  await resourceProcessor.processJsonFiles();

  // nodeData should be a map keyed by filename, not a single overwritten object
  expect(resourceProcessor.nodeData['aaa']).toBeDefined();
  expect(resourceProcessor.nodeData['bbb']).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "nodeData" --verbose`
Expected: FAIL

- [ ] **Step 3: Fix nodeData to accumulate by key**

In `processJsonFiles()`, change:
```js
// Before:
this.nodeData = data;

// After:
this.nodeData[key] = data;
```

In `resetState()`, change:
```js
// Before:
this.nodeData = {};

// After (same, but confirm it's already object):
this.nodeData = {};
```

In `processSceneAsset()`, update references from `this.nodeData` to iterate `this.nodeData[key]` or the specific data passed in.

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "fix: nodeData accumulates per key instead of overwriting"
```

---

### Task 3: Refactor type routing to registry pattern

**Files:**
- Modify: `src/core/resourceProcessor.js`
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write test for registry-based routing**

```js
test('type handler registry should route to correct handler', () => {
  resourceProcessor.resetState();

  const mockHandler = jest.fn();
  resourceProcessor.registerHandler('cc.TestType', mockHandler);

  const data = { __type__: 'cc.TestType', _name: 'test' };
  resourceProcessor.writeProcessedData({ '0': data }, 'testkey');

  expect(mockHandler).toHaveBeenCalledWith(data, 'testkey', expect.any(Object));
});

test('unknown type should be silently skipped', () => {
  resourceProcessor.resetState();

  const data = { __type__: 'cc.UnknownType', _name: 'test' };
  expect(() => resourceProcessor.writeProcessedData({ '0': data }, 'testkey')).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "registry" --verbose`
Expected: FAIL — `registerHandler` not defined

- [ ] **Step 3: Implement registry pattern**

Add to `resourceProcessor`:

```js
// Handler registry
typeHandlers: new Map(),

registerHandler(type, handler) {
    this.typeHandlers.set(type, handler);
},

// Initialize built-in handlers
initHandlers() {
    this.registerHandler('cc.SceneAsset', (data, key, ctx) => this.processSceneAsset(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.SpriteFrame', (data, key, ctx) => this.processSpriteFrame(ctx.parentData, ctx.index, key));
    this.registerHandler('cc.AudioClip', (data, key) => this.processAudioClip(data, key));
    this.registerHandler('cc.TextAsset', (data, key) => this.processTextAsset(data, key));
    this.registerHandler('cc.AnimationClip', (data, key) => this.processAnimationClip(data, key));
},
```

Replace `processTypeData` and `processTypeObject` with unified dispatch in `writeProcessedData`:

```js
writeProcessedData(data, key) {
    if (!data || typeof data !== "object") return;

    if (data["__type__"]) {
        const handler = this.typeHandlers.get(data["__type__"]);
        if (handler) handler(data, key, { parentData: data, index: null });
        return;
    }

    for (const i in data) {
        const item = data[i];
        if (!item || typeof item !== "object") continue;

        if (Array.isArray(item)) {
            this.writeProcessedData(item, key);
        } else if (item['__type__']) {
            const handler = this.typeHandlers.get(item['__type__']);
            if (handler) handler(item, key, { parentData: data, index: i });
        }
    }
},
```

Call `this.initHandlers()` at the top of `resetState()`.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS (existing tests + new registry tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "refactor: replace type if/else chain with handler registry"
```

---

### Task 4: Add Spine SkeletonData handler

**Files:**
- Modify: `src/core/resourceProcessor.js`
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write failing test**

```js
test('sp.SkeletonData handler should extract skeleton json and queue texture copy', () => {
  resourceProcessor.resetState();

  // Mock fileMap with UUID entries
  resourceProcessor.fileMap.set('skeleton-uuid', '/tmp/res/import/skeleton-uuid.json');
  resourceProcessor.fileMap.set('tex-uuid', '/tmp/res/import/tex-uuid.png');

  const spineData = {
    __type__: 'sp.SkeletonData',
    _name: 'hero_spine',
    _native: '.json',
    _skeletonJson: { bones: [], slots: [], skins: [] },
    _atlasText: 'hero.png\nsize: 512,512\nformat: RGBA8888',
    textures: [{ __uuid__: 'tex-uuid' }]
  };

  const writeFileSpy = jest.spyOn(require('../src/utils/fileManager').fileManager, 'writeFile').mockResolvedValue();

  resourceProcessor.writeProcessedData({ '0': spineData }, 'skeleton-uuid');

  // Should write skeleton JSON
  expect(writeFileSpy).toHaveBeenCalledWith(
    'Spine',
    'hero_spine.json',
    expect.objectContaining({ bones: [] })
  );

  // Should write atlas text
  expect(writeFileSpy).toHaveBeenCalledWith(
    'Spine',
    'hero_spine.atlas',
    expect.stringContaining('hero.png')
  );

  // Should write meta
  expect(writeFileSpy).toHaveBeenCalledWith(
    'Spine',
    'hero_spine.json.meta',
    expect.objectContaining({ ver: '1.2.7' })
  );

  // Should queue texture for copy
  expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/tex-uuid.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "SkeletonData" --verbose`
Expected: FAIL

- [ ] **Step 3: Implement Spine handler**

Add to `resourceProcessor`:

```js
processSpineSkeletonData(data, key) {
    const name = data['_name'];
    const _mkdir = 'Spine';
    const uuid = key;

    // 1. Write skeleton JSON data
    if (data['_skeletonJson']) {
        fileManager.writeFile(_mkdir, name + '.json', data['_skeletonJson']);
    } else if (this.fileMap.has(uuid)) {
        // Skeleton data is in a separate file, queue for copy
        this.cacheReadList.push(this.fileMap.get(uuid));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data['_native'] || '.json')));
        this.fileMap.delete(uuid);
    }

    // 2. Write atlas text
    if (data['_atlasText']) {
        fileManager.writeFile(_mkdir, name + '.atlas', data['_atlasText']);
    }

    // 3. Queue texture files for copy
    if (data['textures'] && Array.isArray(data['textures'])) {
        data['textures'].forEach((tex, i) => {
            const texUuid = tex['__uuid__'] || tex;
            if (this.fileMap.has(texUuid)) {
                const ext = i === 0 ? '.png' : `_${i}.png`;
                this.cacheReadList.push(this.fileMap.get(texUuid));
                this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + ext));
                this.fileMap.delete(texUuid);
            }
        });
    }

    // 4. Write meta file
    const metaData = {
        "ver": "1.2.7",
        "uuid": uuid,
        "optimizationPolicy": "AUTO",
        "asyncLoadAssets": false,
        "readonly": false,
        "subMetas": {}
    };
    fileManager.writeFile(_mkdir, name + '.json.meta', metaData);
},
```

Register in `initHandlers()`:
```js
this.registerHandler('sp.SkeletonData', (data, key) => this.processSpineSkeletonData(data, key));
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "feat: add Spine sp.SkeletonData resource extraction"
```

---

### Task 5: Add DragonBones handlers

**Files:**
- Modify: `src/core/resourceProcessor.js`
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write failing tests**

```js
test('dragonBones.DragonBonesAsset handler should extract skeleton data', () => {
  resourceProcessor.resetState();
  resourceProcessor.fileMap.set('db-uuid', '/tmp/res/import/db-uuid.json');

  const dbData = {
    __type__: 'dragonBones.DragonBonesAsset',
    _name: 'dragon',
    _native: '_ske.json',
    _dragonBonesJson: '{"armature":[]}'
  };

  const writeFileSpy = jest.spyOn(require('../src/utils/fileManager').fileManager, 'writeFile').mockResolvedValue();

  resourceProcessor.writeProcessedData({ '0': dbData }, 'db-uuid');

  expect(writeFileSpy).toHaveBeenCalledWith('DragonBones', 'dragon_ske.json', '{"armature":[]}');
  expect(writeFileSpy).toHaveBeenCalledWith('DragonBones', 'dragon_ske.json.meta', expect.objectContaining({ ver: '1.2.7' }));
});

test('dragonBones.DragonBonesAtlasAsset handler should extract atlas and queue texture', () => {
  resourceProcessor.resetState();
  resourceProcessor.fileMap.set('dbatlas-uuid', '/tmp/res/import/dbatlas-uuid.json');
  resourceProcessor.fileMap.set('dbtex-uuid', '/tmp/res/import/dbtex-uuid.png');

  const dbAtlasData = {
    __type__: 'dragonBones.DragonBonesAtlasAsset',
    _name: 'dragon',
    _native: '_tex.json',
    _textureAtlasData: '{"imagePath":"dragon_tex.png"}',
    _texture: { __uuid__: 'dbtex-uuid' }
  };

  const writeFileSpy = jest.spyOn(require('../src/utils/fileManager').fileManager, 'writeFile').mockResolvedValue();

  resourceProcessor.writeProcessedData({ '0': dbAtlasData }, 'dbatlas-uuid');

  expect(writeFileSpy).toHaveBeenCalledWith('DragonBones', 'dragon_tex.json', expect.any(String));
  expect(resourceProcessor.cacheReadList).toContain('/tmp/res/import/dbtex-uuid.png');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "dragonBones" --verbose`
Expected: FAIL

- [ ] **Step 3: Implement DragonBones handlers**

Add to `resourceProcessor`:

```js
processDragonBonesAsset(data, key) {
    const name = data['_name'];
    const _mkdir = 'DragonBones';
    const uuid = key;

    // Write skeleton data
    if (data['_dragonBonesJson']) {
        fileManager.writeFile(_mkdir, name + '_ske.json', data['_dragonBonesJson']);
    } else if (this.fileMap.has(uuid)) {
        this.cacheReadList.push(this.fileMap.get(uuid));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data['_native'] || '_ske.json')));
        this.fileMap.delete(uuid);
    }

    // Write meta
    const metaData = {
        "ver": "1.2.7",
        "uuid": uuid,
        "optimizationPolicy": "AUTO",
        "asyncLoadAssets": false,
        "readonly": false,
        "subMetas": {}
    };
    fileManager.writeFile(_mkdir, name + '_ske.json.meta', metaData);
},

processDragonBonesAtlasAsset(data, key) {
    const name = data['_name'];
    const _mkdir = 'DragonBones';
    const uuid = key;

    // Write atlas JSON
    if (data['_textureAtlasData']) {
        fileManager.writeFile(_mkdir, name + '_tex.json', data['_textureAtlasData']);
    } else if (this.fileMap.has(uuid)) {
        this.cacheReadList.push(this.fileMap.get(uuid));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + (data['_native'] || '_tex.json')));
        this.fileMap.delete(uuid);
    }

    // Queue texture for copy
    const texRef = data['_texture'];
    if (texRef) {
        const texUuid = texRef['__uuid__'] || texRef;
        if (this.fileMap.has(texUuid)) {
            this.cacheReadList.push(this.fileMap.get(texUuid));
            this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + '_tex.png'));
            this.fileMap.delete(texUuid);
        }
    }

    // Write meta
    const metaData = {
        "ver": "1.2.7",
        "uuid": uuid,
        "optimizationPolicy": "AUTO",
        "asyncLoadAssets": false,
        "readonly": false,
        "subMetas": {}
    };
    fileManager.writeFile(_mkdir, name + '_tex.json.meta', metaData);
},
```

Register in `initHandlers()`:
```js
this.registerHandler('dragonBones.DragonBonesAsset', (data, key) => this.processDragonBonesAsset(data, key));
this.registerHandler('dragonBones.DragonBonesAtlasAsset', (data, key) => this.processDragonBonesAtlasAsset(data, key));
```

- [ ] **Step 4: Run all tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "feat: add DragonBones resource extraction"
```

---

### Task 6: Remove dead code and verify full integration

**Files:**
- Modify: `src/core/resourceProcessor.js`

- [ ] **Step 1: Remove `processTypeData` and `processTypeObject` methods**

These are now replaced by the registry dispatch in `writeProcessedData`. Delete both methods entirely.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/resourceProcessor.js
git commit -m "chore: remove dead type routing methods replaced by registry"
```
