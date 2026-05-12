'use strict';

const { runScriptRecoveryPipeline } = require('./pipeline');
const { splitChunks } = require('./chunkSplitter');
const { rebuildEsm } = require('./esmRebuilder');
const { restoreClasses } = require('./classRestorer');

module.exports = {
  runScriptRecoveryPipeline,
  splitChunks,
  rebuildEsm,
  restoreClasses,
};
