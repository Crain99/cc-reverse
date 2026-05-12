const path = require('path');
const home = require('os').homedir();
module.exports = {
  zqndtz:      { engine: '3.x',   path: path.join(home, 'mini/zqndtz'),               role: 'gold' },
  dabaoyiqie:  { engine: '2.4.x', path: path.join(home, 'mini/dabaoyiqie-reverse'), role: 'regression-only' },
  cgxfd:       { engine: '2.4.x', path: path.join(home, 'mini/cgxfd-reverse'),      role: 'regression-only' },
};
