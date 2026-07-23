const fs = require('fs');
const path = require('path');
const { detectScriptBundleFormat } = require('../../src/core/script/detectFormat');

const fixture = fs.readFileSync(
  path.join(__dirname, '../../__fixtures__/project-browserify.js'),
  'utf-8',
);

describe('detectScriptBundleFormat', () => {
  test('detects browserify/__require fixture', () => {
    expect(detectScriptBundleFormat(fixture)).toBe('browserify');
  });

  test('detects webpack markers', () => {
    const code = `
      var installedModules = {};
      function __webpack_require__(moduleId) {
        var module = { exports: {} };
        modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
        return module.exports;
      }
      function(module, exports, __webpack_require__) {
        __webpack_require__(1);
      }
    `;
    expect(detectScriptBundleFormat(code)).toBe('webpack');
  });

  test('detects cocos-rf soup without bundle wrapper', () => {
    const code = `
      cc._RF.push(module, "abc", "Foo");
      var x = 1;
      cc._RF.pop();
    `;
    expect(detectScriptBundleFormat(code)).toBe('cocos-rf');
  });

  test('returns unknown for plain unrelated js', () => {
    expect(detectScriptBundleFormat('console.log(1);')).toBe('unknown');
  });

  test('handles empty input', () => {
    expect(detectScriptBundleFormat('')).toBe('unknown');
    expect(detectScriptBundleFormat(null)).toBe('unknown');
  });
});
