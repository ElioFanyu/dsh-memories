/**
 * Memory hub — the barrel the plugin entry and its tests share.
 *
 * Kept separate from `index.js` so the route handler can be exercised without
 * mounting a Cordis fiber, and so the backend table has exactly one source.
 *
 * @module @local/dsh-memories/backends-entry
 */

export { BACKENDS, PACKAGES, agentarts, detectInstalled, readEntries, hindsight, openviking, AGENTARTS_KEY_REF, dshHome, hindsightPath, keySummary, maskSecret, secretShape, openvikingPath } from './backends.js'
export { Config, DEFAULTS, ensureConfig } from './config.js'
export { ROUTE_PREFIX, errorText, isLoopback, readJsonBody, sendJson } from './routes.js'
