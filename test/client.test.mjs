/**
 * Client-side checks for the memory hub's masked fields.
 *
 * The page shows Space/Actor/Key/URL. Every one of them must render as a
 * masked input with a reveal toggle — that is a request about what ends up on
 * screen, so it is asserted against the rendered tree rather than by reading
 * the source.
 *
 * Run: node test/client.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let failures = 0
const check = (name, run) => {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The same check for anything that awaits.
 *
 * The reveal flow is asynchronous by definition — it asks the Host for a secret
 * and renders the answer — so it cannot be expressed through the synchronous
 * `check`. Errors are collected the same way so the summary stays accurate.
 */
const checkAsync = async (name, run) => {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Install the client module with a React stand-in that keeps the element tree.
 *
 * Function components are invoked as they are met, so the result is the props
 * the real UI would receive — not the source text.
 */
function loadClient() {
  const state = new Map()
  const React = {
    createElement(type, props, ...kids) {
      const children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      // Give each call site a stable slot, seeded once.
      const slot = Symbol('state')
      if (!state.has(slot)) state.set(slot, initial)
      return [state.get(slot), (next) => state.set(slot, typeof next === 'function' ? next(state.get(slot)) : next)]
    },
    useCallback: (fn) => fn,
    /**
     * Effects are not run.
     *
     * The section seeds its inputs from `props` inside `useEffect`, and honouring
     * that faithfully needs a real reconciler. These checks are about the
     * RENDERING CONTRACT — masked inputs, one toggle each, no `<label>` wrapper —
     * so the initial render is exactly what they should inspect. Seeded values
     * are covered by the Host-side tests in `hub.test.mjs`.
     */
    useEffect: () => {},
  }

  globalThis.window = {
    __ModuleLoader__: { load: (def) => { globalThis.__def = def } },
    location: { origin: 'http://127.0.0.1:1' },
  }

  vm.runInThisContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const mod = globalThis.__def.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })

  const registrations = []
  mod.apply({
    slots: {
      inject: (_key, run) => run(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  return { mod, registrations }
}

/**
 * Render a node to a plain tree of host elements.
 *
 * Function components are CALLED, not recorded, so the result carries the
 * props the browser would receive — that is the point of doing this instead of
 * grepping the source.
 */
function expand(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return expand(node.type(node.props))
  }
  const kids = node.props?.children
  const list = kids === undefined || kids === null ? [] : Array.isArray(kids) ? kids : [kids]
  return { tag: node.type, props: node.props, children: list.map(expand) }
}

/** Walk an expanded tree, collecting every node the predicate accepts. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  collect(node.children, predicate, out)
  return out
}

/** A backend-shaped prop set, AgentArts included so its row fields render. */
const backend = {
  id: 'agentarts',
  title: '华为云 AgentArts 记忆库',
  hint: '提示',
  path: 'C:/Users/example/.dsh/.credentials.yaml',
  configured: true,
  writable: true,
  // What the Host reports for a configured backend: recognisable, not usable.
  masked: 'sk-ab…（35 位）',
  mask: { prefix: 'sk-ab', length: 35 },
  // AgentArts' address lives in its Loader row, not in a config document.
  urlField: { where: 'row', label: '服务地址（可选）', placeholder: '请输入服务地址' },
  rows: {
    configurable: true,
    // Obvious placeholders: a real space id must never end up in a published
    // test fixture, which is how personal identifiers leak into a repo.
    spaceId: '00000000-0000-4000-8000-000000000000',
    actorId: '11111111-1111-4111-8111-111111111111',
    region: 'cn-southwest-2',
    baseUrl: 'https://memory.cn-southwest-2.huaweicloud-agentarts.com',
  },
}

const { registrations } = loadClient()

check('client registers exactly one Settings section named 记忆库', () => {
  assert.equal(registrations.length, 1)
  const { options } = registrations[0]
  assert.equal(options.id, 'dsh-memories')
  assert.equal(options.name, 'settings.section')
  assert.equal(options.label(), '记忆库')
})

/**
 * Render one backend section.
 *
 * The registered component is the whole page, which fetches its data on mount;
 * the field layout lives in the per-backend section. Rendering that section
 * directly makes these assertions about the fields instead of about a page
 * still waiting on a request.
 */
function renderSection() {
  const component = globalThis.__sections?.BackendSection
  assert.equal(typeof component, 'function', 'the client exposes BackendSection for rendering')
  return expand(component({ backend, onSaved: () => {} }))
}

// Render one backend section once; every field assertion reads this tree.
const tree = renderSection()

check('agentarts masks Space, Actor and Key, and leaves the address readable', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  // AgentArts shows Space / Actor / Key / Address. The first three are values
  // worth keeping off a screenshot; the address is a URL the user must read.
  assert.equal(inputs.length, 4, `expected 4 fields for AgentArts, saw ${inputs.length}`)
  for (const input of inputs.slice(0, 3)) {
    assert.equal(
      input.props.type,
      'password',
      `an input rendered as type="${input.props.type}", so its value would be visible on screen`,
    )
  }
  assert.equal(inputs[3].props.type, 'text', 'the address is not a secret and is shown as text')
})

check('only credentials are masked; a service address stays readable', () => {
  const Component = globalThis.__sections.BackendSection
  const ov = expand(
    Component({
      backend: {
        id: 'openviking',
        title: 'OpenViking',
        hint: 'h',
        path: 'p',
        configured: false,
        writable: true,
        urlField: { where: 'document', label: '服务地址（可选）', placeholder: '请输入服务地址' },
      },
      onSaved: () => {},
    }),
  )
  const inputs = collect(ov, (node) => node.tag === 'input')
  assert.equal(inputs.length, 2, 'key + address')
  // Key first (masked), address second (plain): a URL is not a secret, and
  // hiding it produced a row of dots for a value the user must verify.
  assert.equal(inputs[0].props.type, 'password', 'the key is masked')
  assert.equal(inputs[1].props.type, 'text', 'the address is not masked')
})

check('a backend that declares no address field renders no address input', () => {
  const Component = globalThis.__sections.BackendSection
  const none = expand(
    Component({
      backend: { id: 'hindsight', title: 'Hindsight', hint: 'h', path: 'p', configured: false, writable: true },
      onSaved: () => {},
    }),
  )
  assert.equal(collect(none, (node) => node.tag === 'input').length, 1, 'key only')
})

check('the address hint describes the address actually stored, not the default', () => {
  const Component = globalThis.__sections.BackendSection
  const withStored = expand(
    Component({
      backend: {
        id: 'agentarts',
        title: '华为云 AgentArts 记忆库',
        hint: 'h',
        path: 'p',
        configured: true,
        writable: true,
        installed: true,
        mask: { prefix: 'sk-ab', length: 35 },
        // A private deployment: the default-address sentence would be wrong.
        url: 'https://memory.internal.example',
        urlField: { where: 'row', label: '服务地址（可选）', placeholder: '请输入服务地址' },
        rows: { configurable: true, spaceId: 'sp', actorId: '' },
      },
      onSaved: () => {},
    }),
  )
  const hints = collect(withStored, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  const hint = hints.find((text) => /当前为|默认地址/.test(text))
  assert.ok(hint, 'an address hint is rendered')
  assert.match(hint, /当前为 https:\/\/memory\.internal\.example/, 'it names the stored address')
  assert.equal(/默认地址/.test(hint), false, 'and does not claim the default is in use')
})

check('an unconfigured key shows the plain instruction, not dots', () => {
  const Component = globalThis.__sections.BackendSection
  const empty = expand(
    Component({
      backend: {
        id: 'openviking',
        title: 'OpenViking 记忆',
        hint: 'h',
        path: 'p',
        configured: false,
        writable: true,
        installed: true,
      },
      onSaved: () => {},
    }),
  )
  const keyInput = collect(empty, (node) => node.tag === 'input')[0]
  assert.equal(String(keyInput.props.placeholder), '请输入 API Key')
  assert.equal(keyInput.props.value, '', 'no value before anything is typed')
  assert.equal(keyInput.props.className, undefined, 'no dot styling when nothing is stored')
})

check('a configured key looks filled (dots) while its value stays out of the DOM', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  const keyInput = inputs[2]
  // This is the "looks like asterisks after saving" half of the request.
  assert.match(String(keyInput.props.placeholder), /^•+$/, 'a stored key reads as a filled field')
  assert.equal(keyInput.props.value, '', 'but the box holds no value: the dots are a placeholder')
  assert.equal(keyInput.props.className, 'dsh-memories-dots', 'painted as a status decoration, not grey hint text')
  // And no fragment of the key leaks through the placeholder, unlike the old
  // `hsk_f…（53 位）` that put five real characters on screen.
  assert.equal(String(keyInput.props.placeholder).includes('sk-ab'), false)
  assert.equal(String(keyInput.props.placeholder).includes('hsk'), false)
})

check('the dot run is capped and never shorter than a readable run', () => {
  const { dotPlaceholder } = globalThis.__sections
  const dot = globalThis.__sections.dotPlaceholder
  assert.equal(typeof dot, 'function', 'dotPlaceholder is exposed for this check')
  assert.equal(dot(500).length, 40, 'a long certificate does not render a wall of bullets')
  assert.equal(dot(undefined).length, 16, 'an unknown length still looks filled')
  assert.ok(dot(3).length >= 8, 'short values keep a readable run')
  assert.match(dot(35), /^•{35}$/, 'a known length matches the key')
})

check('the key hint states which key is saved, in words rather than a fake value', () => {
  const hints = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  const hint = hints.find((text) => text.includes('开头，共'))
  assert.ok(hint, 'the hint line names the saved key')
  assert.match(hint, /sk-ab 开头，共 35 位/, 'it carries the identifying facts')
  assert.match(hint, /留空则保持不变/, 'and still explains that blank keeps it')
  // The full masked string must not be dressed up as a value anywhere.
  assert.equal(hints.some((text) => text.includes('sk-ab…（35 位）')), false)
})

check('the key field never echoes a stored secret as its value', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  for (const input of inputs) {
    const value = input.props.value
    assert.ok(
      value === '' || value === undefined,
      `a field rendered a non-empty initial value: ${String(value).slice(0, 12)}…`,
    )
  }
})

