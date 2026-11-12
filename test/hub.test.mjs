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

/* ---------------- service address ---------------- */

await check('a file-backed backend rejects an address with no scheme', async () => {
  await writeFile(hindsightFile, JSON.stringify({ apiToken: 'hsk_keep' }), 'utf8')
  const { ctx } = mount()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'hindsight', url: 'api.example.com' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /http/)
  // Nothing was written: a typo must not land in the document as an endpoint.
  const saved = await readBack(hindsightFile)
  assert.equal(saved.apiUrl, undefined)
  assert.equal(saved.apiToken, 'hsk_keep')
})

await check('every backend that has an address field reports how it is stored', async () => {
  const { ctx } = mount()
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  const { openviking, hindsight, agentarts } = result.json.backends
  assert.equal(openviking.urlField.where, 'document')
  assert.equal(hindsight.urlField.where, 'document')
  // AgentArts keeps its endpoint in the plugin's Loader row, not in a file, so
  // the page has to write it through configEditor rather than a document write.
  assert.equal(agentarts.urlField.where, 'row')
  assert.equal(typeof openviking.urlField.placeholder, 'string')
})

/* ---------------- the masked key, in both shapes ---------------- */

await check('a configured key yields a prefix and a length, never the key', async () => {
  const { secretShape, keySummary } = await import('../lib/backends.js')
  const full = 'hsk_TESTFIXTUREabcdefghijklmnop'
  const shape = secretShape(full)
  assert.equal(shape.mask.prefix, 'hsk_T')
  assert.equal(shape.mask.length, full.length)
  assert.equal(shape.masked, `hsk_T…（${full.length} 位）`)
  assert.equal(JSON.stringify(shape).includes(full), false)
  // Short values degrade instead of revealing more of themselves.
  assert.equal(keySummary('ab').prefix.length < 2, false)
  assert.equal(keySummary(''), undefined)
  assert.equal(keySummary(undefined), undefined)
})

/* ---------------- AgentArts row-backed fields ---------------- */

/**
 * Mount with a fake AgentArts Loader row and a `configEditor`.
 *
 * The address of a private AgentArts deployment lives in that plugin's row, so
 * writing it exercises a different path from the file-backed backends — and one
 * whose failure mode (a cleared endpoint) is invisible until every request
 * breaks.
 */
function mountWithAgentartsRow(config = { spaceId: '', actorId: '', baseUrl: '' }) {
  const captured = { handler: undefined }
  const edits = []
  const row = {
    options: { name: '@local/dsh-agentarts-memory', id: 'include:dsh-agentarts-memory', config: { ...config } },
    disabled: false,
    fiber: {},
  }
  const webServer = {
    register(route) {
      captured.handler = route.handler
      return () => {}
    },
  }
  const ctx = {
    captured,
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'credentials') return makeCredentialStore()
      if (name === 'configEditor') {
        return {
          async edit(entry, change) {
            const next = change({ ...entry.options.config })
            entry.options.config = next
            edits.push(next)
          },
        }
      }
      return undefined
    },
    inject(_services, run) {
      run()
    },
    logger: { info() {}, warn() {}, error() {} },
    effect() {},
    fiber: {},
    loader: { entries: () => [row] },
  }
  apply(ctx, {})
  return { ctx, row, edits }
}

await check('agentarts reports its row endpoint as the backend url', async () => {
  const { ctx } = mountWithAgentartsRow({
    spaceId: '00000000-0000-4000-8000-000000000000',
    actorId: '',
    baseUrl: 'https://memory.cn-southwest-2.huaweicloud-agentarts.com',
  })
  const result = await call(ctx, { method: 'GET', path: '/dsh-memories/status' })
  const { agentarts } = result.json.backends
  // Without this the address field would seed empty and the next save would
  // overwrite a working endpoint with nothing.
  assert.equal(agentarts.url, 'https://memory.cn-southwest-2.huaweicloud-agentarts.com')
  assert.equal(agentarts.rows.baseUrl, 'https://memory.cn-southwest-2.huaweicloud-agentarts.com')
})

await check('agentarts stores a custom endpoint in its row, not in a file', async () => {
  const { ctx, row, edits } = mountWithAgentartsRow()
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: {
      target: 'agentarts',
      apiKey: 'sk-agentarts',
      spaceId: '00000000-0000-4000-8000-000000000000',
      actorId: 'actor-1',
      url: 'https://memory.internal.example',
    },
  })
  assert.equal(result.json.ok, true)
  assert.equal(edits.length, 1, 'exactly one row edit')
  assert.equal(row.options.config.baseUrl, 'https://memory.internal.example')
  assert.equal(row.options.config.spaceId, '00000000-0000-4000-8000-000000000000')
  // The key belongs to the credential store and must not be copied into the
  // patch, where it would be committed and shared.
  assert.equal(row.options.config.apiKey, '')
  assert.equal(result.json.backend.url, 'https://memory.internal.example', 'the page sees the new address')
  // The confirmation names what changed; an unchanged field is not claimed.
  assert.deepEqual(result.json.saved, ['Key', 'Space ID', 'Actor ID', '服务地址'])
})

await check('a save that changes nothing says so instead of claiming a write', async () => {
  const space = '00000000-0000-4000-8000-000000000000'
  const { ctx } = mountWithAgentartsRow({ spaceId: space, actorId: 'actor-1', baseUrl: '' })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'agentarts', spaceId: space, actorId: 'actor-1' },
  })
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.saved, [])
  assert.match(result.json.message, /没有变化/)
})

await check('saving only the endpoint does not clear the space id', async () => {
  const space = '00000000-0000-4000-8000-000000000000'
  const { ctx, row } = mountWithAgentartsRow({ spaceId: space, actorId: 'actor-1', baseUrl: '' })
  await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'agentarts', url: 'https://memory.internal.example' },
  })
  assert.equal(row.options.config.baseUrl, 'https://memory.internal.example')
  assert.equal(row.options.config.spaceId, space, 'an untouched space id survives')
  assert.equal(row.options.config.actorId, 'actor-1')
})

await check('an invalid endpoint is refused before the row is touched', async () => {
  const { ctx, edits } = mountWithAgentartsRow({ spaceId: 'sp', actorId: '', baseUrl: 'https://keep.example' })
  const result = await call(ctx, {
    method: 'POST',
    path: '/dsh-memories/save',
    body: { target: 'agentarts', url: 'ftp://nope' },
  })
  assert.equal(result.status, 400)
  assert.equal(edits.length, 0)
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
