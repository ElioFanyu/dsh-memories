/**
 * Memory hub — Client half (the Settings page).
 *
 * One page, three sections: 华为 AgentArts 记忆库 / Hindsight / OpenViking.
 * Each section asks the Host for that backend's current state and can store one
 * key into it.
 *
 * Two design points worth stating:
 *
 *   - The page never reads a key back. The field starts empty every time and
 *     says "已配置，留空不改动" when one exists. A secret that can be rendered
 *     is a secret that leaks through a screenshot or a shared screen.
 *   - Every backend shows the FILE its key goes to. "Saved" is otherwise a
 *     claim the user cannot check; a path is something they can open.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memories',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Must equal `ROUTE_PREFIX` in the Host half. */
    const ROUTE_PREFIX = '/dsh-memories'
    /** Section id; unique across the Settings navigation. */
    const SECTION_ID = 'dsh-memories'
    /** Nav position: right after the shipped Plugins entry (15), before the market (40). */
    const SECTION_ORDER = 16
    /** Nav label. A thunk so the shell re-reads it on locale change. */
    const SECTION_LABEL = () => '记忆库'

    const TOKENS = {
      text: 'var(--dsw-alias-text-primary, rgba(28,28,30,1))',
      muted: 'var(--dsw-alias-text-secondary, rgba(128,128,128,1))',
      border: 'var(--dsw-alias-border-subtle, rgba(128,128,128,0.26))',
      panel: 'var(--dsw-alias-bg-section, rgba(128,128,128,0.06))',
      accent: 'var(--dsw-alias-brand-primary, rgba(31,110,255,1))',
      ok: 'var(--dsw-alias-status-success, rgba(30,150,80,1))',
      warn: 'var(--dsw-alias-status-warning, rgba(214,140,0,1))',
      danger: 'var(--dsw-alias-status-danger, rgba(214,48,49,1))',
      mono: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    }

    /** Route URL for one action, tolerating a page mounted under a sub-path. */
    function routeUrl(action) {
      const base = typeof window !== 'undefined' && window.location ? window.location.origin : ''
      return `${base}${ROUTE_PREFIX}/${action}`
    }

    /**
     * Call one route.
     *
     * A 404/405 means the Host route is not mounted: the request reached the
     * app's static fallback. Saying "non-JSON response" would send the reader
     * looking in the wrong place.
     */
    async function callRoute(action, init) {
      const response = await fetch(routeUrl(action), init)
      if (response.status === 404 || response.status === 405) {
        throw new Error(
          `设置页通道未挂载（HTTP ${response.status}）：Host 侧没有注册 ${ROUTE_PREFIX} 路由。通常是插件刚装好、宿主还没加载到这一行——重启 DSH 后重试。`,
        )
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined) throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`)
      return payload
    }

    const getStatus = () => callRoute('status', { headers: { accept: 'application/json' } })

    const saveBackend = (body) =>
      callRoute('save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    /* ---- presentational pieces ---- */

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      fontSize: '13px',
      color: TOKENS.text,
      background: 'transparent',
      border: `1px solid ${TOKENS.border}`,
      borderRadius: '8px',
      outline: 'none',
      fontFamily: 'inherit',
    }

    function TextInput(props) {
      return h('input', {
        type: props.type ?? 'text',
        value: props.value,
        placeholder: props.placeholder,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => props.onChange(event.target.value),
        style: { ...inputStyle, ...(props.style ?? {}) },
      })
    }

    /**
     * A field that is masked by default, with a button to reveal it.
     *
     * Space ids, actor ids and keys are all things you copy-paste and then want
     * to verify character by character — invisible by default keeps them out of
     * screenshots and screen shares, and the toggle makes verifying possible
     * without leaving the page.
     *
     * Rendered as a `div`, not a `label`: a `<label>` wrapping these controls
     * would forward every click on the toggle button to the input, so clicking
     * "显示" would also steal focus and move the caret.
     */
    function MaskedField(props) {
      const [shown, setShown] = React.useState(false)
      return h(
        'div',
        { style: { position: 'relative' } },
        h(TextInput, {
          type: shown ? 'text' : 'password',
          value: props.value,
          placeholder: props.placeholder,
          onChange: props.onChange,
          style: { paddingRight: '58px' },
        }),
        h(
          'button',
          {
            type: 'button',
            // A toggle is a view control: it must not submit anything or take
            // focus away from the field being edited.
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => setShown((current) => !current),
            title: shown ? '隐藏内容' : '显示内容',
            'aria-label': shown ? '隐藏内容' : '显示内容',
            'aria-pressed': shown,
            style: {
              position: 'absolute',
              top: '50%',
              right: '6px',
              transform: 'translateY(-50%)',
              padding: '3px 9px',
              fontSize: '11.5px',
              lineHeight: 1.6,
              borderRadius: '6px',
              border: `1px solid ${TOKENS.border}`,
              background: TOKENS.panel,
              color: TOKENS.muted,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          },
          shown ? '隐藏' : '显示',
        ),
      )
    }

    /**
     * A titled field: caption above, control below.
     *
     * `masked` is opt-in. A service URL is not a secret — hiding it made the
     * page show a row of dots for a value the user needs to read and verify,
     * which is the opposite of helpful. Only credentials are masked.
     */
    function MaskedRow(props) {
      const masked = props.masked !== false
      return h(
        'div',
        { style: { display: 'block', ...(props.style ?? {}) } },
        h(
          'span',
          {
            style: {
              display: 'block',
              fontSize: '12.5px',
              fontWeight: 600,
              marginBottom: '5px',
              color: TOKENS.text,
            },
          },
          props.label,
        ),
        masked
          ? h(MaskedField, {
              value: props.value,
              placeholder: props.placeholder,
              onChange: props.onChange,
            })
          : h(TextInput, {
              value: props.value,
              placeholder: props.placeholder,
              onChange: props.onChange,
            }),
      )
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled === true,
          onClick: props.onClick,
          style: {
            padding: '7px 15px',
            fontSize: '13px',
            fontWeight: 500,
            borderRadius: '8px',
            cursor: props.disabled === true ? 'not-allowed' : 'pointer',
            opacity: props.disabled === true ? 0.55 : 1,
            border: props.primary === true ? '1px solid transparent' : `1px solid ${TOKENS.border}`,
            background: props.primary === true ? TOKENS.accent : 'transparent',
            color: props.primary === true ? '#fff' : TOKENS.text,
            fontFamily: 'inherit',
          },
        },
        props.label,
      )
    }

    /** A status pill: 已配置 / 未配置 / 不可写. */
    function Badge(props) {
      const color = props.tone === 'ok' ? TOKENS.ok : props.tone === 'warn' ? TOKENS.warn : TOKENS.muted
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: '999px',
            fontSize: '11.5px',
            lineHeight: 1.7,
            color,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.panel,
            whiteSpace: 'nowrap',
            ...(props.mono === true ? { fontFamily: TOKENS.mono, letterSpacing: '0.02em' } : {}),
          },
        },
        props.label,
      )
    }

    function PathLine(props) {
      return h(
        'div',
        {
          style: {
            marginTop: '8px',
            fontSize: '11.5px',
            color: TOKENS.muted,
            fontFamily: TOKENS.mono,
            wordBreak: 'break-all',
            lineHeight: 1.6,
          },
          title: props.path,
        },
        props.path,
      )
    }

    /**
     * One backend section: title, state, key field, optional URL field, save.
     *
     * Kept as one component so all three behave identically — a page where one
     * service saves on Enter and another needs a button is a page people
     * misconfigure.
     */
    function BackendSection(props) {
      const { backend, onSaved } = props
      const [keyValue, setKeyValue] = React.useState('')
      const [urlValue, setUrlValue] = React.useState('')
      const [spaceValue, setSpaceValue] = React.useState('')
      const [actorValue, setActorValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(undefined)

      // Row-backed fields (AgentArts) seed from the row's live values.
      const rows = backend.rows
      const rowBacked = rows !== undefined && rows.configurable !== false

      // Seed the URL field from what is stored, so editing it starts from truth.
      React.useEffect(() => {
        setUrlValue(typeof backend.url === 'string' ? backend.url : '')
      }, [backend.url])

      React.useEffect(() => {
        setSpaceValue(rows !== undefined && typeof rows.spaceId === 'string' ? rows.spaceId : '')
        setActorValue(rows !== undefined && typeof rows.actorId === 'string' ? rows.actorId : '')
      }, [rows?.spaceId, rows?.actorId])

      const canSave =
        keyValue.trim() !== '' ||
        urlValue.trim() !== '' ||
        (rowBacked && (spaceValue.trim() !== '' || actorValue.trim() !== ''))
      const supportsUrl = backend.id !== 'agentarts'
      // A key saved for a plugin that is not installed would be read by nothing,
      // so the save control is disabled rather than letting the write look
      // successful. The Host refuses it too; this is the visible half.
      const installed = backend.installed !== false

      const save = async () => {
        setBusy(true)
        setNotice(undefined)
        try {
          const payload = await saveBackend({
            target: backend.id,
            apiKey: keyValue,
            url: supportsUrl ? urlValue : '',
            ...(rowBacked ? { spaceId: spaceValue, actorId: actorValue } : {}),
          })
          if (payload?.ok !== true) {
            setNotice({ tone: 'error', text: payload?.error ?? '保存失败' })
            return
          }
          // Clear the secret immediately: a saved key must not linger in a form.
          setKeyValue('')
          setNotice({ tone: 'ok', text: payload.message ?? '已保存' })
          onSaved?.(payload.backend)
        } catch (error) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'section',
        {
          style: {
            padding: '16px 18px',
            borderRadius: '10px',
            border: `1px solid ${TOKENS.border}`,
            marginBottom: '16px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' } },
          h('h3', { style: { margin: 0, fontSize: '13.5px', fontWeight: 600 } }, backend.title),
          // Not installed wins over "configured": a key may sit in the file from
          // an earlier install, and reporting it as active would be a lie.
          backend.installed === false
            ? h(Badge, {
                label: backend.missingReason === 'disabled' ? '已安装未启用' : '插件未安装',
                tone: 'warn',
              })
            : backend.configured === true && typeof backend.masked === 'string'
              ? h(Badge, { label: backend.masked, tone: 'ok', mono: true })
              : h(Badge, {
                  label: backend.configured === true ? '已配置' : '未配置',
                  tone: backend.configured === true ? 'ok' : 'warn',
                }),
          backend.writable === false ? h(Badge, { label: '不可写', tone: 'muted' }) : null,
        ),
        h('p', { style: { margin: '0 0 13px', fontSize: '12px', color: TOKENS.muted, lineHeight: 1.6 } }, backend.hint),
        backend.detail === undefined
          ? null
          : h('p', { style: { margin: '0 0 12px', fontSize: '12px', color: TOKENS.warn, lineHeight: 1.6 } }, backend.detail),

        rowBacked
          ? h(
              'div',
              { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' } },
              h(MaskedRow, {
                label: 'Space ID',
                value: spaceValue,
                placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
                onChange: setSpaceValue,
                style: { flex: '1 1 240px' },
              }),
              h(MaskedRow, {
                label: 'Actor ID（可选）',
                value: actorValue,
                placeholder: '留空表示不按 actor 过滤',
                onChange: setActorValue,
                style: { flex: '1 1 240px' },
              }),
            )
          : null,

        h(
          'div',
          { style: { display: 'block', marginBottom: '12px' } },
          h(MaskedRow, {
            label: 'API Key',
            value: keyValue,
            // The placeholder names the key that is configured, not the word
            // "已配置": "已配置" tells you something exists but not which one,
            // and this is the field where that question comes up.
            placeholder:
              backend.configured === true && typeof backend.masked === 'string'
                ? `${backend.masked}　留空则不改动`
                : '粘贴 Key',
            onChange: setKeyValue,
          }),
        ),

        supportsUrl
          ? h(
              'div',
              { style: { display: 'block', marginBottom: '12px' } },
              h(MaskedRow, {
                label: '服务地址（可选）',
                value: urlValue,
                placeholder: '留空则沿用当前配置',
                onChange: setUrlValue,
                masked: false,
              }),
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h(Button, {
            label: busy ? '保存中…' : '保存',
            primary: true,
            disabled: busy || !canSave || !installed,
            onClick: save,
          }),
          !installed
            ? h(
                'span',
                { style: { fontSize: '12px', lineHeight: 1.6, color: TOKENS.warn } },
                backend.missingReason === 'disabled'
                  ? '插件已安装但未启用，保存已停用。'
                  : '插件未安装，保存已停用。',
              )
            : null,
          notice === undefined
            ? null
            : h(
                'span',
                {
                  style: {
                    fontSize: '12px',
                    lineHeight: 1.6,
                    color: notice.tone === 'ok' ? TOKENS.ok : TOKENS.danger,
                  },
                },
                notice.text,
              ),
        ),

        h(PathLine, { path: backend.path }),
      )
    }

    /* ---- the page ---- */

    function MemoriesSettings() {
      const [backends, setBackends] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(undefined)

      const load = React.useCallback(() => {
        setLoading(true)
        getStatus()
          .then((payload) => {
            if (payload?.ok !== true) {
              setError(payload?.error ?? '无法读取当前配置')
              return
            }
            setError(undefined)
            setBackends(payload.backends ?? {})
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setLoading(false))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      /** Replace one backend's state after a save, so the badge updates. */
      const onSaved = (next) => {
        if (next === undefined) return
        setBackends((current) => (current === undefined ? current : { ...current, [next.id]: next }))
      }

      const order = ['openviking', 'hindsight', 'agentarts']

      return h(
        'div',
        { style: { maxWidth: '680px', color: TOKENS.text, fontSize: '13px', lineHeight: 1.65 } },
        h('h2', { style: { margin: '0 0 6px', fontSize: '17px', fontWeight: 600 } }, '记忆库'),
        h(
          'p',
          { style: { margin: '0 0 6px', fontSize: '12.5px', color: TOKENS.muted } },
          'DSH 里三个记忆后端的凭据，都在这一页配置。每个 Key 写进它自己的后端使用的那份存储，不复制、不改道——所以这里填完，对应插件立刻读到的是同一个值。',
        ),
        h(
          'p',
          { style: { margin: '0 0 20px', fontSize: '12px', color: TOKENS.muted } },
          'Key 只写不读：页面能显示「是否已配置」，但不会把值回显出来。',
        ),

        error === undefined
          ? null
          : h(
              'div',
              {
                style: {
                  marginBottom: '16px',
                  padding: '9px 12px',
                  fontSize: '12.5px',
                  borderRadius: '8px',
                  color: TOKENS.danger,
                  background: TOKENS.panel,
                  border: `1px solid ${TOKENS.border}`,
                },
              },
              error,
            ),

        loading && backends === undefined ? h('p', { style: { color: TOKENS.muted } }, '正在读取配置…') : null,

        backends === undefined
          ? null
          : order
              .filter((id) => backends[id] !== undefined)
              .map((id) => h(BackendSection, { key: id, backend: backends[id], onSaved })),

        h(
          'p',
          { style: { margin: '18px 0 0', fontSize: '12px', color: TOKENS.muted, lineHeight: 1.7 } },
          '华为 AgentArts 的 Key 存在 DSH 凭据库（',
          h('code', { style: { fontFamily: TOKENS.mono } }, '.credentials.yaml'),
          '）；Hindsight 写 ',
          h('code', { style: { fontFamily: TOKENS.mono } }, 'coding-agent.json'),
          ' 的 apiToken；OpenViking 写 ',
          h('code', { style: { fontFamily: TOKENS.mono } }, 'ovcli.conf'),
          ' 的 plugin 段。三处都只改本插件拥有的字段，其余设置原样保留。',
        ),
      )
    }

    /** Register the Settings page. */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: SECTION_LABEL,
          },
          (props) => h(MemoriesSettings, props),
        ),
      )
    }

    // Exposed for the render checks in `test/client.test.mjs`: the masked-field
    // contract is about what reaches the screen, so it is asserted against the
    // rendered tree rather than by reading this file.
    globalThis.__sections = { BackendSection, MaskedField, MemoriesSettings }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
