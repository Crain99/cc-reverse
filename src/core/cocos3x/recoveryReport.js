/*
 * RecoveryReport — collects per-asset success/failure counts during 3.x
 * project recovery, and emits a markdown summary.
 */
class RecoveryReport {
  constructor() {
    this.bundles = {};
    this.failures = [];
  }
  _ensure(b) {
    if (!this.bundles[b]) this.bundles[b] = { ok: 0, failed: 0, missed: 0, byClass: {} };
    return this.bundles[b];
  }
  ok(bundle, uuid, klass) {
    const b = this._ensure(bundle);
    b.ok++;
    b.byClass[klass] = (b.byClass[klass] ?? 0) + 1;
  }
  fail(bundle, uuid, klass, error) {
    const b = this._ensure(bundle);
    b.failed++;
    if (!(klass in b.byClass)) b.byClass[klass] = 0;
    this.failures.push({ bundle, uuid, klass, reason: error?.message ?? String(error) });
  }
  miss(bundle, uuid, klass) {
    const b = this._ensure(bundle);
    b.missed = (b.missed ?? 0) + 1;
    if (!(klass in b.byClass)) b.byClass[klass] = 0;
  }
  summary() { return { bundles: this.bundles, failures: this.failures }; }
  toMarkdown() {
    const lines = ['# Recovery Report', ''];
    lines.push('## Per-bundle counts');
    for (const [name, b] of Object.entries(this.bundles)) {
      lines.push(`- **${name}**: ok=${b.ok}, failed=${b.failed}, missed=${b.missed ?? 0}`);
      for (const [k, v] of Object.entries(b.byClass).sort()) lines.push(`  - ${k}: ${v}`);
    }
    if (this.failures.length) {
      lines.push('', '## Failures');
      for (const f of this.failures) lines.push(`- [${f.bundle}] ${f.klass} ${f.uuid}: ${f.reason}`);
    }
    return lines.join('\n');
  }
}
module.exports = { RecoveryReport };
