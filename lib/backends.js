/**
 * The three memory backends, as this page sees them.
 *
 * Each entry answers the same two questions the same way — "is a key
 * configured" and "store this key" — while reading and writing whatever the
 * backend itself actually uses. Keeping that asymmetry HERE (instead of
 * forcing one shape) is the whole point: a key written anywhere else than its
 * owner's own location is saved and silently ignored.
 *
 * Nothing here echoes a secret. `describe` reports presence, never the value.
 *
 * @module @local/dsh-memories/backends
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/* ---------------------------------------------------------------------- *
 * Small filesystem helpers
 * ---------------------------------------------------------------------- */

/** Resolve the DSH home directory the way the runtime does. */
export function dshHome(env = process.env) {
  const declared = env.DSH_HOME
  if (typeof declared === 'string' && declared.trim() !== '') return resolve(declared)
  const profileDir = env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim() !== '') return resolve(profileDir, '..', '..')
  return join(homedir(), '.dsh')
}

/** Read and parse a JSON file, returning `undefined` when it is absent or broken. */
async function readJsonFile(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { existed: false, value: undefined, raw: undefined }
  }
  try {
    const value = JSON.parse(raw)
    const object = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return { existed: true, value: object, raw }
  } catch {
    // A broken file is reported, not replaced: overwriting it would destroy
    // settings the user can still repair by hand.
    return { existed: true, value: undefined, raw }
  }
}

/**
 * Write one JSON file atomically.
 *
 * A memory plugin that corrupts `ovcli.conf` or `coding-agent.json` on a crash
 * mid-write takes every key with it, so the temp-then-rename step is not
 * ceremony: it is the difference between "the write did not happen" and "the
 * file is now half a JSON document".
 */
async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/* ---------------------------------------------------------------------- *
 * Backend locations
 * ---------------------------------------------------------------------- */

/** Absolute path of Hindsight's configuration document. */
export function hindsightPath(env = process.env) {
  const declared = env.HINDSIGHT_CONFIG
  if (typeof declared === 'string' && declared.trim() !== '') return resolve(declared)
  return join(homedir(), '.hindsight', 'coding-agent.json')
}

/** Absolute path of OpenViking's CLI/host configuration document. */
export function openvikingPath(env = process.env) {
  const declared = env.OPENVIKING_CLI_CONF || env.OPENVIKING_CONFIG
  if (typeof declared === 'string' && declared.trim() !== '') return resolve(declared)
  return join(homedir(), '.openviking', 'ovcli.conf')
}

/** The credential reference AgentArts keys are stored under. */
export const AGENTARTS_KEY_REF = 'AGENTARTS_MEMORY_API_KEY'

/* ---------------------------------------------------------------------- *
 * AgentArts — lives in the DSH credential store
 * ---------------------------------------------------------------------- */

/**
 * AgentArts, backed by `ctx.credentials`.
 *
 * The store is DSH's own, so this backend needs a live context rather than a
 * file path; `read`/`write` therefore take one. Resolution is per call — the
 * shipped service contract — so a rotated key reaches the next request.
 */
