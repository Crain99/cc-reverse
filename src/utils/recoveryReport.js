/*
 * Unified recovery report writer for 2.x and 3.x pipelines.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * @param {string} outputPath
 * @param {object} summary
 * @param {string} sourcePath
 * @returns {Promise<string>} report file path
 */
async function writeRecoveryReport(outputPath, summary, sourcePath) {
  const lines = [];
  lines.push('# Recovery Report');
  lines.push('');
  lines.push(`- Input: \`${sourcePath}\``);
  lines.push(`- Output: \`${outputPath}\``);
  lines.push(`- Engine: ${summary.engine || summary.version || 'unknown'}`);
  if (summary.flavor) lines.push(`- Flavor: ${summary.flavor}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Scripts
  lines.push('## Scripts');
  lines.push('');
  if (summary.scripts) {
    if (typeof summary.scripts.total === 'number') {
      lines.push(`- Files recovered: ${summary.scripts.total}`);
    }
    if (summary.scripts.format) lines.push(`- Format: \`${summary.scripts.format}\``);
    if (summary.scripts.extractor) lines.push(`- Extractor: \`${summary.scripts.extractor}\``);
    if (typeof summary.scripts.modules === 'number') {
      lines.push(`- Modules extracted: ${summary.scripts.modules}`);
    }
    if (typeof summary.scripts.written === 'number') {
      lines.push(`- Modules written: ${summary.scripts.written}`);
    }
    if (typeof summary.scripts.failed === 'number' && summary.scripts.failed > 0) {
      lines.push(`- Modules failed: ${summary.scripts.failed}`);
    }
  } else {
    lines.push('_No script stage._');
  }
  lines.push('');

  // Assets (2.x)
  if (summary.assets) {
    lines.push('## Assets');
    lines.push('');
    const a = summary.assets;
    lines.push(`- Scenes: ${a.scenes ?? 0}`);
    lines.push(`- Prefabs: ${a.prefabs ?? 0}`);
    lines.push(`- SpriteFrames: ${a.sprites ?? 0}`);
    lines.push(`- Audio: ${a.audio ?? 0}`);
    lines.push(`- Animations: ${a.animations ?? 0}`);
    lines.push(`- Native copies: ${a.copies ?? 0}`);
    if (a.labelAtlas != null) lines.push(`- LabelAtlas: ${a.labelAtlas}`);
    lines.push('');
  }

  // Bundles (3.x)
  if (Array.isArray(summary.bundles)) {
    lines.push('## Bundles');
    lines.push('');
    if (summary.bundles.length === 0) {
      lines.push('_No bundles recovered._');
    } else {
      lines.push('| Name | Encrypted | UUIDs | Paths | Recovered | Missing |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const b of summary.bundles) {
        lines.push(
          `| ${b.name} | ${b.encrypted ? 'yes' : 'no'} | ${b.uuidCount} | ${b.pathCount} | ${b.recovered} | ${b.missing} |`,
        );
      }
    }
    lines.push('');
  }

  // Options
  if (summary.options) {
    lines.push('## Options');
    lines.push('');
    for (const [k, v] of Object.entries(summary.options)) {
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      lines.push(`- ${k}: \`${Array.isArray(v) ? v.join(', ') : v}\``);
    }
    lines.push('');
  }

  if (Array.isArray(summary.warnings) && summary.warnings.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of summary.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  await fsp.mkdir(outputPath, { recursive: true });
  const reportPath = path.join(outputPath, 'RECOVERY_REPORT.md');
  await fsp.writeFile(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

module.exports = { writeRecoveryReport };