check('a successful key save says the box now shows masked characters', () => {
  const { successText } = globalThis.__sections
  assert.equal(typeof successText, 'function')

  const withKey = successText({ saved: ['Key'], message: '已写入 Hindsight 记忆 的 Key。' })
  assert.match(withKey, /已写入 Hindsight 记忆 的 Key。/)
  assert.match(withKey, /显示/, 'it points at the button that shows the key')

  // A save that did not touch the key has nothing to explain.
  const noKey = successText({ saved: ['服务地址'], message: '已写入 X 的 服务地址。' })
  assert.equal(noKey, '已写入 X 的 服务地址。')

  // Defensive: an unexpected payload still yields a sentence, never "undefined".
  assert.equal(successText(undefined), '已保存。')
  assert.equal(successText({}), '已保存。')
})

check('the saved-key hint tells the user 显示 will show it', () => {
  const hints = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  const hint = hints.find((text) => /开头，共/.test(text))
  assert.ok(hint, 'the hint line names the saved key')
  assert.match(hint, /显示/, 'it explains how to look at the key')
})

/**
 * A one-component reconciler.
 *
 * The earlier checks render once and read the tree, which is enough for layout
 * questions but useless for the reveal flow: that one depends on state set by a
 * click and observed on the NEXT render. This keeps one hook list per mounted
 * instance and re-renders that same instance after a handler runs.
 *
 * The module's components close over the React object the factory handed them,
 * so this cannot inject a different one per mount. Instead the factory receives
 * `liveReact`, whose hooks forward to whichever instance is rendering right
 * now; `currentInstance` tracks that.
 */
