# revealData + SpriteFrame Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement compressed JSON data restoration (`revealData`) and complete sprite frame extraction with single-image and atlas output modes.

**Architecture:** `revealData()` detects compressed vs plain format, uses a type definitions table (with CCSettings fallback) to restore property names from array indices. `processSpriteFrame` groups frames by texture UUID, outputs as individual PNGs (default) or PLIST atlas. A new `typeDefinitions.js` provides the built-in type→property mapping.

**Tech Stack:** Node.js, xml-writer (existing), Jest for testing.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/core/typeDefinitions.js` | Built-in Cocos type property name mappings |
| Modify | `src/core/resourceProcessor.js` | Implement `revealData()`, rewrite `processSpriteFrame` |
| Modify | `src/core/converters.js` | Implement `convertSpriteAtlas()` |
| Modify | `src/config/configLoader.js` | Add `spriteOutputMode` to default config |
| Create | `__tests__/typeDefinitions.test.js` | Tests for type definitions |
| Modify | `__tests__/resourceProcessor.test.js` | Tests for revealData and processSpriteFrame |

---

### Task 1: Create type definitions table

**Files:**
- Create: `src/core/typeDefinitions.js`
- Create: `__tests__/typeDefinitions.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/typeDefinitions.test.js
const { typeDefinitions } = require('../src/core/typeDefinitions');

