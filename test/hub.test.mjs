/**
 * Tests for the memory hub.
 *
 * The whole value of this plugin is that each key lands in the ONE place its
 * backend actually reads. So these tests point the backends at temp files,
 * write through the route handler, and then check the file — including that
 * unrelated settings and other harnesses' sections survive untouched.
 *
 * Run: node test/hub.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------- isolate the backends from the real home ---------------- */

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-memories-'))
const hindsightFile = join(sandbox, '.hindsight', 'coding-agent.json')
const openvikingFile = join(sandbox, '.openviking', 'ovcli.conf')

// The backends read these env vars, which is also the documented override.
process.env.HINDSIGHT_CONFIG = hindsightFile
process.env.OPENVIKING_CLI_CONF = openvikingFile
process.env.DSH_HOME = join(sandbox, '.dsh')

const { apply } = await import('../lib/index.js')
const { hindsightPath, openvikingPath, dshHome } = await import('../lib/backends.js')

let failures = 0
const check = async (name, run) => {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ---------------- a fake Cordis context ---------------- */

/** In-memory stand-in for DSH's credential store. */
function makeCredentialStore(initial = {}) {
  const records = new Map(Object.entries(initial))
  return {
    records,
    async describe(ref) {
      return { configured: records.has(ref), writable: true, source: 'stored' }
    },
    async resolve(ref) {
      const value = records.get(ref)
      return value === undefined ? undefined : { value, source: 'stored' }
    },
    async set(ref, value) {
      records.set(ref, value)
    },
  }
}

/**
 * Mount the plugin and capture its route handler.
 *
 * `deferWebServer` reproduces the timing that once broke this: the row
 * activates before the web carrier, so the route can only be mounted through
 * `ctx.inject`.
 */
function mount({ deferWebServer = false, credentials = makeCredentialStore() } = {}) {
  const captured = { handler: undefined }
  const waiters = []
  let ready = !deferWebServer

  const webServer = {
    register(route) {
      captured.handler = route.handler
      return () => {}
    },
  }

  const ctx = {
    captured,
    credentials,
    get(name) {
      if (name === 'webServer') return ready ? webServer : undefined
      if (name === 'credentials') return credentials
      return undefined
    },
    inject(services, run) {
      if (services.includes('webServer') && !ready) {
        waiters.push(run)
        return
      }
      run()
    },
    logger: { info() {}, warn() {}, error() {} },
    effect() {},
    fiber: {},
  }

  apply(ctx, {})

  return {
    ctx,
    readyWebServer() {
      ready = true
      for (const run of waiters.splice(0)) run()
    },
  }
}

/** Drive the captured handler with one fake request. */
async function call(ctx, { method, path, body, remoteAddress = '127.0.0.1' }) {
  assert.ok(ctx.captured.handler, 'the plugin registered no route')
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  const chunks = []
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
    },
  }
  await ctx.captured.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, json: text === '' ? undefined : JSON.parse(text) }
}