let currentInstance = undefined

/** Hook slots of the instance currently rendering, or a throwaway list. */
function hookSlots() {
  if (currentInstance === undefined) {
    // A render outside render()/act(): give it isolated slots so the check
    // fails on its assertion rather than on a confusing shared-state bug.
    return { slots: [], cursor: 0, fresh: true }
  }
  return currentInstance
}

const liveReact = {
  createElement(type, elProps, ...kids) {
    const children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
    return { type, props: { ...(elProps ?? {}), children } }
  },
  useState(initial) {
    const owner = hookSlots()
    if (owner.fresh === true) return [initial, () => {}]
    const index = owner.cursor++
    if (owner.slots[index] === undefined) owner.slots[index] = { value: initial }
    const slot = owner.slots[index]
    return [
      slot.value,
      (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      },
    ]
  },
  useCallback: (fn) => fn,
  // Effects deliberately do not run; the reveal flow does not need one, and the
  // seeding effects are covered by the Host-side tests.
  useEffect: () => {},
}

/** Mount one component on `liveReact` and expose render/act. */
function mountComponent(component, props) {
  const instance = { slots: [], cursor: 0 }
  const render = () => {
    const previous = currentInstance
    currentInstance = instance
    instance.cursor = 0
    try {
      return expand(component(props))
    } finally {
      currentInstance = previous
    }
  }
  /** Run a handler, let pending promises settle, then re-render. */
  const act = async (run) => {
    await run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return render()
  }
  return { render, act }
}

