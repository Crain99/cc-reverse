System.register("chunks:///_virtual/Player.ts", ["cc"], function (_export, _context) {
  "use strict";
  var _decorator, Component, Player;
  return {
    setters: [function (_cc) { _decorator = _cc._decorator; Component = _cc.Component; }],
    execute: function () {
      Player = class Player extends Component { onLoad() { console.log('p'); } };
    }
  };
});
System.register("chunks:///_virtual/Enemy.ts", ["cc", "./Player"], function (_export, _context) {
  "use strict";
  var Component, Player, Enemy;
  return {
    setters: [function (_cc) { Component = _cc.Component; }, function (_p) { Player = _p.default; }],
    execute: function () {
      Enemy = class Enemy extends Component { update() { } };
    }
  };
});