export const agentarts = {
  id: 'agentarts',
  title: '华为云 AgentArts 记忆库',
  hint: '在华为云控制台的记忆库详情页「API Key」处生成并复制。Key 保存在 DSH 凭据库，不写入配置文件。',
  /**
   * The data-plane endpoint, for a space that is not on the public region host.
   *
   * `where: 'row'` — this address is not in a config document but in the
   * AgentArts plugin's own Loader row (`baseUrl`), so it is written through
   * `configEditor.edit` together with the space id. A private-network
   * deployment publishes no public hostname, so leaving it blank only works for
   * the public regions.
   */
  urlField: {
    where: 'row',
    label: '服务地址（可选）',
    placeholder: '选填。留空则按区域使用华为云默认地址；私有网络部署请填写数据面地址',
  },
  async describe(ctx) {
    const credentials = ctx?.get?.('credentials')
    if (credentials === undefined || typeof credentials.describe !== 'function') {
      return { configured: false, writable: false, detail: '当前部署没有凭据服务' }
    }
    try {
      const info = await credentials.describe(AGENTARTS_KEY_REF)
      const configured = info?.configured === true
      // The store reports presence only, so the masked form is read once here
      // and reduced immediately — the full value never leaves this function.
      let shape
      if (configured && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(AGENTARTS_KEY_REF)
          const value = typeof resolved === 'string' ? resolved : resolved?.value
          shape = secretShape(value)
        } catch {
          shape = undefined
        }
      }
      return {
        configured,
        writable: info?.writable !== false,
        source: typeof info?.source === 'string' ? info.source : undefined,
        ...(shape === undefined ? {} : shape),
      }
    } catch (error) {
      return { configured: false, writable: false, detail: errorText(error) }
    }
  },
  async write(ctx, value) {
    const credentials = ctx?.get?.('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') {
      throw new Error('当前部署没有凭据服务，无法保存 AgentArts Key')
    }
    await credentials.set(AGENTARTS_KEY_REF, value)
  },
  /**
   * Read the connection fields the AgentArts plugin row itself owns.
   *
   * The key lives in the credential store, but `spaceId`, `actorId` and the
   * endpoint are ordinary row config. Reading them here is what lets one page
   * own the whole connection instead of half of it.
   */
  async describeRows(ctx) {
    const row = findAgentartsRow(ctx)
    if (row === undefined) return { configurable: false }
    const config = row.entry?.options?.config
    const source = config !== null && typeof config === 'object' ? config : {}
    return {
      configurable: true,
      spaceId: typeof source.spaceId === 'string' ? source.spaceId : '',
      actorId: typeof source.actorId === 'string' ? source.actorId : '',
      baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
      region: typeof source.region === 'string' ? source.region : '',
    }
  },
  /**
   * Persist the connection fields through the normal Loader path.
   *
   * `configEditor.edit` validates the change against the AgentArts plugin's own
   * `Config` and re-applies its row, so the tool picks up a new space id without
   * a restart — the same guarantee the plugin's own page had.
   */
  async writeRows(ctx, fields) {
    const row = findAgentartsRow(ctx)
    if (row === undefined) throw new Error('找不到华为 AgentArts 插件的配置行')
    const editor = ctx?.get?.('configEditor')
    if (editor === undefined || typeof editor.edit !== 'function') {
      throw new Error('当前部署没有 configEditor，无法保存 Space ID / Actor ID')
    }
    await editor.edit(row.entry, (current) => {
      const next = { ...current }
      if (fields.spaceId !== undefined) next.spaceId = fields.spaceId
      if (fields.actorId !== undefined) next.actorId = fields.actorId
      if (fields.baseUrl !== undefined) next.baseUrl = fields.baseUrl
      if (fields.region !== undefined) next.region = fields.region
      // The key belongs to the credential store, never to this patch.
      next.apiKey = ''
      return next
    })
  },
}

/** The AgentArts plugin's own Loader row, if that plugin is installed. */
function findAgentartsRow(ctx) {
  try {
    let fallback
    for (const entry of ctx.loader.entries()) {
      if (entry?.options?.name !== 'dsh-agentarts-memory' && entry?.options?.name !== '@local/dsh-agentarts-memory') continue
      if (entry.fiber === ctx.fiber) return { entry }
      if (entry.disabled !== true && fallback === undefined) fallback = { entry }
    }
    return fallback
  } catch {
    return undefined
  }
}

/* ---------------------------------------------------------------------- *
 * Hindsight — `coding-agent.json`
 * ---------------------------------------------------------------------- */

/**
 * Hindsight, backed by `~/.hindsight/coding-agent.json`.
 *
 * Only `apiToken` and `apiUrl` are this page's business; every other key in
 * that document belongs to Hindsight and is copied back untouched.
 */
export const hindsight = {
  id: 'hindsight',
  title: 'Hindsight 记忆',
  hint: 'Hindsight 的 API Token（hsk_…）。写入 ~/.hindsight/coding-agent.json 的 apiToken，改完即生效，不用重启。',
  urlField: {
    where: 'document',
    label: '服务地址（可选）',
    placeholder: '选填。自建服务请填写完整地址，留空则沿用当前配置',
  },
  async describe() {
    const path = hindsightPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      return { configured: false, writable: false, path, detail: '文件存在但不是合法 JSON，未改动它' }
    }
    const token = file.value?.apiToken
    const configured = typeof token === 'string' && token.trim() !== ''
    const shape = configured ? secretShape(token) : undefined
    return {
      configured,
      writable: true,
      path,
      // Enough to tell WHICH key is configured, never enough to use it: the
      // first characters plus the length. A bare "已配置" cannot answer
      // "is this the key I rotated last week?", which is the question a person
      // actually has when they open this page.
      ...(shape === undefined ? {} : shape),
      url: typeof file.value?.apiUrl === 'string' ? file.value.apiUrl : undefined,
    }
  },
  async write(_ctx, value) {
    const path = hindsightPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    next.apiToken = value
    if (typeof next.apiUrl !== 'string' || next.apiUrl.trim() === '') {
      next.apiUrl = DEFAULTS.hindsightApiUrl
    }
    await writeJsonFile(path, next)
  },
  /** Set the API base URL alongside the token. */
  async writeUrl(_ctx, value) {
    const path = hindsightPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    next.apiUrl = value
    await writeJsonFile(path, next)
  },
  /**
   * Apply a key and a URL in ONE read-modify-write.
   *
   * Two separate writes would each re-read the document, so the second would
   * start from a snapshot taken before the first landed and silently drop it.
   * One pass keeps both changes and halves the window for a concurrent writer.
   */
  async writeBoth(_ctx, { apiKey, url }) {
    const path = hindsightPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    if (url !== undefined) next.apiUrl = url
    if (apiKey !== undefined) next.apiToken = apiKey
    if (typeof next.apiUrl !== 'string' || next.apiUrl.trim() === '') next.apiUrl = 'https://api.hindsight.vectorize.io'
    await writeJsonFile(path, next)
  },
}

