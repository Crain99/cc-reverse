#!/usr/bin/env node
const { runGates } = require('../src/validate');
const dir = process.argv[2];
if (!dir) { console.error('usage: validate <output-dir>'); process.exit(2); }
const r = runGates(dir);
console.log(JSON.stringify(r, null, 2));
process.exit(r.failed.length ? 1 : 0);
