'use strict';

// Cocos Creator 3.x EffectAsset reconstruction.
//
// At runtime an EffectAsset is a JSON document with compiled GLSL strings.
// Cocos Editor's `.effect` importer however expects the *source* form:
//
//   CCEffect %{ <yaml: techniques/passes/properties> }%
//   CCProgram <name> %{ <glsl> }%
//   ...
//
// This module rebuilds the source form from the runtime JSON. It is
// best-effort — the JSON contains everything the engine needs, but a few
// editor-only niceties (anchors, comments, original property ordering,
// linear/srgb hints) are lost. The result is good enough for the editor to
// re-import the effect and for materials to bind to it.

const KNOWN_BUILTINS = new Set([
  'builtin-unlit',
  'builtin-standard',
  'builtin-pbr',
  'builtin-toon',
  'builtin-particle',
  'builtin-particle-trail',
  'builtin-particle-gpu',
  'builtin-billboard',
  'builtin-skybox',
  'builtin-terrain',
  'builtin-spine',
  'builtin-sprite',
  'builtin-graphics',
  'builtin-clear-stencil',
  'builtin-occlusion-query',
  'builtin-debug-renderer',
  'copy-pass',
  'profiler',
  'splash-screen',
  'tone-mapping',
  'post-process',
  'bloom',
  'fxaa',
]);

// gfx enum decoders — values come from `cc.gfx.BlendFactor` / `Cull` etc.
const BLEND_FACTOR = ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate', 'constant_color', 'one_minus_constant_color', 'constant_alpha', 'one_minus_constant_alpha'];
const BLEND_OP = ['add', 'sub', 'rev_sub', 'min', 'max'];
const CULL_MODE = ['none', 'front', 'back'];
const COMPARE_FUNC = ['never', 'less', 'equal', 'less_equal', 'greater', 'not_equal', 'greater_equal', 'always'];
const STENCIL_OP = ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'];
const POLYGON_MODE = ['fill', 'point', 'line'];
const SHADE_MODEL = ['gouraud', 'flat'];

// gfx Type enum (subset). Maps to GLSL types for property declarations.
const GFX_TYPE = {
  13: 'vec4',     // FLOAT4
  12: 'vec3',     // FLOAT3
  11: 'vec2',     // FLOAT2
  10: 'float',    // FLOAT
  16: 'mat4',
  15: 'mat3',
  14: 'mat2',
  20: 'int',
  21: 'ivec2',
  22: 'ivec3',
  23: 'ivec4',
  28: 'sampler2D',
  29: 'samplerCube',
};

function isBuiltinEffect(asset) {
  if (!asset) return false;
  const name = asset._name || '';
  // Strip any directory prefix — Cocos engine ships builtins under
  // editor/assets/effects/{internal,for2d,pipeline,util,...}/ and the JSON's
  // _name field carries the full sub-path (e.g. "for2d/builtin-sprite",
  // "pipeline/post-process/tone-mapping"). Only the basename matters for
  // builtin recognition.
  const base = name.split('/').pop();
  if (KNOWN_BUILTINS.has(base)) return true;
  if (base.startsWith('builtin-')) return true;
  return false;
}