/* ---------------------------------------------------------------------- *
 * OpenViking — `ovcli.conf`
 * ---------------------------------------------------------------------- */

/**
 * OpenViking, backed by `~/.openviking/ovcli.conf`.
 *
 * The plugin resolves its connection from a chain that ends in this document:
 * top-level `url`, then `plugin.apiKey` / `plugin.accountId` / `plugin.userId`
 * (and the harness-scoped `plugin.dsh` spelling). `authMode` is not stored —
 * it is derived from whether an identity is present, so writing it would
 * contradict the reader. Other harnesses' sections and any unrelated keys are
 * preserved verbatim.
 */
export const openviking = {
  id: 'openviking',
  title: 'OpenViking 记忆',
  hint: 'OpenViking 的 API Key 与服务地址。写入 ~/.openviking/ovcli.conf 的 plugin 段，其它 harness 的配置保持原样。',
  urlField: {
    where: 'document',
    label: '服务地址（可选）',
    placeholder: '选填。自建服务请填写完整地址，留空则沿用当前配置',
  },
  async describe() {
    const path = openvikingPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      return { configured: false, writable: false, path, detail: '文件存在但不是合法 JSON，未改动它' }
    }
    const plugin = isSection(file.value?.plugin) ? file.value.plugin : {}
    const scoped = isSection(plugin.dsh) ? plugin.dsh : {}
    const key = firstString(scoped.apiKey, plugin.apiKey)
    const url = firstString(file.value?.url)
    const shape = key === undefined ? undefined : secretShape(key)
    return {
      configured: key !== undefined,
      writable: true,
      path,
      ...(shape === undefined ? {} : shape),
      url,
      account: firstString(scoped.accountId, plugin.accountId),
      user: firstString(scoped.userId, plugin.userId),
    }
  },
  async write(_ctx, value) {
    const path = openvikingPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    const plugin = isSection(next.plugin) ? { ...next.plugin } : {}
    // Write the shared `plugin.apiKey`; the harness-scoped spelling is left as
    // the user wrote it, because it may deliberately differ.
    plugin.apiKey = value
    next.plugin = plugin
    await writeJsonFile(path, next)
  },
  /** Set the service URL (top-level `url` in the same document). */
  async writeUrl(_ctx, value) {
    const path = openvikingPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    next.url = value
    await writeJsonFile(path, next)
  },
  /** Apply a key and a URL in ONE read-modify-write; see `hindsight.writeBoth`. */
  async writeBoth(_ctx, { apiKey, url }) {
    const path = openvikingPath()
    const file = await readJsonFile(path)
    if (file.existed && file.value === undefined) {
      throw new Error(`${path} 不是合法 JSON，为安全起见没有覆盖它`)
    }
    const next = { ...(file.value ?? {}) }
    if (url !== undefined) next.url = url
    if (apiKey !== undefined) {
      const plugin = isSection(next.plugin) ? { ...next.plugin } : {}
      plugin.apiKey = apiKey
      next.plugin = plugin
    }
    await writeJsonFile(path, next)
  },
}

/** The package each backend belongs to; used to tell whether it is installed. */
export const PACKAGES = {
  agentarts: '@local/dsh-agentarts-memory',
  hindsight: '@vectorize-io/hindsight-coding-agents',
  openviking: '@openviking/dsh-memory-plugin',
}

/**
 * Is the plugin that owns this backend present and active in this profile?
 *
 * A package sitting in `dependencies` is NOT installed in the sense that
 * matters: it is on disk and inert. What decides whether configuring it is
 * useful is whether the Loader has a live, enabled row for it — so that is
 * exactly what is checked. Without this, the page invites you to save a key for
 * a plugin that will never read it.
 *
 * The check fails OPEN, deliberately. If the Loader is unreachable, `entries()`
 * throws, or no entry at all mentions this package, the answer is "assume
 * installed": a wrong "not installed" blocks a working configuration and is
 * the more damaging mistake. A wrong "installed" only means a saved key goes
 * unread, which the user discovers immediately when nothing happens.
 *
 * @returns `{ installed: boolean, reason?: string }`
 */
