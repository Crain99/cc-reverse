'use strict';

const { splitChunks: defaultSplit } = require('./chunkSplitter');
const { rebuildEsm: defaultRebuild } = require('./esmRebuilder');
const { restoreClasses: defaultRestore } = require('./classRestorer');
const { applyCcclassNames: defaultNamer } = require('./ccclassNamer');
const { inferFieldTypes: defaultInferer } = require('./typeInferer');
const { emitTsProject: defaultEmitter } = require('./tsProjectEmitter');

/**
 * Drive the 6-layer script recovery pipeline.
 *
 * @param {object} input
 * @param {Array<{name:string, source:string}>} input.chunks
 * @param {object} [input.layers] — overrides per layer for testing
 * @param {object} [input.context] — shared context passed to layers 4-6
 * @returns {Promise<{modules: Array, errors: Array, emit: object|null}>}
 */
async function runScriptRecoveryPipeline(input) {
  const { chunks = [], layers = {}, context = {} } = input;
  const split = layers.chunkSplitter || defaultSplit;
  const rebuild = layers.esmRebuilder || defaultRebuild;
  const restore = layers.classRestorer || defaultRestore;
  const namer = layers.ccclassNamer || defaultNamer;
  const inferer = layers.typeInferer || defaultInferer;
  const emitter = layers.tsProjectEmitter; // emitter is opt-in (engine wires it)
  const errors = [];

  let modules = [];
  for (const chunk of chunks) {
    try {
      const split1 = await split(chunk);
      modules = modules.concat(split1);
    } catch (err) {
      errors.push({ layer: 'chunkSplitter', chunk: chunk.name, message: err.message });
    }
  }

  for (const m of modules) {
    try { m.ast = await rebuild(m.ast, m); }
    catch (err) { errors.push({ layer: 'esmRebuilder', module: m.name, message: err.message }); }
  }

  for (const m of modules) {
    try { m.ast = await restore(m.ast, m); }
    catch (err) { errors.push({ layer: 'classRestorer', module: m.name, message: err.message }); }
  }

  // Layer 4 sees the whole module set so UUID maps can dedupe across files.
  try {
    modules = (await namer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'ccclassNamer', message: err.message });
  }

  try {
    modules = (await inferer(modules, context)) || modules;
  } catch (err) {
    errors.push({ layer: 'typeInferer', message: err.message });
  }

  let emit = null;
  if (emitter) {
    try {
      emit = await emitter(modules, context);
    } catch (err) {
      errors.push({ layer: 'tsProjectEmitter', message: err.message });
    }
  }

  return { modules, errors, emit };
}

module.exports = { runScriptRecoveryPipeline };
