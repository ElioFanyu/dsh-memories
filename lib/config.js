/**
 * Configuration schema for the memory hub.
 *
 * The hub's own settings are small on purpose: it is a front end for three
 * other plugins' credentials, so the only thing it stores itself is where those
 * backends live (when the default paths are not the right ones). Setting a path
 * here is how someone with a non-default `HINDSIGHT_CONFIG` or a shared
 * OpenViking install points the page at the real file.
 *
 * Declared with `schemastery` so the built-in plugin row gets a form. It is
 * loaded defensively: under a `link:` install Node resolves from the package's
 * own directory, so a missing vendor package must degrade the row form, not
 * take the whole plugin — and with it the settings page — down.
 *
 * @module @local/dsh-memories/config
 */

import { createRequire } from 'node:module'

/** Resolve `schemastery` from this package, or `undefined` when absent. */
function loadSchemaBuilder() {
  try {
    const require = createRequire(import.meta.url)
    const resolved = require('@deepseek-ai/schemastery')
    const schema = resolved?.default ?? resolved
    return typeof schema === 'function' || typeof schema?.object === 'function' ? schema : undefined
  } catch {
    return undefined
  }
}

const Schema = loadSchemaBuilder()

/** Defaults, independent of whether the schema itself could be built. */
export const DEFAULTS = {
  /** Override for `~/.hindsight/coding-agent.json`; empty means that default. */
  hindsightConfigPath: '',
  /** Override for `~/.openviking/ovcli.conf`; empty means that default. */
  openvikingConfigPath: '',
  /** Default Hindsight API base URL, written when the document has none. */
  hindsightApiUrl: 'https://api.hindsight.vectorize.io',
}

/** Build the schema when a builder is available. */
function buildSchema() {
  if (Schema === undefined) return undefined
  try {
    return Schema.object({
      hindsightConfigPath: Schema.string().default(DEFAULTS.hindsightConfigPath),
      openvikingConfigPath: Schema.string().default(DEFAULTS.openvikingConfigPath),
      hindsightApiUrl: Schema.string().default(DEFAULTS.hindsightApiUrl),
    })
  } catch {
    return undefined
  }
}

export let Config = buildSchema()

/**
 * Rebuild the schema if the first attempt failed.
 *
 * Node caches this module by URL, so a Host that first imported it while
 * `schemastery` was unresolvable keeps the `undefined` it bound then; a
 * disable/re-enable cycle re-applies the fiber without re-evaluating the
 * module. `export let` makes a later assignment visible to every importer.
 *
 * @returns the schema, or `undefined` when no builder is resolvable.
 */
export function ensureConfig() {
  if (Config === undefined) {
    try {
      Config = buildSchema()
    } catch {
      Config = undefined
    }
  }
  return Config
}
