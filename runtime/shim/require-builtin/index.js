'use strict';

/**
 * Pure-JS replacement for the native `require_builtin.node` binding.
 *
 * DSH boots by reaching into Node's own internals (`internal/modules/esm/...`)
 * to patch the module loader. Upstream does that through a native addon, and
 * no addon is published for Android: the platforms it ships are the desktop
 * ones. This module does the same job with `require()`, which reaches internal
 * ids once the Host is started with `--expose-internals`; the app's launcher
 * always passes that flag.
 *
 * The binding info describes this as an N-API binding because that is the tag
 * `node-addon-native-custom-loader` validates a loaded binding against
 * (product `require-builtin`, ABI `napi-v9`). Claiming the tag is what lets the
 * unmodified loader accept an implementation that is not native.
 */

/**
 * Load a builtin or internal module by id.
 *
 * @param {string} moduleId - A `node:` id or a Node internal id.
 * @returns {unknown} The module namespace.
 */
function requireBuiltin(moduleId) {
  return require(moduleId);
}

/**
 * Whether the id may be loaded through {@link requireBuiltin}.
 *
 * @param {string} moduleId - The candidate id.
 * @returns {boolean} Whether it is a usable id.
 */
function isAllowedInternalId(moduleId) {
  return typeof moduleId === 'string' && moduleId.length > 0;
}

/**
 * Describe this binding to the loader.
 *
 * @returns {{ mode: string, product: string, backend: string, abi: string }} The binding info.
 */
function getNativeBindingInfo() {
  return {
    mode: 'js-shim',
    product: 'require-builtin',
    backend: 'napi',
    abi: 'napi-v9',
  };
}

module.exports = { requireBuiltin, isAllowedInternalId, getNativeBindingInfo };