/** Read a JSON file as text and parse it, failing loudly when absent. */
async function readBack(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/* ---------------- locations ---------------- */

await check('each backend resolves its documented location', async () => {
  assert.equal(hindsightPath(), hindsightFile)
  assert.equal(openvikingPath(), openvikingFile)
  assert.ok(dshHome().startsWith(sandbox))
})

/* ---------------- status ---------------- */

await check('status reports all three backends with a path and no secret', async () => {
  const { ctx } = mount({ credentials: makeCredentialStore({ AGENTARTS_MEMORY_API_KEY: 'aa-secret' }) })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  assert.equal(result.status, 200)
  const { agentarts, hindsight, openviking } = result.json.backends
  assert.equal(agentarts.configured, true)
  assert.equal(hindsight.configured, false)
  assert.equal(openviking.configured, false)
  assert.ok(agentarts.path.endsWith('.credentials.yaml'))
  assert.equal(hindsight.path, hindsightFile)
  assert.equal(openviking.path, openvikingFile)
  // The full secret must never appear in the payload.
  assert.equal(JSON.stringify(result.json).includes('aa-secret'), false)
})

await check('a configured key is reported in recognisable masked form', async () => {
  await mkdir(join(sandbox, '.hindsight'), { recursive: true })
  // An obviously synthetic key: the alphabet sequence makes it unmistakable to
  // any reader (and to a secret scanner) that this is a fixture, not a leak.
  const full = 'hsk_TESTFIXTUREabcdefghijklmnopqrstuvwxyz0123456789ABCDE'
  await writeFile(hindsightFile, JSON.stringify({ apiToken: full }), 'utf8')
  const { ctx } = mount({ credentials: makeCredentialStore({ AGENTARTS_MEMORY_API_KEY: 'sk-agentarts-0123456789' }) })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  const { hindsight, agentarts } = result.json.backends

  // Recognisable: the prefix and length identify WHICH key is configured.
  assert.match(hindsight.masked, /^hsk_\w…（\d+ 位）$/)
  assert.equal(hindsight.masked.includes(String(full.length)), true)
  // Not usable: the body of the key is absent from the whole payload.
  const payload = JSON.stringify(result.json)
  assert.equal(payload.includes(full), false)
  assert.equal(payload.includes(full.slice(5, 20)), false, 'no long interior run of the key may leak')
  assert.equal(payload.includes('sk-agentarts-0123456789'), false)

  // Every backend masks the same way.
  assert.match(agentarts.masked, /^sk-ag…（\d+ 位）$/)
})

await check('an unconfigured backend reports no masked value at all', async () => {
  await writeFile(hindsightFile, JSON.stringify({}), 'utf8')
  const { ctx } = mount({ credentials: makeCredentialStore() })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  assert.equal(result.json.backends.hindsight.configured, false)
  assert.equal('masked' in result.json.backends.hindsight, false)
})

/* ---------------- AgentArts ---------------- */

await check('agentarts saves into the DSH credential store', async () => {
  const credentials = makeCredentialStore()
  const { ctx } = mount({ credentials })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'agentarts', apiKey: 'sk-agentarts' },
  })
  assert.equal(result.json.ok, true)
  assert.equal(credentials.records.get('AGENTARTS_MEMORY_API_KEY'), 'sk-agentarts')
  assert.equal(result.json.backend.configured, true)
})

/* ---------------- Hindsight ---------------- */

await check('hindsight writes apiToken and preserves every other setting', async () => {
  await mkdir(join(sandbox, '.hindsight'), { recursive: true })
  // A realistic document: settings this plugin must not touch.
  await writeFile(
    hindsightFile,
    JSON.stringify({ apiUrl: 'https://api.hindsight.vectorize.io', logLevel: 'debug', bankId: 'my-bank', retainSessions: false }),
    'utf8',
  )
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', apiKey: 'hsk_test' },
  })
  assert.equal(result.json.ok, true)
  const saved = await readBack(hindsightFile)
  assert.equal(saved.apiToken, 'hsk_test')
  // Everything else survives — a rewrite that dropped these would silently
  // reconfigure the user's Hindsight.
  assert.equal(saved.apiUrl, 'https://api.hindsight.vectorize.io')
  assert.equal(saved.logLevel, 'debug')
  assert.equal(saved.bankId, 'my-bank')
  assert.equal(saved.retainSessions, false)
})

await check('hindsight creates the document with a default url when absent', async () => {
  await writeFile(hindsightFile, JSON.stringify({}), 'utf8')
  const { ctx } = mount()
  await call(ctx, { method: 'POST', path: '/dsh-memories/save', body: { target: 'hindsight', apiKey: 'hsk_new' } })
  const saved = await readBack(hindsightFile)
  assert.equal(saved.apiToken, 'hsk_new')
  assert.equal(saved.apiUrl, 'https://api.hindsight.vectorize.io')
})

await check('hindsight can set the api url on its own', async () => {
  const { ctx } = mount()
  await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', url: 'https://custom.example/api' },
  })
  const saved = await readBack(hindsightFile)
  assert.equal(saved.apiUrl, 'https://custom.example/api')
  assert.equal(saved.apiToken, 'hsk_new', 'the existing token is kept')
})

await check('a broken hindsight document is refused, not overwritten', async () => {
  await writeFile(hindsightFile, '{ this is not json', 'utf8')
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', apiKey: 'hsk_x' },
  })
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /不是合法 JSON/)
  // The user's (broken) file is still exactly as they left it.
  assert.equal(await readFile(hindsightFile, 'utf8'), '{ this is not json')
})

/* ---------------- OpenViking ---------------- */

