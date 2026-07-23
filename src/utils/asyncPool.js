/*
 * @Description: Bounded-concurrency async helpers
 */

/**
 * Run an async worker over items with a fixed concurrency limit.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, worker) {
  if (!items || items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency || 1, items.length));
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

/**
 * Like mapPool but discards results (for side-effect workers).
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function forEachPool(items, concurrency, worker) {
  await mapPool(items, concurrency, worker);
}

/**
 * Resolve the configured max parallel workers (default 8).
 * @param {object} [config]
 * @returns {number}
 */
function getMaxParallel(config) {
  const fromConfig = config?.advanced?.maxParallel
    ?? global.config?.advanced?.maxParallel;
  const n = Number(fromConfig);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

module.exports = { mapPool, forEachPool, getMaxParallel };
