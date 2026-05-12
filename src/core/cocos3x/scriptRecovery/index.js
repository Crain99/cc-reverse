'use strict';

const { runScriptRecoveryPipeline } = require('./pipeline');
const { splitChunks } = require('./chunkSplitter');
const { rebuildEsm } = require('./esmRebuilder');
const { restoreClasses } = require('./classRestorer');
const { applyCcclassNames } = require('./ccclassNamer');
const { inferFieldTypes } = require('./typeInferer');
const { emitTsProject } = require('./tsProjectEmitter');

module.exports = {
  runScriptRecoveryPipeline,
  splitChunks,
  rebuildEsm,
  restoreClasses,
  applyCcclassNames,
  inferFieldTypes,
  emitTsProject,
};
