'use strict';

const { splitChunks: defaultSplit } = require('./chunkSplitter');
const { rebuildEsm: defaultRebuild } = require('./esmRebuilder');
const { restoreClasses: defaultRestore } = require('./classRestorer');

/**
 * Drive the 3-layer script recovery pipeline.
 *
 * @param {object} input
 * @param {Array<{name:string, source:string}>} input.chunks
 * @param {object} [input.layers] — overrides per layer for testing
 * @returns {Promise<{modules: Array, errors: Array}>}
 */
async function runScriptRecoveryPipeline(input) {
  const { chunks = [], layers = {} } = input;
  const split = layers.chunkSplitter || defaultSplit;
  const rebuild = layers.esmRebuilder || defaultRebuild;
  const restore = layers.classRestorer || defaultRestore;
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

  return { modules, errors };
}

module.exports = { runScriptRecoveryPipeline };