export function detectInstalled(ctx, backendId) {
  const pkg = PACKAGES[backendId]
  if (pkg === undefined) return { installed: true, reason: 'unknown-backend' }
  const entries = readEntries(ctx)
  if (entries === undefined) return { installed: true, reason: 'loader-unavailable' }
  let found = false
  for (const entry of entries) {
    const options = entry?.options ?? entry
    if (options?.name !== pkg) continue
    found = true
    if (entry?.disabled !== true) return { installed: true }
  }
  // Only report missing when the Loader gave us a populated list that simply
  // has no row for this package.
  return found ? { installed: false, reason: 'disabled' } : { installed: false, reason: 'missing' }
}

/**
 * Read the Loader's entry list, or `undefined` when it cannot be read.
 *
 * `ctx.loader` is not always a plain property in a Cordis context — reading an
 * uninjected service throws rather than returning undefined — so this tries the
 * documented accessors in turn and reports failure instead of treating it as an
 * empty list.
 */
export function readEntries(ctx) {
  const candidates = []
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get('loader'))
  } catch {
    /* accessor refused; try the next one */
  }
  try {
    if (ctx?.loader !== undefined) candidates.push(ctx.loader)
  } catch {
    /* property read threw; try the next one */
  }
  for (const loader of candidates) {
    try {
      const value = loader?.entries?.()
      if (value === undefined || value === null) continue
      // `entries()` returns an iterable (a Map of id → entry on this build),
      // NOT a plain array. Testing `Array.isArray` here reported every package
      // as installed, so the detect must materialize the iterable.
      if (Array.isArray(value)) return value
      if (typeof value[Symbol.iterator] === 'function') {
        const list = [...value]
        // A Map yields [key, entry] pairs; unwrap so callers see entries.
        return list.map((item) =>
          Array.isArray(item) && item.length === 2 && item[1] !== null && typeof item[1] === 'object'
            ? item[1]
            : item,
        )
      }
    } catch {
      /* this accessor does not work in this context */
    }
  }
  return undefined
}

/** Every backend, keyed by id. */
export const BACKENDS = { agentarts, hindsight, openviking }

/** A JSON object that is a section, not an array or null. */
function isSection(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A secret reduced to something a person can recognise but cannot use.
 *
 * The page renders this as a sentence ("已保存 Key，hsk_f 开头，共 53 位")
 * rather than as a fake value: `hsk_f…（53 位）` inside an input looked like a
 * half-typed key. The two facts are the useful ones — the prefix identifies the
 * issuer, the length tells a rotated key from the previous one — and neither is
 * enough to authenticate. Deliberately NOT a reversible transformation.
 *
 * @returns `{ prefix, length }`, or `undefined` when there is no value.
 */
export function keySummary(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  // Keep a stable prefix so the key stays identifiable (`hsk_`, `sk-`), but
  // never so much that the visible part plus the length narrows the secret
  // meaningfully. 5 characters is the issuer prefix for every key this page
  // handles; short keys degrade to proportionally less.
  const prefix = text.length >= 10 ? text.slice(0, 5) : text.slice(0, Math.max(2, Math.floor(text.length / 3)))
  return { prefix, length: text.length }
}

/**
 * The same reduction as one line of text, for callers that want a string.
 *
 * Kept because it is the shortest useful statement of "which key is this" in a
 * log or a test; the page itself uses `keySummary` and writes prose around it.
 */
export function maskSecret(value) {
  const summary = keySummary(value)
  if (summary === undefined) return undefined
  return `${summary.prefix}…（${summary.length} 位）`
}

/**
 * Both forms of the same reduction, ready to spread into a `describe` result.
 *
 * `masked` is the one-line string (`hsk_f…（53 位）`); `mask` is the structured
 * pair the page writes prose around. Returning both from one function keeps a
 * backend from reporting a shape that disagrees with its own string.
 *
 * @returns `{ masked, mask }`, or `undefined` when there is no value.
 */
export function secretShape(value) {
  const summary = keySummary(value)
  if (summary === undefined) return undefined
  return { masked: `${summary.prefix}…（${summary.length} 位）`, mask: summary }
}

/** The first non-empty trimmed string among the candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** A never-empty description of a thrown value. */
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? '未知错误' : message
}

export { errorText, readJsonFile, writeJsonFile, firstString, isSection }

