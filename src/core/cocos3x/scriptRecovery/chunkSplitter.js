'use strict';

/**
 * Layer 1 stub. Real implementation in Task 1.
 * Returns one passthrough module per chunk so pipeline tests pass.
 */
async function splitChunks(chunk) {
  return [{ name: chunk.name, source: chunk.source, ast: null }];
}

module.exports = { splitChunks };