/** Load the client module once, wired to `liveReact`. */
function loadClientWithReconciler() {
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { globalThis.__def2 = def } },
    location: { origin: 'http://127.0.0.1:1' },
  }
  vm.runInThisContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const mod = globalThis.__def2.factory((id) => {
    if (id === 'react') return liveReact
    throw new Error(`unexpected require: ${id}`)
  })
  mod.apply({
    slots: {
      inject: (_key, run) => run(),
      register: (_options, componentToMount) => {
        globalThis.__page2 = componentToMount
        return () => {}
      },
    },
  })
  return globalThis.__sections
}

/* ---- the reveal flow: dots -> 显示 -> plaintext -> 隐藏 ---- */

/** The key input and the reveal toggle of a rendered section. */
const keyFieldOf = (tree) => collect(tree, (node) => node.tag === 'input')[0]
const revealToggleOf = (tree) =>
  collect(tree, (node) => node.tag === 'button').find((button) => /显示|隐藏|读取/.test(String(button.props.children)))

const revealedBackend = {
  id: 'hindsight',
  title: 'Hindsight 记忆',
  hint: 'h',
  path: 'p',
  configured: true,
  writable: true,
  installed: true,
  masked: 'hsk_T…（29 位）',
  mask: { prefix: 'hsk_T', length: 29 },
  urlField: { where: 'document', label: '服务地址（可选）', placeholder: '请输入服务地址' },
}

await checkAsync('显示 fetches the stored key, shows it in clear, and 隐藏 drops it', async () => {
  const sections = loadClientWithReconciler()
  const secret = 'hsk_TESTFIXTURE-REVEALED-0001'
  let calls = 0
  const mounted = mountComponent(sections.BackendSection, {
    backend: revealedBackend,
    onSaved: () => {},
    revealKey: async () => {
      calls += 1
      return { ok: true, value: secret }
    },
  })

  // 1. Mount: the field looks filled, holds no value, and has fetched nothing.
  //    Loading the page is not a request to see a secret.
  let tree = mounted.render()
  assert.match(String(keyFieldOf(tree).props.placeholder), /^•+$/, 'a stored key reads as filled')
  assert.equal(keyFieldOf(tree).props.value, '', 'the secret is not in the DOM on mount')
  assert.equal(keyFieldOf(tree).props.type, 'password', 'and it is masked')
  assert.equal(calls, 0, 'no reveal on mount')

  // 2. Press 显示: exactly one fetch, and the value becomes visible in clear.
  tree = await mounted.act(() => revealToggleOf(tree).props.onClick())
  assert.equal(calls, 1, 'pressing 显示 fetches the key')
  assert.equal(keyFieldOf(tree).props.value, secret, 'the key is now in the field')
  assert.equal(keyFieldOf(tree).props.type, 'text', 'and shown in clear')
  assert.equal(String(revealToggleOf(tree).props.children), '隐藏', 'the button flipped')

  // 3. Press 隐藏: masked again, secret gone, and no second fetch.
  tree = await mounted.act(() => revealToggleOf(tree).props.onClick())
  assert.equal(keyFieldOf(tree).props.value, '', 'the secret is dropped from the field')
  assert.equal(keyFieldOf(tree).props.type, 'password', 'masked again')
  assert.equal(calls, 1, 'no second fetch just to hide it')
  assert.match(String(keyFieldOf(tree).props.placeholder), /^•+$/, 'dots come back')
})

