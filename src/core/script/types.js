/*
 * Shared typedefs for the 2.x script recovery pipeline.
 */

/**
 * @typedef {'browserify' | 'webpack' | 'cocos-rf' | 'unknown'} ScriptBundleFormat
 */

/**
 * @typedef {Object} ModuleRecord
 * @property {string} id                 Bundle key or logical module id
 * @property {string} source             Module body source (no factory wrapper)
 * @property {Object<string, string>} [deps]  require-specifier → bundle id
 * @property {string|null} [uuid]        Cocos asset uuid if known
 * @property {ScriptBundleFormat} [format]
 * @property {string|null} [outPath]     Relative path under assets/Scripts
 * @property {string} [rawKey]
 * @property {number} [offset]
 */

/**
 * @typedef {Object} TransformResult
 * @property {string} code
 * @property {string|null} uuid
 * @property {string} outPath
 * @property {string} className
 */

module.exports = {};
