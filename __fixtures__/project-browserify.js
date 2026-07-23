// Minimal Cocos-like browserify / __require bundle for unit tests.
// Shape mirrors Creator 2.x project.js (simplified).

window.__require = function e(t, n, r) {
  function s(o, u) {
    if (!n[o]) {
      if (!t[o]) {
        var a = typeof require == "function" && require;
        if (!u && a) return a(o, !0);
        if (i) return i(o, !0);
        throw new Error("Cannot find module '" + o + "'");
      }
      var f = n[o] = { exports: {} };
      t[o][0].call(f.exports, function (e) {
        var n = t[o][1][e];
        return s(n ? n : e);
      }, f, f.exports, e, t, n, r);
    }
    return n[o].exports;
  }
  var i = typeof require == "function" && require;
  for (var o = 0; o < r.length; o++) s(r[o]);
  return s;
}({
  "assets/scripts/util/MathUtil.js": [function (require, module, exports) {
    "use strict";

    cc._RF.push(module, "a1b2c3d4e5f6g7h8i9j0k1", "MathUtil");
    // util module
    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }
    module.exports = { clamp: clamp };
    cc._RF.pop();
  }, {}],
  "assets/scripts/Player.js": [function (require, module, exports) {
    "use strict";

    cc._RF.push(module, "fcmR3XADNLgJ1ByKhqcC5Z", "Player");
    var MathUtil = require("./util/MathUtil");

    function Player() {
      this.hp = MathUtil.clamp(100, 0, 100);
    }

    Player.prototype.hurt = function (n) {
      this.hp = MathUtil.clamp(this.hp - n, 0, 100);
    };

    module.exports = Player;
    cc._RF.pop();
  }, {
    "./util/MathUtil": "assets/scripts/util/MathUtil.js"
  }],
  "assets/scripts/Game.js": [function (require, module, exports) {
    "use strict";

    cc._RF.push(module, "zzzzzzzzzzzzzzzzzzzzzz", "Game");
    var Player = require("./Player");

    function Game() {
      this.player = new Player();
    }

    module.exports = Game;
    cc._RF.pop();
  }, {
    "./Player": "assets/scripts/Player.js"
  }]
}, {}, ["assets/scripts/Game.js"]);
