const { defineConfig } = require('vitest/config');
module.exports = defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 60_000,
    pool: 'forks',
  },
});