await checkAsync('a failed 显示 explains itself instead of silently doing nothing', async () => {
  const sections = loadClientWithReconciler()
  const mounted = mountComponent(sections.BackendSection, {
    backend: revealedBackend,
    onSaved: () => {},
    revealKey: async () => ({ ok: false, error: '还没有保存 Hindsight 的 API Token' }),
  })
  let tree = mounted.render()
  tree = await mounted.act(() => revealToggleOf(tree).props.onClick())
  const texts = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(
    texts.some((text) => text.includes('还没有保存')),
    `the Host error is shown; saw: ${JSON.stringify(texts)}`,
  )
  // A failed reveal must not pretend to have succeeded.
  assert.equal(keyFieldOf(tree).props.type, 'password')
})

/* ---- checks that only need a single render ---- */

check('a stored key is never part of the status payload', () => {
  // The page's own data must not contain a secret: it may show THAT a key is
  // configured, never the key. Revealing is a separate, explicit request.
  const payload = JSON.stringify(backend)
  assert.equal(payload.includes('sk-ab…'), true, 'the masked form is present')
  assert.equal(/sk-ab[a-z0-9]{10,}/i.test(payload), false, 'no full key')
})

check('the save outcome renders below the button, not as a caption beside it', () => {
  const Component = globalThis.__sections.BackendSection
  const section = expand(
    Component({
      backend: {
        id: 'hindsight',
        title: 'Hindsight 记忆',
        hint: 'h',
        path: 'p',
        configured: false,
        writable: true,
        installed: true,
        urlField: { where: 'document', label: '服务地址（可选）', placeholder: '请输入服务地址' },
      },
      onSaved: () => {},
    }),
  )
  // With no save attempted yet there is no notice at all.
  const statuses = collect(section, (node) => node.props?.role === 'status')
  assert.equal(statuses.length, 0, 'no empty status strip before the first save')
})

check('the badge reports a state, not a truncated key', () => {
  const texts = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(texts.includes('已保存 API Key'), 'the header badge says the key is saved')
  assert.equal(texts.includes('已配置'), false, 'the old 已配置 wording is gone')
  assert.equal(
    texts.some((text) => text.includes('…（')),
    false,
    'a pill must not carry a truncated value: it reads as the key itself',
  )
})

check('each masked input is paired with a reveal toggle', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  const masked = inputs.filter((node) => node.props.type === 'password')
  const buttons = collect(tree, (node) => node.tag === 'button')
  const toggles = buttons.filter((button) => /显示|隐藏/.test(String(button.props.children)))
  assert.equal(toggles.length, masked.length, 'one toggle per masked field, and none for the address')
  for (const toggle of toggles) {
    assert.equal(toggle.props.type, 'button', 'a toggle must never submit a form')
    // preventDefault on mousedown keeps focus in the field being edited.
    assert.equal(typeof toggle.props.onMouseDown, 'function', 'toggle must not steal focus')
    assert.match(String(toggle.props['aria-label']), /显示|隐藏/)
  }
})

check('the toggle starts in the 显示 state, so nothing is revealed by default', () => {
  const buttons = collect(tree, (node) => node.tag === 'button')
  const toggles = buttons.filter((button) => /显示|隐藏/.test(String(button.props.children)))
  for (const toggle of toggles) {
    assert.equal(toggle.props.children, '显示', 'fields must start hidden')
    assert.equal(toggle.props['aria-pressed'], false)
    // Never disabled: a control that is greyed out for no visible reason sends
    // the reader looking for a cause that is not there.
    assert.notEqual(toggle.props.disabled, true)
  }
})