describe('typeDefinitions', () => {
  test('should have property list for cc.Node', () => {
    const props = typeDefinitions.getProperties('cc.Node');
    expect(props).toBeDefined();
    expect(Array.isArray(props)).toBe(true);
    expect(props.length).toBeGreaterThan(0);
  });

  test('should have property list for sp.SkeletonData', () => {
    const props = typeDefinitions.getProperties('sp.SkeletonData');
    expect(props).toBeDefined();
    expect(props).toContain('_name');
    expect(props).toContain('_skeletonJson');
    expect(props).toContain('_atlasText');
    expect(props).toContain('textures');
  });

  test('should have property list for dragonBones.DragonBonesAsset', () => {
    const props = typeDefinitions.getProperties('dragonBones.DragonBonesAsset');
    expect(props).toBeDefined();
    expect(props).toContain('_name');
    expect(props).toContain('_dragonBonesJson');
  });

  test('should return null for unknown type', () => {
    const props = typeDefinitions.getProperties('cc.NonExistent');
    expect(props).toBeNull();
  });

  test('registerType should add custom type', () => {
    typeDefinitions.registerType('custom.MyType', ['_name', '_data']);
    const props = typeDefinitions.getProperties('custom.MyType');
    expect(props).toEqual(['_name', '_data']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/typeDefinitions.test.js --verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement typeDefinitions.js**

```js
// src/core/typeDefinitions.js
/*
 * Cocos Creator 内置类型属性名映射表
 * 用于将压缩格式（数组编码）还原为对象格式
 */

const BUILTIN_TYPES = {
  'cc.Node': [
    '_name', '_objFlags', '_parent', '_children', '_active', '_components',
    '_prefab', '_opacity', '_color', '_contentSize', '_anchorPoint',
    '_trs', '_eulerAngles', '_skewX', '_skewY', '_is3DNode',
    '_groupIndex', '_id'
  ],
  'cc.Sprite': [
    '_name', '_objFlags', 'node', '_enabled', '_materials',
    '_srcBlendFactor', '_dstBlendFactor', '_spriteFrame', '_type',
    '_sizeMode', '_fillType', '_fillCenter', '_fillStart', '_fillRange',
    '_isTrimmedMode', '_atlas', '_id'
  ],
  'cc.Label': [
    '_name', '_objFlags', 'node', '_enabled', '_materials',
    '_fontSize', '_lineHeight', '_string', '_N$string',
    '_horizontalAlign', '_verticalAlign', '_actualFontSize',
    '_overflow', '_enableWrapText', '_font', '_isSystemFontUsed',
    '_spacingX', '_batchAsBitmap', '_N$file', '_isItalic',
    '_isBold', '_isUnderline', '_cacheMode', '_id'
  ],
  'cc.Animation': [
    '_name', '_objFlags', 'node', '_enabled',
    '_defaultClip', '_clips', 'playOnLoad', '_id'
  ],
  'cc.Button': [
    '_name', '_objFlags', 'node', '_enabled',
    'clickEvents', '_N$interactable', '_N$enableAutoGrayEffect',
    '_N$transition', 'transition', '_N$normalColor', '_N$pressedColor',
    '_N$hoverColor', '_N$disabledColor', '_N$normalSprite',
    '_N$pressedSprite', '_N$hoverSprite', '_N$disabledSprite',
    '_N$target', '_id'
  ],
  'cc.Widget': [
    '_name', '_objFlags', 'node', '_enabled',
    '_alignFlags', '_target', '_left', '_right', '_top', '_bottom',
    '_horizontalCenter', '_verticalCenter', '_isAbsLeft', '_isAbsRight',
    '_isAbsTop', '_isAbsBottom', '_isAbsHorizontalCenter',
    '_isAbsVerticalCenter', '_originalWidth', '_originalHeight',
    '_alignMode', '_id'
  ],
  'cc.Layout': [
    '_name', '_objFlags', 'node', '_enabled',
    '_layoutSize', '_resize', '_N$layoutType', '_N$padding',
    '_N$cellSize', '_N$startAxis', '_N$paddingLeft', '_N$paddingRight',
    '_N$paddingTop', '_N$paddingBottom', '_N$spacingX', '_N$spacingY',
    '_N$verticalDirection', '_N$horizontalDirection',
    '_N$affectedByScale', '_id'
  ],
  'cc.ScrollView': [
    '_name', '_objFlags', 'node', '_enabled',
    'content', 'horizontal', 'vertical', 'inertia', 'brake',
    'elastic', 'bounceDuration', 'scrollEvents',
    'cancelInnerEvents', '_N$horizontalScrollBar',
    '_N$verticalScrollBar', '_id'
  ],
  'cc.EditBox': [
    '_name', '_objFlags', 'node', '_enabled',
    '_string', '_tabIndex', '_backgroundImage', '_returnType',
    '_inputFlag', '_inputMode', '_fontSize', '_lineHeight',
    '_fontColor', '_placeholder', '_placeholderFontSize',
    '_placeholderFontColor', '_maxLength', '_id'
  ],
  'cc.RichText': [
    '_name', '_objFlags', 'node', '_enabled',
    '_N$string', '_N$horizontalAlign', '_N$fontSize',
    '_N$font', '_N$maxWidth', '_N$lineHeight',
    '_N$imageAtlas', '_N$handleTouchEvent', '_id'
  ],
  'cc.SceneAsset': ['_name', 'scene'],
  'cc.SpriteFrame': [
    '_name', '_objFlags', '_native', '_rect', '_offset',
    '_originalSize', '_rotated', '_capInsets', '_vertices'
  ],
  'cc.SpriteAtlas': ['_name', '_spriteFrames'],
  'cc.AudioClip': [
    '_name', '_objFlags', '_native', '_duration',
    'loadMode'
  ],
  'cc.AnimationClip': [
    '_name', '_objFlags', '_duration', 'sample',
    'speed', 'wrapMode', 'curveData', 'events'
  ],
  'cc.TextAsset': ['_name', '_objFlags', 'text'],
  'cc.Prefab': ['_name', '_objFlags', 'data', 'optimizationPolicy', 'asyncLoadAssets'],
  'sp.Skeleton': [
    '_name', '_objFlags', 'node', '_enabled', '_materials',
    '_skeletonData', 'defaultSkin', 'defaultAnimation',
    '_N$skeletonData', '_N$defaultSkin', '_N$defaultAnimation',
    'loop', 'premultipliedAlpha', 'timeScale', '_N$loop', '_id'
  ],
  'sp.SkeletonData': [
    '_name', '_objFlags', '_native', '_skeletonJson',
    '_atlasText', 'textures', '_nativeAsset'
  ],
  'dragonBones.ArmatureDisplay': [
    '_name', '_objFlags', 'node', '_enabled', '_materials',
    '_N$dragonAsset', '_N$dragonAtlasAsset', '_N$armatureName',
    '_N$animationName', '_N$playTimes', '_N$timeScale', '_id'
  ],
  'dragonBones.DragonBonesAsset': [
    '_name', '_objFlags', '_native', '_dragonBonesJson'
  ],
  'dragonBones.DragonBonesAtlasAsset': [
    '_name', '_objFlags', '_native', '_textureAtlasData', '_texture'
  ]
};

const typeDefinitions = {
  _types: { ...BUILTIN_TYPES },

  getProperties(typeName) {
    return this._types[typeName] || null;
  },

  registerType(typeName, properties) {
    this._types[typeName] = properties;
  },

  hasType(typeName) {
    return typeName in this._types;
  }
};

module.exports = { typeDefinitions };
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/typeDefinitions.test.js --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/typeDefinitions.js __tests__/typeDefinitions.test.js
git commit -m "feat: add built-in Cocos type property definitions table"
```

---

### Task 2: Implement `revealData()` — compressed format detection and restoration

**Files:**
- Modify: `src/core/resourceProcessor.js:222-225`
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write failing tests**

Add to `__tests__/resourceProcessor.test.js`:

```js
describe('revealData', () => {
  test('should pass through plain format data unchanged', async () => {
    resourceProcessor.resetState();
    const plainData = {
      __type__: 'cc.AudioClip',
      _name: 'bgm',
      _native: '.mp3'
    };
    const result = await resourceProcessor.revealData(plainData);
    expect(result).toEqual(plainData);
  });

  test('should restore compressed array format to object format', async () => {
    resourceProcessor.resetState();
    // Compressed format: array of [type_index, ...property_values]
    // With a type list header
    const compressedData = [
      // Element 0: type list (convention: first element is metadata)
      ['cc.AudioClip'],
      // Element 1: actual data as array [typeIndex, prop1, prop2, ...]
      [0, 'bgm', 0, '.mp3']
    ];
    const result = await resourceProcessor.revealData(compressedData);
    // Should restore to object with property names from type table
    expect(result).toBeDefined();
    expect(result[1]).toBeDefined();
    expect(result[1]['__type__']).toBe('cc.AudioClip');
    expect(result[1]['_name']).toBe('bgm');
  });

  test('should resolve __id__ references', async () => {
    resourceProcessor.resetState();
    const dataWithRefs = [
      { __type__: 'cc.Node', _name: 'root', _children: [{ __id__: 1 }] },
      { __type__: 'cc.Node', _name: 'child' }
    ];
    const result = await resourceProcessor.revealData(dataWithRefs);
    expect(result[0]._children[0]).toBe(result[1]);
  });

  test('should decode compressed UUIDs in __uuid__ fields', async () => {
    resourceProcessor.resetState();
    const dataWithUuid = {
      __type__: 'cc.Sprite',
      _spriteFrame: { __uuid__: 'fcmR3XADNLgJ1ByKhqcC5Z' }
    };
    const result = await resourceProcessor.revealData(dataWithUuid);
    // UUID should be decoded to standard format
    expect(result._spriteFrame.__uuid__).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "revealData" --verbose`
Expected: FAIL (some pass since current revealData is passthrough)

- [ ] **Step 3: Implement revealData()**

Replace `revealData` in `src/core/resourceProcessor.js`:

```js
async revealData(jsonObject) {
    if (!jsonObject || typeof jsonObject !== 'object') return jsonObject;

    // If it's an array, check if it's compressed format
    if (Array.isArray(jsonObject)) {
        return this.restoreCompressedData(jsonObject);
    }

    // Plain format: resolve references and decode UUIDs
    if (Array.isArray(jsonObject) === false && typeof jsonObject === 'object') {
        this.resolveReferences(jsonObject);
        this.decodeUuids(jsonObject);
    }

    return jsonObject;
},

/**
 * 检测是否为压缩格式
 * 压缩格式特征：顶层数组，第一个元素是类型列表（字符串数组）
 */
isCompressedFormat(data) {
    if (!Array.isArray(data) || data.length < 2) return false;
    const header = data[0];
    return Array.isArray(header) && header.length > 0 && typeof header[0] === 'string';
},

/**
 * 还原压缩格式数据
 */
restoreCompressedData(data) {
    if (!this.isCompressedFormat(data)) {
        // Not compressed, but still an array — resolve refs
        this.resolveReferences(data);
        this.decodeUuids(data);
        return data;
    }

    const { typeDefinitions } = require('./typeDefinitions');
    const typeList = data[0]; // First element is type name list
    const result = [typeList]; // Keep header for reference

    // Restore each element
    for (let i = 1; i < data.length; i++) {
        const item = data[i];
        if (Array.isArray(item) && item.length > 0 && typeof item[0] === 'number') {
            const typeIndex = item[0];
            const typeName = typeList[typeIndex];
            if (typeName) {
                const obj = this.arrayToObject(typeName, item.slice(1), typeDefinitions);
                result.push(obj);
            } else {
                result.push(item);
            }
        } else if (typeof item === 'object' && item !== null) {
            result.push(item); // Already an object
        } else {
            result.push(item);
        }
    }

    // Resolve __id__ references and decode UUIDs
    this.resolveReferences(result);
    this.decodeUuids(result);

    return result;
},

/**
 * 将数组编码的属性还原为对象
 */
arrayToObject(typeName, values, typeDefinitions) {
    // Try CCSettings first for dynamic type info
    const settings = this.getCCSettings();
    let properties = null;

    if (settings && settings.types && settings.types[typeName]) {
        properties = settings.types[typeName];
    }

    // Fallback to built-in type table
    if (!properties) {
        properties = typeDefinitions.getProperties(typeName);
    }

    if (!properties) {
        // Unknown type, return as-is with __type__ marker
        return { __type__: typeName, _values: values };
    }

    const obj = { __type__: typeName };
    for (let i = 0; i < values.length && i < properties.length; i++) {
        obj[properties[i]] = values[i];
    }
    return obj;
},

/**
 * 解析 __id__ 引用
 */
resolveReferences(data) {
    if (!Array.isArray(data)) return;

    const resolve = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.__id__ !== undefined && data[obj.__id__] !== undefined) {
            return data[obj.__id__];
        }
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                if (obj[key].__id__ !== undefined && data[obj[key].__id__] !== undefined) {
                    obj[key] = data[obj[key].__id__];
                } else if (!Array.isArray(obj[key])) {
                    resolve(obj[key]);
                } else {
                    for (let i = 0; i < obj[key].length; i++) {
                        if (obj[key][i] && obj[key][i].__id__ !== undefined) {
                            obj[key][i] = data[obj[key][i].__id__];
                        }
                    }
                }
            }
        }
        return obj;
    };

    for (let i = 0; i < data.length; i++) {
        if (typeof data[i] === 'object' && data[i] !== null) {
            resolve(data[i]);
        }
    }
},

/**
 * 解码压缩 UUID
 */
decodeUuids(data) {
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.__uuid__ && typeof obj.__uuid__ === 'string' && obj.__uuid__.length === 22) {
            obj.__uuid__ = uuidUtils.decodeUuid(obj.__uuid__);
        }
        for (const key in obj) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                walk(obj[key]);
            }
        }
    };

    if (Array.isArray(data)) {
        data.forEach(item => walk(item));
    } else {
        walk(data);
    }
},
```

Add `require` for `typeDefinitions` at the top of `resourceProcessor.js` (lazy-loaded inside `restoreCompressedData` to avoid circular deps — already in the implementation above).

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "feat: implement revealData with compressed format restoration"
```

---

### Task 3: Add `spriteOutputMode` config option

**Files:**
- Modify: `src/config/configLoader.js:29-34`

- [ ] **Step 1: Add spriteOutputMode to default config**

In `configLoader.js`, modify the `assets` section of `defaultConfig`:

```js
assets: {
    extractTextures: true,
    extractAudio: true,
    extractAnimations: true,
    optimizeSprites: false,
    spriteOutputMode: "single" // "single" or "atlas"
},
```

- [ ] **Step 2: Commit**

```bash
git add src/config/configLoader.js
git commit -m "feat: add spriteOutputMode config option"
```

---

### Task 4: Implement `processSpriteFrame` — single image mode

**Files:**
- Modify: `src/core/resourceProcessor.js` (processSpriteFrame method)
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write failing test**

```js
test('processSpriteFrame should extract texture and write meta in single mode', () => {
  resourceProcessor.resetState();
  global.paths = { res: '/tmp/assets', output: '/tmp/output' };
  global.config = { assets: { spriteOutputMode: 'single' } };

  // Mock a texture file in fileMap
  resourceProcessor.fileMap.set('tex-uuid-001', '/tmp/res/import/tex-uuid-001.png');

  const spriteData = {
    __type__: 'cc.SpriteFrame',
    _name: 'btn_normal',
    _rect: { x: 0, y: 0, width: 100, height: 50 },
    _offset: { x: 0, y: 0 },
    _originalSize: { width: 100, height: 50 },
    _rotated: false,
    content: { atlas: { __uuid__: 'tex-uuid-001' } }
  };

  const parentData = { '0': spriteData };

  const writeFileSpy = jest.spyOn(
    require('../src/utils/fileManager').fileManager, 'writeFile'
  ).mockResolvedValue();

  resourceProcessor.processTypeObject_legacy = null; // ensure registry is used
  resourceProcessor.writeProcessedData(parentData, 'frame-uuid');

  // Should store in spriteFrames
  expect(resourceProcessor.spriteFrames['frame-uuid']).toBeDefined();
});

test('processSpriteFrame should queue texture copy for single mode', () => {
  resourceProcessor.resetState();
  global.paths = { res: '/tmp/assets', output: '/tmp/output' };
  global.config = { assets: { spriteOutputMode: 'single' } };

  resourceProcessor.fileMap.set('tex-001', '/tmp/res/import/tex-001.png');

  const spriteData = {
    __type__: 'cc.SpriteFrame',
    _name: 'icon_star',
    _rect: { x: 10, y: 20, width: 64, height: 64 },
    _offset: { x: 0, y: 0 },
    _originalSize: { width: 64, height: 64 },
    _rotated: false
  };

  const writeFileSpy = jest.spyOn(
    require('../src/utils/fileManager').fileManager, 'writeFile'
  ).mockResolvedValue();

  // Call processSpriteFrame directly
  resourceProcessor.processSpriteFrame({ '0': spriteData }, '0', 'tex-001');

  expect(resourceProcessor.spriteFrames['tex-001']).toBeDefined();

  // Should write meta with sprite frame subMetas
  expect(writeFileSpy).toHaveBeenCalledWith(
    'Texture',
    expect.stringContaining('.meta'),
    expect.objectContaining({ ver: '1.2.7' })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "processSpriteFrame" --verbose`
Expected: FAIL

- [ ] **Step 3: Implement processSpriteFrame**

Replace `processSpriteFrame` in `resourceProcessor.js`:

```js
processSpriteFrame(data, index, key) {
    const spriteData = data[index] || data;
    const name = spriteData['_name'] || key;
    this.spriteFrames[key] = spriteData;

    const outputMode = (global.config && global.config.assets && global.config.assets.spriteOutputMode) || 'single';

    if (outputMode === 'single') {
        this.processSpriteFrameSingle(spriteData, name, key);
    }
    // Atlas mode is handled in convertToOutputFiles via convertSpriteAtlas
},

/**
 * 单图模式处理精灵帧
 */
processSpriteFrameSingle(spriteData, name, key) {
    const _mkdir = 'Texture';

    // Find texture UUID from sprite data
    let texUuid = null;
    if (spriteData.content && spriteData.content.atlas) {
        texUuid = spriteData.content.atlas['__uuid__'] || spriteData.content.atlas;
    } else if (spriteData._texture) {
        texUuid = spriteData._texture['__uuid__'] || spriteData._texture;
    }

    // Queue texture file for copy if found
    if (texUuid && this.fileMap.has(texUuid)) {
        const ext = '.png';
        this.cacheReadList.push(this.fileMap.get(texUuid));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + ext));
        this.fileMap.delete(texUuid);
    } else if (this.fileMap.has(key)) {
        // Try using the sprite frame's own UUID as texture key
        this.cacheReadList.push(this.fileMap.get(key));
        this.cacheWriteList.push(path.join(global.paths.output, 'assets', _mkdir, name + '.png'));
        this.fileMap.delete(key);
    }

    // Build subMetas for the sprite frame
    const subMetas = {};
    subMetas[name] = {
        "ver": "1.0.4",
        "uuid": key,
        "rawTextureUuid": texUuid || key,
        "trimType": "auto",
        "trimThreshold": 1,
        "rotated": spriteData['_rotated'] || false,
        "offsetX": spriteData['_offset'] ? spriteData['_offset'].x || 0 : 0,
        "offsetY": spriteData['_offset'] ? spriteData['_offset'].y || 0 : 0,
        "trimX": spriteData['_rect'] ? spriteData['_rect'].x || 0 : 0,
        "trimY": spriteData['_rect'] ? spriteData['_rect'].y || 0 : 0,
        "width": spriteData['_rect'] ? spriteData['_rect'].width || 0 : 0,
        "height": spriteData['_rect'] ? spriteData['_rect'].height || 0 : 0,
        "rawWidth": spriteData['_originalSize'] ? spriteData['_originalSize'].width || 0 : 0,
        "rawHeight": spriteData['_originalSize'] ? spriteData['_originalSize'].height || 0 : 0,
        "borderTop": 0,
        "borderBottom": 0,
        "borderLeft": 0,
        "borderRight": 0,
        "subMetas": {}
    };

    // Write meta file
    const metaData = {
        "ver": "1.2.7",
        "uuid": texUuid || key,
        "optimizationPolicy": "AUTO",
        "asyncLoadAssets": false,
        "readonly": false,
        "subMetas": subMetas
    };
    fileManager.writeFile(_mkdir, name + '.png.meta', metaData);
},
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/resourceProcessor.js __tests__/resourceProcessor.test.js
git commit -m "feat: implement processSpriteFrame single image mode"
```

---

### Task 5: Implement `convertSpriteAtlas` — atlas mode

**Files:**
- Modify: `src/core/converters.js`
- Modify: `__tests__/resourceProcessor.test.js`

- [ ] **Step 1: Write failing test**

Add to `__tests__/resourceProcessor.test.js`:

```js
test('convertSpriteAtlas should generate PLIST data for atlas mode', async () => {
  const { converters } = require('../src/core/converters');

  const spriteFrames = {
    'frame-1': {
      _name: 'icon_a',
      _rect: { x: 0, y: 0, width: 64, height: 64 },
      _offset: { x: 0, y: 0 },
      _originalSize: { width: 64, height: 64 },
      _rotated: false,
      _texture: { __uuid__: 'atlas-tex-uuid' }
    },
    'frame-2': {
      _name: 'icon_b',
      _rect: { x: 64, y: 0, width: 32, height: 32 },
      _offset: { x: 0, y: 0 },
      _originalSize: { width: 32, height: 32 },
      _rotated: false,
      _texture: { __uuid__: 'atlas-tex-uuid' }
    }
  };

  global.config = { assets: { spriteOutputMode: 'atlas' } };
  global.paths = { output: '/tmp/output' };

  const writeFileSpy = jest.spyOn(
    require('../src/utils/fileManager').fileManager, 'writeFile'
  ).mockResolvedValue();

  await converters.convertSpriteAtlas(spriteFrames);

  // Should group by texture UUID and write atlas data
  expect(writeFileSpy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest __tests__/resourceProcessor.test.js -t "convertSpriteAtlas" --verbose`
Expected: FAIL

- [ ] **Step 3: Implement convertSpriteAtlas**

Replace `convertSpriteAtlas` in `src/core/converters.js`:

```js
async convertSpriteAtlas(spriteFrames) {
    try {
        const outputMode = (global.config && global.config.assets && global.config.assets.spriteOutputMode) || 'single';

        if (outputMode !== 'atlas' || !spriteFrames || Object.keys(spriteFrames).length === 0) {
            logger.info('精灵图集处理完成（单图模式，跳过图集生成）');
            return;
        }

        // Group sprite frames by texture UUID
        const atlasGroups = {};
        for (const key in spriteFrames) {
            const frame = spriteFrames[key];
            let texUuid = 'default';
            if (frame._texture) {
                texUuid = frame._texture['__uuid__'] || frame._texture || 'default';
            } else if (frame.content && frame.content.atlas) {
                texUuid = frame.content.atlas['__uuid__'] || frame.content.atlas || 'default';
            }
            if (!atlasGroups[texUuid]) {
                atlasGroups[texUuid] = {};
            }
            const frameName = frame['_name'] || key;
            atlasGroups[texUuid][frameName] = {
                frame: {
                    x: frame._rect ? frame._rect.x || 0 : 0,
                    y: frame._rect ? frame._rect.y || 0 : 0,
                    w: frame._rect ? frame._rect.width || 0 : 0,
                    h: frame._rect ? frame._rect.height || 0 : 0
                },
                offset: {
                    x: frame._offset ? frame._offset.x || 0 : 0,
                    y: frame._offset ? frame._offset.y || 0 : 0
                },
                rotated: frame._rotated || false,
                sourceColorRect: {
                    x: frame._rect ? frame._rect.x || 0 : 0,
                    y: frame._rect ? frame._rect.y || 0 : 0,
                    w: frame._rect ? frame._rect.width || 0 : 0,
                    h: frame._rect ? frame._rect.height || 0 : 0
                },
                sourceSize: {
                    w: frame._originalSize ? frame._originalSize.width || 0 : 0,
                    h: frame._originalSize ? frame._originalSize.height || 0 : 0
                }
            };
        }

        // Generate PLIST for each atlas group
        for (const texUuid in atlasGroups) {
            const frames = atlasGroups[texUuid];
            const atlasName = Object.values(spriteFrames).find(f => {
                const fTex = f._texture ? (f._texture['__uuid__'] || f._texture) : null;
                return fTex === texUuid;
            })?._name || texUuid;

            const plistData = {
                frames: frames
            };

            const xml = this.createXmlDocument(plistData);
            fileManager.writeFile('Texture', atlasName + '.plist', xml.toString());
        }

        logger.info(`生成了 ${Object.keys(atlasGroups).length} 个精灵图集`);
    } catch (err) {
        logger.error('转换精灵图集时出错:', err);
    }
},
```

Add `fileManager` import at top of `converters.js` if not already imported (it's already there).

- [ ] **Step 4: Run tests**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/converters.js __tests__/resourceProcessor.test.js
git commit -m "feat: implement convertSpriteAtlas for atlas output mode"
```

---

### Task 6: Update README and verify full integration

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Add `spriteOutputMode` to the config example in README:

```js
// 资源处理配置
assets: {
    extractTextures: true,
    extractAudio: true,
    extractAnimations: true,
    optimizeSprites: false,
    spriteOutputMode: "single" // "single"（逐张导出）或 "atlas"（图集模式）
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/crain/Desktop/project/cc-reverse && npx jest --verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add spriteOutputMode config to README"
```
