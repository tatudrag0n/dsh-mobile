/**
 * The host half of the mobile shell.
 *
 * The Harness only serves a client bundle for a package that a profile row
 * loads: `dsh-client-modules` walks the live Loader entries, reads each
 * package's `dsh.client` block, and serves `exports["./client"]` to the
 * browser. A package that is merely present in `node_modules` is never seen.
 *
 * So this half exists only to give that row something to load. It registers
 * nothing, starts nothing and opens no port; the phone layout is a
 * client-only concern and lives in `client.js`, which the Android runtime
 * build copies next to this file (see `scripts/build-runtime.mjs`).
 */

/**
 * Activate the shell.
 *
 * Deliberately empty: all of the work happens in the browser.
 */
export function apply() {}