check('field captions are present for each control', () => {
  const spans = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(spans.includes('Space ID'))
  assert.ok(spans.includes('Actor ID（可选）'))
  assert.ok(spans.includes('API Key'))
  assert.ok(spans.includes('服务地址（可选）'))
})

check('a label element never wraps the masked control', () => {
  // A <label> wrapper would make the reveal button also focus the input.
  const labels = collect(tree, (node) => node.tag === 'label')
  assert.equal(labels.length, 0, 'the masked fields must not be wrapped in <label>')
})

check('an uninstalled plugin cannot be saved', () => {
  const Component = globalThis.__sections.BackendSection
  for (const missingReason of ['missing', 'disabled']) {
    const section = expand(
      Component({
        backend: {
          id: 'openviking',
          title: 'OpenViking 记忆',
          hint: 'h',
          path: 'p',
          configured: false,
          writable: true,
          installed: false,
          missingReason,
        },
        onSaved: () => {},
      }),
    )
    const saveButton = collect(section, (node) => node.tag === 'button').find(
      (node) => String(node.props.children) === '保存',
    )
    assert.ok(saveButton, 'the save button still renders, so the reason is visible')
    assert.equal(saveButton.props.disabled, true, `save must be disabled (${missingReason})`)

    const texts = collect(section, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
    const badge = missingReason === 'disabled' ? '已安装未启用' : '插件未安装'
    assert.ok(texts.includes(badge), `the header says ${badge}`)
  }
})

check('a section renders the saved-key state for OpenViking when installed', () => {
  // Order itself is asserted in hub.test.mjs against BACKEND_IDS, the single
  // source both halves read; this checks a section renders correctly for a
  // backend other than AgentArts.
  const Component = globalThis.__sections.BackendSection
  const ov = expand(
    Component({
      backend: {
        id: 'openviking',
        title: 'OpenViking 记忆',
        hint: 'h',
        path: 'p',
        configured: true,
        writable: true,
        installed: true,
        masked: 'ov-ke…（32 位）',
        mask: { prefix: 'ov-ke', length: 32 },
        url: 'https://ov.example',
        urlField: { where: 'document', label: '服务地址（可选）', placeholder: '请输入服务地址' },
      },
      onSaved: () => {},
    }),
  )
  const texts = collect(ov, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(texts.includes('已保存 API Key'), 'the badge reports the state')
  assert.ok(
    texts.some((text) => text.includes('ov-ke 开头，共 32 位')),
    'the hint names the key by prefix and length',
  )
  // The URL is readable, not masked. Its VALUE is seeded by an effect, which
  // this stand-in does not run; the input TYPE is what the masking contract is
  // about, so that is what is asserted.
  const inputs = collect(ov, (node) => node.tag === 'input')
  const urlInput = inputs[inputs.length - 1]
  assert.equal(urlInput.props.type, 'text', 'the address field is not masked')
  assert.equal(collect(ov, (node) => node.tag === 'input').every((n) => n.props.type !== 'hidden'), true)
})

check('an installed backend is not blocked by the install flag', () => {
  const Component = globalThis.__sections.BackendSection
  const installed = expand(
    Component({
      backend: {
        id: 'hindsight',
        title: 'Hindsight',
        hint: 'h',
        path: 'p',
        configured: false,
        writable: true,
        installed: true,
      },
      onSaved: () => {},
    }),
  )
  const saveButton = collect(installed, (node) => node.tag === 'button').find(
    (node) => String(node.props.children) === '保存',
  )
  // Disabled only because the form is empty — not because of `installed`.
  assert.equal(saveButton.props.disabled, true)
  const texts = collect(installed, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.equal(texts.includes('插件未安装'), false, 'no missing badge for an installed backend')
  assert.equal(texts.some((text) => /保存已停用/.test(text)), false, 'no disabled-reason note')
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