function transformEffectAsset(jsonText) {
  let asset;
  try {
    const parsed = JSON.parse(jsonText);
    asset = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
  if (!asset || asset.__type__ !== 'cc.EffectAsset') return null;
  // Builtin effects are owned by the engine — once references are decoded to
  // their real long uuids (see rehydrate decodeUuid), materials resolve
  // straight to the engine's copy. Emitting our own .effect/.meta would just
  // collide with the engine asset on the same uuid.
  if (isBuiltinEffect(asset)) return { skip: true, name: asset._name };

  const yaml = buildYaml(asset);
  const programs = buildPrograms(asset);

  let out = '';
  if (asset._name) out += `// ${asset._name}\n`;
  out += 'CCEffect %{\n' + indent(yaml, 2) + '\n}%\n';
  for (const p of programs) {
    out += `\nCCProgram ${p.name} %{\n${indent(p.body.trim(), 2)}\n}%\n`;
  }
  return { skip: false, source: out, name: asset._name || '' };
}

function buildYaml(asset) {
  const techniques = asset.techniques || [];
  const lines = [];
  lines.push('techniques:');
  for (const tech of techniques) {
    const head = tech.name ? `- name: ${quoteIfNeeded(tech.name)}` : '-';
    lines.push(head);
    if (Array.isArray(tech.passes)) {
      lines.push('  passes:');
      for (const pass of tech.passes) emitPass(lines, pass, asset);
    }
  }
  return lines.join('\n');
}

function emitPass(lines, pass, asset) {
  // Resolve "vert"/"frag" entry names from the program string. Programs in
  // the JSON look like "<basename>|<vsName>:vert|<fsName>:frag". We expose
  // both halves separately for the YAML.
  const stages = splitProgramName(pass.program);
  const head = '    -';
  let first = true;
  function add(line) {
    if (first) { lines.push(`${head} ${line}`); first = false; }
    else lines.push(`      ${line}`);
  }
  if (stages.vert) add(`vert: ${stages.vert}`);
  if (stages.frag) add(`frag: ${stages.frag}`);
  if (pass.phase) add(`phase: ${quoteIfNeeded(pass.phase)}`);
  if (typeof pass.priority === 'number') add(`priority: ${pass.priority}`);
  if (typeof pass.propertyIndex === 'number') add(`propertyIndex: ${pass.propertyIndex}`);
  if (pass.primitive) add(`primitive: ${pass.primitive}`);

  if (pass.rasterizerState) {
    add('rasterizerState:');
    pushKv(lines, pass.rasterizerState, '        ', { cullMode: CULL_MODE, polygonMode: POLYGON_MODE, shadeModel: SHADE_MODEL });
  }
  if (pass.depthStencilState) {
    add('depthStencilState:');
    pushKv(lines, pass.depthStencilState, '        ', {
      depthFunc: COMPARE_FUNC,
      stencilFuncFront: COMPARE_FUNC, stencilFuncBack: COMPARE_FUNC,
      stencilFailOpFront: STENCIL_OP, stencilFailOpBack: STENCIL_OP,
      stencilZFailOpFront: STENCIL_OP, stencilZFailOpBack: STENCIL_OP,
      stencilPassOpFront: STENCIL_OP, stencilPassOpBack: STENCIL_OP,
    });
  }
  if (pass.blendState) {
    add('blendState:');
    if (Array.isArray(pass.blendState.targets)) {
      lines.push('        targets:');
      for (const t of pass.blendState.targets) {
        lines.push('        -');
        pushKv(lines, t, '          ', {
          blend: null,
          blendSrc: BLEND_FACTOR, blendDst: BLEND_FACTOR,
          blendSrcAlpha: BLEND_FACTOR, blendDstAlpha: BLEND_FACTOR,
          blendEq: BLEND_OP, blendAlphaEq: BLEND_OP,
        });
      }
    }
    if (typeof pass.blendState.isA2C === 'boolean') lines.push(`        isA2C: ${pass.blendState.isA2C}`);
    if (Array.isArray(pass.blendState.blendColor)) lines.push(`        blendColor: ${JSON.stringify(pass.blendState.blendColor)}`);
  }
  if (pass.properties) {
    add('properties:');
    emitProperties(lines, pass.properties, '        ');
  }
  if (pass.migrations) {
    add('migrations:');
    emitYamlObject(lines, pass.migrations, '        ');
  }
}

function pushKv(lines, obj, indentStr, enums) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    let val = v;
    const en = enums && Object.prototype.hasOwnProperty.call(enums, k) ? enums[k] : null;
    if (en && typeof v === 'number' && en[v]) val = en[v];
    if (typeof val === 'object') {
      lines.push(`${indentStr}${k}:`);
      emitYamlObject(lines, val, indentStr + '  ');
    } else if (typeof val === 'string') {
      lines.push(`${indentStr}${k}: ${quoteIfNeeded(val)}`);
    } else {
      lines.push(`${indentStr}${k}: ${val}`);
    }
  }
}

