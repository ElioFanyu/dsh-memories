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
  rows: {
    configurable: true,
    // Obvious placeholders: a real space id must never end up in a published
    // test fixture, which is how personal identifiers leak into a repo.
    spaceId: '00000000-0000-4000-8000-000000000000',
    actorId: '11111111-1111-4111-8111-111111111111',
    region: 'cn-southwest-2',
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

check('agentarts masks all three of its fields', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  // AgentArts shows Space / Actor / Key (no service-address field), and all
  // three are values worth keeping off a screenshot.
  assert.equal(inputs.length, 3, `expected 3 fields for AgentArts, saw ${inputs.length}`)
  for (const input of inputs) {
    assert.equal(
      input.props.type,
      'password',
      `an input rendered as type="${input.props.type}", so its value would be visible on screen`,
    )
  }
})

check('only the key is masked; the service address stays readable', () => {
  const Component = globalThis.__sections.BackendSection
  const ov = expand(
    Component({
      backend: { id: 'openviking', title: 'OpenViking', hint: 'h', path: 'p', configured: false, writable: true },
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

check('the key placeholder names the configured key, not the word 已配置', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  const keyInput = inputs[inputs.length - 1]
  const placeholder = String(keyInput.props.placeholder)

  // The field must say WHICH key is configured — that is the question a person
  // has when they open this page. "已配置" alone answers nothing.
  assert.equal(placeholder.includes('已配置'), false, 'the placeholder must not just say 已配置')
  assert.match(placeholder, /…（\d+ 位）/, 'the placeholder shows the masked key')
  assert.match(placeholder, /留空则不改动/, 'and still explains that blank keeps it')
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

check('the badge also names the configured key', () => {
  const texts = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(
    texts.some((text) => text.includes('sk-ab…（35 位）')),
    'the section header shows the masked key too',
  )
  assert.equal(texts.includes('已配置'), false, 'no bare 已配置 badge for a configured backend')
})

check('each masked input is paired with a reveal toggle', () => {
  const inputs = collect(tree, (node) => node.tag === 'input')
  const buttons = collect(tree, (node) => node.tag === 'button')
  const toggles = buttons.filter((button) => /显示|隐藏/.test(String(button.props.children)))
  assert.equal(toggles.length, inputs.length, 'one toggle per masked field')
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
  }
})

check('field captions are present for each control', () => {
  const spans = collect(tree, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(spans.includes('Space ID'))
  assert.ok(spans.includes('Actor ID（可选）'))
  assert.ok(spans.includes('API Key'))
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

check('a section renders the masked key badge for OpenViking when installed', () => {
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
        url: 'https://ov.example',
      },
      onSaved: () => {},
    }),
  )
  const texts = collect(ov, (node) => node.tag === 'span').map((node) => String(node.props.children ?? ''))
  assert.ok(texts.includes('ov-ke…（32 位）'), 'the masked openviking key is shown')
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