await check('openviking writes plugin.apiKey and keeps other harnesses intact', async () => {
  await mkdir(join(sandbox, '.openviking'), { recursive: true })
  await writeFile(
    openvikingFile,
    JSON.stringify({
      url: 'https://ov.example',
      plugin: { apiKey: '', claude: { apiKey: 'claude-key' }, dsh: { accountId: 'acc-1' } },
      unrelated: { keep: true },
    }),
    'utf8',
  )
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'openviking', apiKey: 'ov-key' },
  })
  assert.equal(result.json.ok, true)
  const saved = await readBack(openvikingFile)
  assert.equal(saved.plugin.apiKey, 'ov-key')
  // Another harness's key must survive: sharing one file is the whole design.
  assert.equal(saved.plugin.claude.apiKey, 'claude-key')
  assert.equal(saved.plugin.dsh.accountId, 'acc-1')
  assert.equal(saved.url, 'https://ov.example')
  assert.deepEqual(saved.unrelated, { keep: true })
})

await check('openviking picks up a key written in the harness-scoped spelling', async () => {
  await writeFile(
    openvikingFile,
    JSON.stringify({ plugin: { dsh: { apiKey: 'scoped-key' } } }),
    'utf8',
  )
  const { ctx } = mount()
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  assert.equal(result.json.backends.openviking.configured, true)
})

await check('openviking can set the service url on its own', async () => {
  // Start from a known document: "keeps the existing key" is only meaningful
  // when the key is actually there, and an earlier case rewrote this file.
  await writeFile(openvikingFile, JSON.stringify({ url: 'https://ov.example', plugin: { apiKey: 'ov-key' } }), 'utf8')
  const { ctx } = mount()
  await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'openviking', url: 'https://ov2.example' },
  })
  const saved = await readBack(openvikingFile)
  assert.equal(saved.url, 'https://ov2.example')
  assert.equal(saved.plugin.apiKey, 'ov-key', 'the existing key is kept')
})

/* ---------------- safety and plumbing ---------------- */

await check('an unknown backend is rejected', async () => {
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'nonsense', apiKey: 'x' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
})

await check('an empty save is rejected instead of reporting success', async () => {
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', apiKey: '   ' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
})

await check('every write route refuses a non-loopback caller', async () => {
  const credentials = makeCredentialStore()
  const { ctx } = mount({ credentials })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'agentarts', apiKey: 'stolen' },
    remoteAddress: '192.168.1.20',
  })
  assert.equal(result.status, 403)
  assert.equal(credentials.records.has('AGENTARTS_MEMORY_API_KEY'), false)
})

await check('routes still mount when webServer arrives after apply', async () => {
  const { ctx, readyWebServer } = mount({ deferWebServer: true })
  assert.equal(ctx.captured.handler, undefined, 'nothing mounted before the service exists')
  readyWebServer()
  assert.ok(ctx.captured.handler, 'the route mounts once webServer arrives')
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  assert.equal(result.status, 200)
})

await check('the schema projects into a settings form', async () => {
  const { Config } = await import('../lib/config.js')
  assert.notEqual(Config, undefined, 'schemastery is resolvable')
  assert.equal(typeof Config.toJSON, 'function')
  const value = Config({})
  assert.equal(value.hindsightConfigPath, '')
  assert.equal(value.openvikingConfigPath, '')
})

/* ---------------- install detection ---------------- */

/** Mount with a Loader that knows about the given plugin packages. */
function mountWithLoader({ installed, disabled = [] }) {
  const captured = { handler: undefined }
  const webServer = {
    register(route) {
      captured.handler = route.handler
      return () => {}
    },
  }
  const entries = [...installed, ...disabled].map((pkg) => ({
    options: { name: pkg, id: `include:${pkg}` },
    disabled: disabled.includes(pkg),
    fiber: {},
  }))
  const ctx = {
    captured,
    tools: { register: () => () => {} },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'credentials') return makeCredentialStore()
      return undefined
    },
    inject(_services, run) {
      run()
    },
    logger: { info() {}, warn() {}, error() {} },
    effect() {},
    fiber: {},
    loader: { entries: () => entries },
  }
  apply(ctx, {})
  return ctx
}