function emitProperties(lines, props, indentStr) {
  for (const [name, def] of Object.entries(props)) {
    const parts = [];
    if (def.value !== undefined) {
      const v = Array.isArray(def.value) ? `[${def.value.join(', ')}]` : JSON.stringify(def.value);
      parts.push(`value: ${v}`);
    }
    if (typeof def.type === 'number' && GFX_TYPE[def.type] && def.value === undefined) {
      // No default value, just declare a sampler/uniform — keep type hint.
      parts.push(`type: ${GFX_TYPE[def.type]}`);
    }
    if (def.target) parts.push(`target: ${quoteIfNeeded(def.target)}`);
    if (def.linear !== undefined) parts.push(`linear: ${def.linear}`);
    if (def.editor) parts.push(`editor: ${inlineFlow(def.editor)}`);
    lines.push(`${indentStr}${name}: { ${parts.join(', ')} }`);
  }
}

function emitYamlObject(lines, obj, indentStr) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') {
        lines.push(`${indentStr}-`);
        emitYamlObject(lines, item, indentStr + '  ');
      } else {
        lines.push(`${indentStr}- ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') {
        lines.push(`${indentStr}${k}:`);
        emitYamlObject(lines, v, indentStr + '  ');
      } else {
        lines.push(`${indentStr}${k}: ${formatScalar(v)}`);
      }
    }
    return;
  }
  lines.push(`${indentStr}${formatScalar(obj)}`);
}

function inlineFlow(o) {
  if (Array.isArray(o)) return `[${o.map(inlineFlow).join(', ')}]`;
  if (o && typeof o === 'object') {
    const parts = Object.entries(o).map(([k, v]) => `${k}: ${inlineFlow(v)}`);
    return `{ ${parts.join(', ')} }`;
  }
  return formatScalar(o);
}

function formatScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return quoteIfNeeded(v);
  return JSON.stringify(v);
}

function quoteIfNeeded(s) {
  if (typeof s !== 'string') return JSON.stringify(s);
  if (s === '' || /[:#&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^-?\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// "<basename>|<vsName>:vert|<fsName>:frag" → { vert, frag }
function splitProgramName(program) {
  if (!program || typeof program !== 'string') return {};
  const parts = program.split('|');
  const out = {};
  for (const p of parts) {
    if (p.endsWith(':vert')) out.vert = p;
    else if (p.endsWith(':frag')) out.frag = p;
  }
  return out;
}

function buildPrograms(asset) {
  const programs = [];
  for (const sh of asset.shaders || []) {
    const stages = splitProgramName(sh.name);
    const glsl = sh.glsl1 || sh.glsl3 || sh.glsl4 || {};
    if (stages.vert && glsl.vert) {
      programs.push({ name: stages.vert.split(':')[0], body: postProcessGlsl(glsl.vert, sh) });
    }
    if (stages.frag && glsl.frag) {
      programs.push({ name: stages.frag.split(':')[0], body: postProcessGlsl(glsl.frag, sh) });
    }
  }
  // Dedup by name (vert/frag from multiple shaders of the same effect repeat).
  const seen = new Set();
  return programs.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

// Engine-provided builtin uniforms (cc-global, cc-local, cc-shadow includes).
// The compiled glsl1 has these expanded as bare uniforms — Cocos's source
// effect compiler rejects bare vector/matrix uniforms (EFX2201). We strip
// them here and emit a `#include <legacy/cc-global>` so the editor's
// preprocessor re-supplies the declarations from the engine's chunk library.
const BUILTIN_UNIFORMS = new Set([
  'cc_matView', 'cc_matProj', 'cc_matViewProj', 'cc_matViewInv', 'cc_matProjInv', 'cc_matViewProjInv',
  'cc_matWorld', 'cc_matWorldIT', 'cc_matWorldView', 'cc_matWorldViewProj',
  'cc_cameraPos', 'cc_screenSize', 'cc_nativeSize', 'cc_screenScale', 'cc_exposure',
  'cc_time', 'cc_mainLitDir', 'cc_mainLitColor', 'cc_ambientSky', 'cc_ambientGround',
  'cc_fogColor', 'cc_fogBase', 'cc_fogAdd', 'cc_nearFar', 'cc_viewPort',
  'cc_matLightView', 'cc_matLightViewProj', 'cc_shadowInvProjDepthInfo',
  'cc_shadowProjDepthInfo', 'cc_shadowProjInfo', 'cc_shadowNFLSInfo',
  'cc_shadowWHPBInfo', 'cc_shadowLPNNInfo', 'cc_shadowColor', 'cc_planarNDInfo',
  'cc_localShadowBias',
]);

// Match `[layout(...)] uniform [highp|mediump|lowp] <type> <name>;` (single-line).
// Only applies to non-sampler, non-block uniforms. Captures name in group 4.
const BARE_UNIFORM_RE = /^([\t ]*)(?:layout\s*\([^)]*\)\s*)?uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;[\t ]*$/;

function postProcessGlsl(src, shader) {
  if (typeof src !== 'string' || !src) return src;
  const blocks = Array.isArray(shader && shader.blocks) ? shader.blocks : [];
  // Map each user-block-member name → owning block index, so we can drop
  // bare uniforms that the JSON says belong inside a block.
  const memberToBlock = new Map(); // name → blockIndex
  for (let i = 0; i < blocks.length; i++) {
    for (const m of (blocks[i].members || [])) memberToBlock.set(m.name, i);
  }

  const lines = src.split('\n');
  const out = [];
  let usesBuiltin = false;
  for (const line of lines) {
    const m = line.match(BARE_UNIFORM_RE);
    if (m) {
      const type = m[2];
      const name = m[3];
      // Keep sampler*/image* declarations (samplers may stand alone in GLSL).
      if (/^sampler/.test(type) || /^image/.test(type)) { out.push(line); continue; }
      // Drop builtin cc_* uniforms — the include will re-supply them.
      if (BUILTIN_UNIFORMS.has(name) || name.startsWith('cc_')) { usesBuiltin = true; continue; }
      // Drop user uniforms that the JSON declares inside a block — a
      // synthesized `uniform <Block> { ... };` will replace them.
      if (memberToBlock.has(name)) continue;
    }
    out.push(line);
  }

  // Synthesize block declarations from JSON metadata. Insert them after the
  // first `precision …;` line so they appear at top-level uniform scope.
  const blockDecls = blocks.map((b) => {
    const members = (b.members || [])
      .map((mm) => `  ${gfxTypeToGlsl(mm.type)} ${mm.name}${typeof mm.count === 'number' && mm.count > 1 ? `[${mm.count}]` : ''};`)
      .join('\n');
    return `uniform ${b.name} {\n${members}\n};`;
  });
  const header = [];
  if (usesBuiltin) header.push('#include <builtin/uniforms/cc-global>');
  if (blockDecls.length) header.push(...blockDecls);
  if (!header.length) return out.join('\n');

  // Find precision line; otherwise prepend at top.
  let insertAt = 0;
  for (let i = 0; i < out.length; i++) {
    if (/^\s*precision\s+/.test(out[i])) { insertAt = i + 1; break; }
  }
  out.splice(insertAt, 0, ...header);
  return out.join('\n');
}

function gfxTypeToGlsl(type) {
  return GFX_TYPE[type] || 'float';
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return text.split('\n').map((l) => l ? pad + l : l).join('\n');
}

module.exports = { transformEffectAsset, isBuiltinEffect };
