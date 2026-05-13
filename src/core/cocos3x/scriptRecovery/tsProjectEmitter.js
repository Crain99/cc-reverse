'use strict';

const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');

const babelGenerator = require('@babel/generator');
const generate = babelGenerator.default || babelGenerator;

let tsMorph; // lazy
let prettier; // lazy

/**
 * Layer 6: emit a TypeScript project from post-Layer-5 modules.
 *
 * Pipeline per module:
 *   babel-generator(mod.ast) → JS source
 *   ts-morph in-memory project parses the JS as TS
 *   walk class properties; for any name in mod.fieldTypes, prop.setType(typeStr)
 *   prettier.format(text, { parser: 'typescript' })
 *   write <outRoot>/<bundle>/<className>.ts
 *
 * Also writes <outRoot>/tsconfig.json and <outRoot>/RECOVERY_INDEX.json.
 *
 * @param {Array} modules
 * @param {object} context
 * @param {string} context.outRoot — directory to write into (typically <out>/assets/scripts)
 * @returns {Promise<{filesEmitted:number, errors:Array<string>}>}
 */
async function emitTsProject(modules, context = {}) {
  const outRoot = context.outRoot;
  if (!outRoot) throw new Error('emitTsProject: context.outRoot is required');
  const errors = [];

  await mkdir(outRoot, { recursive: true });

  if (!modules || modules.length === 0) {
    await writeTsconfig(outRoot);
    await writeFile(path.join(outRoot, 'RECOVERY_INDEX.json'), '{}\n');
    return { filesEmitted: 0, errors };
  }

  if (!tsMorph) tsMorph = require('ts-morph');
  if (!prettier) prettier = require('prettier');

  // Instantiate ts-morph Project ONCE per emit call (it's heavy).
  const project = new tsMorph.Project({ useInMemoryFileSystem: true });
  const recoveryIndex = {};
  let count = 0;

  for (const mod of modules) {
    if (!mod || !mod.ast || !mod.ccclassName) continue;
    const bundle = mod.bundle || 'unbundled';
    const relPath = `${bundle}/${mod.ccclassName}.ts`;
    const fsPath = path.join(outRoot, relPath);

    let jsCode;
    try {
      jsCode = generate(mod.ast, { compact: false }).code;
    } catch (err) {
      errors.push(`${mod.name}: generate failed — ${err.message}`);
      continue;
    }

    let sourceFile;
    try {
      sourceFile = project.createSourceFile(relPath, jsCode, { overwrite: true });
    } catch (err) {
      errors.push(`${mod.name}: ts-morph createSourceFile failed — ${err.message}`);
      continue;
    }

    try {
      annotateFields(sourceFile, mod);
    } catch (err) {
      errors.push(`${mod.name}: annotate failed — ${err.message}`);
      // continue — annotations are best-effort
    }

    let text = sourceFile.getFullText();
    try {
      text = await prettier.format(text, { parser: 'typescript', singleQuote: true });
    } catch (err) {
      errors.push(`${mod.name}: prettier format failed — ${err.message}`);
      // keep unformatted text
    }

    try {
      await mkdir(path.dirname(fsPath), { recursive: true });
      await writeFile(fsPath, text);
    } catch (err) {
      errors.push(`${mod.name}: write failed — ${err.message}`);
      continue;
    }

    // Emit <ClassName>.ts.meta — uuid MUST match the chunk's _RF.push uuid so
    // scene `__type__` references resolve when the editor scans assets/.
    // Without this, components in game.scene fall back to UnknownNode and the
    // canvas renders as the brown clear-color (the slgq-out symptom).
    if (mod.uuid) {
      const meta = buildTsMeta(mod.uuid, mod.ccclassName);
      try {
        await writeFile(`${fsPath}.meta`, JSON.stringify(meta, null, 2) + '\n');
      } catch (err) {
        errors.push(`${mod.name}: meta write failed — ${err.message}`);
      }
      recoveryIndex[mod.uuid] = { path: relPath, className: mod.ccclassName };
    }
    count += 1;
  }

  await writeTsconfig(outRoot);
  await writeFile(
    path.join(outRoot, 'RECOVERY_INDEX.json'),
    JSON.stringify(recoveryIndex, null, 2) + '\n'
  );
  return { filesEmitted: count, errors };
}

/**
 * For each class property whose name appears in mod.fieldTypes, apply the
 * inferred type via prop.setType(). Properties not in fieldTypes are left
 * alone (no annotation added) — fieldTypes only contains fields actually
 * observed in scenes, not the full class field set.
 */
function annotateFields(sourceFile, mod) {
  const types = mod.fieldTypes || {};
  if (!types || Object.keys(types).length === 0) return;
  for (const cls of sourceFile.getClasses()) {
    for (const prop of cls.getInstanceProperties()) {
      if (typeof prop.getName !== 'function') continue;
      if (typeof prop.setType !== 'function') continue; // skip getters/setters/methods
      const name = prop.getName();
      const inferred = types[name];
      if (!inferred) continue;
      try {
        prop.setType(inferred);
      } catch {
        // skip on any ts-morph hiccup; one bad prop should not abort the module
      }
    }
  }
}

async function writeTsconfig(root) {
  const cfg = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Node',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
      allowJs: false,
      esModuleInterop: true,
    },
    include: ['**/*.ts'],
  };
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Build the .ts.meta JSON the Cocos 3.8 editor expects for a TS script asset.
 * Shape verified against cocos-test-projects v3.8.7 (typescript importer
 * ver 4.0.21). The `uuid` field is the load-bearing one — scenes reference
 * components via `__type__: "<uuid>"`, so this MUST be the uuid captured from
 * `_RF.push(module, uuid, name)` in the original SystemJS bundle, not random.
 *
 * @param {string} uuid stable uuid from _RF.push
 * @param {string} className recovered ccclass name (used for displayName)
 */
function buildTsMeta(uuid, className) {
  return {
    ver: '4.0.21',
    importer: 'typescript',
    imported: true,
    uuid,
    files: [],
    subMetas: {},
    userData: {
      moduleId: `project:///assets/scripts/${className}.ts`,
      recoveredBy: 'cc-reverse',
    },
  };
}

module.exports = { emitTsProject, buildTsMeta };