await check('a backend whose plugin is absent is reported as not installed', async () => {
  // Only the hub itself is in the Loader: neither memory plugin is enabled.
  const ctx = mountWithLoader({ installed: ['@local/dsh-memories'] })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  const { openviking, hindsight, agentarts } = result.json.backends
  assert.equal(openviking.installed, false)
  assert.equal(openviking.missingReason, 'missing')
  assert.equal(hindsight.installed, false)
  assert.equal(agentarts.installed, false)
  assert.equal(result.json.backends.openviking.path.endsWith('ovcli.conf'), true, 'the path is still shown')
})

await check('a package present but disabled is reported separately from missing', async () => {
  const ctx = mountWithLoader({
    installed: ['@openviking/dsh-memory-plugin'],
    disabled: ['@vectorize-io/hindsight-coding-agents'],
  })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  assert.equal(result.json.backends.openviking.installed, true)
  assert.equal(result.json.backends.hindsight.installed, false)
  assert.equal(result.json.backends.hindsight.missingReason, 'disabled')
})

await check('the page order is OpenViking, Hindsight, AgentArts', async () => {
  const { BACKEND_IDS } = await import('../lib/index.js')
  assert.deepEqual([...BACKEND_IDS], ['openviking', 'hindsight', 'agentarts'])
})

await check('saving for an uninstalled plugin is refused, not silently accepted', async () => {
  const ctx = mountWithLoader({ installed: ['@local/dsh-memories'] })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'openviking', apiKey: 'ov-key' },
  })
  assert.equal(result.status, 409)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.missing, true)
  assert.match(result.json.error, /未安装/)
})

await check('a disabled plugin says so instead of claiming it is missing', async () => {
  const ctx = mountWithLoader({
    installed: [],
    disabled: ['@vectorize-io/hindsight-coding-agents'],
  })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', apiKey: 'hsk_x' },
  })
  assert.equal(result.status, 409)
  assert.match(result.json.error, /未启用/)
})

await check('a Loader that cannot be read fails open, never blocking a working setup', async () => {
  const { detectInstalled } = await import('../lib/backends.js')
  assert.equal(detectInstalled(undefined, 'openviking').installed, true)
  assert.equal(detectInstalled({}, 'openviking').installed, true)
  assert.equal(
    detectInstalled({ loader: { entries: () => { throw new Error('boom') } } }, 'openviking').installed,
    true,
  )
})

await check('entries are read through ctx.get when the property access throws', async () => {
  const { readEntries, detectInstalled } = await import('../lib/backends.js')
  // A Cordis context throws on reading an uninjected service, so `ctx.loader`
  // is not a safe property read. The documented accessor must be tried.
  const entries = [{ options: { name: '@openviking/dsh-memory-plugin' }, disabled: false }]
  const ctx = {
    get(name) {
      return name === 'loader' ? { entries: () => entries } : undefined
    },
    get loader() {
      throw new Error('cannot get property "loader" without inject')
    },
  }
  assert.equal(readEntries(ctx).length, 1)
  assert.equal(detectInstalled(ctx, 'openviking').installed, true)
})

await check('a Map-shaped entries() result is materialized, not treated as absent', async () => {
  const { readEntries, detectInstalled } = await import('../lib/backends.js')
  // The real Loader returns an iterable Map of id → entry, not an array. A
  // plain Array.isArray test silently reported every package as installed.
  const map = new Map([
    ['include:dsh-memories', { options: { name: '@local/dsh-memories' }, disabled: false }],
  ])
  const ctx = { loader: { entries: () => map } }
  const entries = readEntries(ctx)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].options.name, '@local/dsh-memories')
  const result = detectInstalled(ctx, 'openviking')
  assert.equal(result.installed, false, 'a Map without the package means missing')
  assert.equal(result.reason, 'missing')
})

await check('an iterable of entries is accepted too', async () => {
  const { readEntries } = await import('../lib/backends.js')
  const ctx = {
    loader: {
      entries: () => [1].map(() => ({ options: { name: '@openviking/dsh-memory-plugin' }, disabled: false })),
    },
  }
  assert.equal(readEntries(ctx).length, 1)
})

await check('a populated list without the package means not installed', async () => {
  const { detectInstalled } = await import('../lib/backends.js')
  const ctx = { loader: { entries: () => [{ options: { name: '@local/dsh-memories' }, disabled: false }] } }
  const result = detectInstalled(ctx, 'openviking')
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'missing')
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
