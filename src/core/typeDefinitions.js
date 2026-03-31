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
    '_name', '_objFlags', '_native', '_duration', 'loadMode'
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
