/**
 * The operator test-audio contract shared by the Session Manager (which seeds
 * the rooms, devices and sessions) and the test-audio generator (which derives
 * its own credentials for them).
 *
 * A **separate entry point** from the package index, exposed as
 * `@scribear/session-manager-schema/test-audio`: the derivation needs
 * `node:crypto`, and the index is in the browser bundles' import graph. Keeping
 * the two apart is what lets the contract be shared without dragging a node
 * builtin into a Vite build.
 */
export * from './test-audio.constants.js';
export * from './derive-device-token.js';
