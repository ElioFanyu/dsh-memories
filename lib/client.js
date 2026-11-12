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
     * A run of dots standing in for a stored secret.
     *
     * These are the asterisks the field shows after a save. They live in the
     * `placeholder`, not in `value`, which is the whole reason they are safe:
     * a placeholder is not form data, so copying the field yields nothing, and
     * the first keystroke replaces them instead of being appended to them.
     *
     * The real key is not in the page until 显示 is pressed. That keeps the
     * common case (open the page, see that a key exists) free of any secret in
     * the DOM, while still making the secret viewable on demand.
     */
    function dotPlaceholder(length) {
      const count = typeof length === 'number' && length > 0 ? Math.min(length, 40) : 16
      return '•'.repeat(Math.max(8, count))
    }

    /**
     * Paint the dot placeholder in body-text colour.
     *
     * A browser renders `::placeholder` in pale grey, which is right for
     * "请输入…" but reads as disabled for a run of dots that is meant to say
     * "a key is stored". `::placeholder` cannot be styled inline, so one rule
     * is injected once.
     */
    function installDotStyle() {
      if (typeof document === 'undefined' || document === null) return
      const id = 'dsh-memories-dots'
      if (typeof document.getElementById === 'function' && document.getElementById(id) !== null) return
      try {
        const style = document.createElement('style')
        style.id = id
        style.textContent =
          '.dsh-memories-dots::placeholder{color:var(--dsw-alias-text-primary,rgba(28,28,30,1));opacity:1;letter-spacing:0.12em;}'
        document.head.appendChild(style)
      } catch {
        /* a document that refuses a style tag is not worth failing over */
      }
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

    /**
     * Ask the Host for one backend's stored key.
     *
     * A POST because a GET can be fired by an <img src> or a link prefetch, and
     * a secret must not come back from something the page did not deliberately
     * request. This is the only call the page makes that returns a usable
     * credential, and it happens on exactly one event: the 显示 button.
     */
    const revealKey = (target) =>
      callRoute('reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      })

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
        // Only the dot placeholder needs a class; every other field keeps the
        // browser's default placeholder colour.
        ...(props.className === undefined ? {} : { className: props.className }),
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
     *
     * `onReveal` is how a stored-but-unshown secret is fetched. The page never
     * receives a stored key with the status payload: pressing 显示 asks the Host
     * for it then and there, so the value exists in the browser only while the
     * user is looking at it.
     *
     * `invalid` paints the border in the danger colour. Validation happens on
     * save, so the field has to be able to show that it is the one being
     * complained about.
     */
    function MaskedField(props) {
      const [shown, setShown] = React.useState(false)
      const [revealed, setRevealed] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)

      // A new stored value (a save, or a switch of backend) invalidates whatever
      // was fetched before; otherwise pressing 显示 twice would keep showing a
      // key that is no longer the one on disk.
      React.useEffect(() => {
        setRevealed(undefined)
      }, [props.revealKey])

      const typed = props.value !== undefined && props.value !== ''
      // What the input actually displays: what the user typed, else whatever was
      // fetched by 显示. The stored secret never arrives any other way.
      const display = typed ? props.value : revealed ?? ''

      const toggle = async () => {
        if (shown) {
          setShown(false)
          // Drop the fetched secret again. Keeping it in state would leave a
          // usable credential sitting in the page after the user hid it.
          setRevealed(undefined)
          return
        }
        if (!typed && revealed === undefined && typeof props.onReveal === 'function') {
          setBusy(true)
          setError(undefined)
          try {
            const payload = await props.onReveal()
            if (payload?.ok !== true) {
              setError(payload?.error ?? '读取失败')
              return
            }
            setRevealed(String(payload.value ?? ''))
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
            return
          } finally {
            setBusy(false)
          }
        }
        setShown(true)
      }

      return h(
        'div',
        { style: { position: 'relative' } },
        h(TextInput, {
          type: shown ? 'text' : 'password',
          value: display,
          // Dots only while the box is untouched and something IS stored. Once
          // the user types, their own characters take over; once 显示 succeeds,
          // the real value does. Otherwise fall back to the plain instruction.
          placeholder: props.dotPlaceholder ?? props.placeholder,
          onChange: props.onChange,
          className: props.dotPlaceholder === undefined ? undefined : 'dsh-memories-dots',
          style: {
            paddingRight: '58px',
            ...(props.invalid === true ? { borderColor: TOKENS.danger } : {}),
          },
        }),
        h(
          'button',
          {
            type: 'button',
            // A toggle is a view control: it must not submit anything or take
            // focus away from the field being edited.
            onMouseDown: (event) => event.preventDefault(),
            onClick: toggle,
            disabled: busy,
            title: busy ? '正在读取…' : shown ? '隐藏内容' : '显示内容',
            'aria-label': busy ? '正在读取' : shown ? '隐藏内容' : '显示内容',
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
              cursor: busy ? 'progress' : 'pointer',
              fontFamily: 'inherit',
            },
          },
          busy ? '读取中' : shown ? '隐藏' : '显示',
        ),
        error === undefined
          ? null
          : h(
              'span',
              {
                style: { display: 'block', marginTop: '5px', fontSize: '11.5px', color: TOKENS.danger, lineHeight: 1.6 },
              },
              error,
            ),
      )
    }

    /**
     * A titled field: caption above, control below.
     *
     * `masked` is opt-in. A service URL is not a secret — hiding it made the
     * page show a row of dots for a value the user needs to read and verify,
     * which is the opposite of helpful. Only credentials are masked.
     *
     * `hint` is the small line under the control. It carries the facts that do
     * not belong in a placeholder ("this key is already set", "this address is
     * optional"): a placeholder is a description of what to type, and filling
     * it with status text makes the field look pre-filled and unfinished at the
     * same time.
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
              // `dotPlaceholder` present means "a key is stored and not typed
              // over" — the field shows dots instead of an empty box.
              placeholder: props.placeholder,
              dotPlaceholder:
                props.dotPlaceholder === undefined ? undefined : dotPlaceholder(props.dotPlaceholder.length),
              onChange: props.onChange,
              invalid: props.invalid,
              onReveal: props.onReveal,
              revealKey: props.revealKey,
            })
          : h(TextInput, {
              value: props.value,
              placeholder: props.placeholder,
              onChange: props.onChange,
              style: props.invalid === true ? { borderColor: TOKENS.danger } : undefined,
            }),
        props.hint === undefined
          ? null
          : h(
              'span',
              {
                style: {
                  display: 'block',
                  marginTop: '5px',
                  fontSize: '11.5px',
                  lineHeight: 1.6,
                  color: props.hintTone === 'error' ? TOKENS.danger : TOKENS.muted,
                },
              },
              props.hint,
            ),
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
     * How to describe a stored key in words.
     *
     * A pill reading `hsk_f…（53 位）` looks like a truncated value rather than
     * a status: it sits where a label should be and reads as though the page is
     * showing you the key. The badge therefore says `已保存 API Key` (a state),
     * and the identifying facts move into the sentence under the field, where
     * they answer the reader's actual question — "is this the key I rotated?"
     */
    const KEY_BADGE = '已保存 API Key'

    /** `hsk_f 开头，共 53 位` — or `已保存` when the Host reported no shape. */
    function keyFacts(backend) {
      const mask = backend.mask
      if (mask !== undefined && typeof mask.prefix === 'string' && typeof mask.length === 'number') {
        return `${mask.prefix} 开头，共 ${mask.length} 位`
      }
      return '已保存'
    }

    /** The sentence under the key field: state, not instruction. */
    function keyHint(backend) {
      if (backend.installed === false) {
        return backend.missingReason === 'disabled'
          ? '对应插件已安装但未启用，启用后才能保存。'
          : '对应插件尚未安装，安装并启用后才能保存。'
      }
      if (backend.configured === true) {
        return `当前已保存 API Key（${keyFacts(backend)}）。点「显示」可以查看完整内容；留空则保持不变，填写新的会覆盖旧的。`
      }
      return '尚未保存 API Key。填入后点「保存」即可生效。'
    }

    /**
     * What to say after a successful save.
     *
     * The box is empty again, so the sentence has to tell the reader how to get
     * the value back — otherwise "saved" looks like "disappeared", which is the
     * exact confusion this page has already caused once.
     */
    function successText(payload) {
      const saved = Array.isArray(payload?.saved) ? payload.saved : []
      const base = typeof payload?.message === 'string' ? payload.message : '已保存。'
      if (!saved.includes('Key')) return base
      return `${base}Key 默认掩码显示，点「显示」可查看完整内容。`
    }

    /**
     * The line under the service-address field.
     *
     * It says what the field is currently doing, not just what to type: a blank
     * address is a valid choice for the public regions and a broken one for a
     * private deployment, and the two are indistinguishable without a sentence.
     */
    function urlHint(backend, value) {
      const typed = typeof value === 'string' && value.trim() !== ''
      if (typed) return '保存后立即生效。'
      // A stored address wins over the default-address sentence: an AgentArts
      // deployment on a private endpoint whose hint still promised
      // "留空则用华为云默认地址" would be describing a state that is not the
      // current one, and the reader would have no way to tell.
      if (typeof backend.url === 'string' && backend.url.trim() !== '') {
        return `当前为 ${backend.url}，留空则保持不变。`
      }
      if (backend.urlField?.where === 'row') {
        return '目前留空，将按区域使用华为云默认地址（memory.<区域>.huaweicloud-agentarts.com）。私有网络部署需填写数据面地址。'
      }
      return '尚未设置服务地址，将使用插件自带的默认地址。'
    }

    /**
     * The result of the last save, as a strip under the button.
     *
     * `notice` used to be a 12px sentence squeezed to the right of the save
     * button, and the field it described had just been emptied on purpose —
     * so "saved" and "nothing happened" looked identical. A successful save is
     * now a bordered line that says what was written and confirms the key is
     * cleared from the form on purpose.
     */
    function Notice(props) {
      const ok = props.tone === 'ok'
      return h(
        'div',
        {
          role: 'status',
          style: {
            display: 'block',
            marginTop: '10px',
            padding: '8px 11px',
            fontSize: '12.5px',
            lineHeight: 1.65,
            borderRadius: '7px',
            color: ok ? TOKENS.ok : TOKENS.danger,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.panel,
          },
        },
        props.text,
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
      /**
       * How this section fetches a stored secret.
       *
       * Defaults to the real route; a test injects its own. This is the one
       * place the page reaches for a usable credential, so it is kept as a
       * single seam rather than spread through the render function.
       */
      const fetchKey = props.revealKey ?? revealKey
      const [keyValue, setKeyValue] = React.useState('')
      const [urlValue, setUrlValue] = React.useState('')
      const [urlInvalid, setUrlInvalid] = React.useState(false)
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
      // Where the address lives decides whether this section shows the field at
      // all and how the Host will store it. A backend that declares no address
      // field is one whose endpoint is not configurable from here.
      const urlField = backend.urlField
      const supportsUrl = urlField !== undefined
      // A key saved for a plugin that is not installed would be read by nothing,
      // so the save control is disabled rather than letting the write look
      // successful. The Host refuses it too; this is the visible half.
      const installed = backend.installed !== false

      const save = async () => {
        // Validate the address before the request: the Host refuses a
        // non-http(s) address too, but a round trip to learn that a field is
        // malformed is a worse experience than the field saying so itself.
        const typedUrl = urlValue.trim()
        if (supportsUrl && typedUrl !== '' && !/^https?:\/\/\S+$/i.test(typedUrl)) {
          setUrlInvalid(true)
          setNotice({ tone: 'error', text: '服务地址需要以 http:// 或 https:// 开头。' })
          return
        }
        setUrlInvalid(false)
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
          // The confirmation has to SAY so — an emptied box with no explanation
          // is indistinguishable from a save that failed and cleared itself.
          setKeyValue('')
          setNotice({ tone: 'ok', text: successText(payload) })
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
            : backend.configured === true
              ? h(Badge, { label: KEY_BADGE, tone: 'ok' })
              : h(Badge, { label: '未配置', tone: 'warn' }),
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
                placeholder: '请输入 Space ID（形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）',
                onChange: setSpaceValue,
                hint: '控制台记忆库详情页地址栏里的 id 参数。',
                style: { flex: '1 1 240px' },
              }),
              h(MaskedRow, {
                label: 'Actor ID（可选）',
                value: actorValue,
                placeholder: '请输入 Actor ID；留空表示不按 actor 过滤',
                onChange: setActorValue,
                hint: '要与写入记忆那一侧的 Actor ID 一致，否则检索不到。',
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
            // Empty and unconfigured reads as an instruction; empty and
            // configured reads as "press 显示 to see it". Both states look the
            // same inside the box (it is empty either way), so the sentence
            // below is what actually distinguishes them.
            placeholder: '请输入 API Key',
            onChange: setKeyValue,
            hint: keyHint(backend),
            // 显示 on a configured key fetches it from the Host at that moment.
            // Nothing stored means nothing to fetch, and the button stays a
            // plain show/hide for whatever is typed.
            ...(backend.configured === true
              ? {
                  dotPlaceholder: { length: typeof backend.mask?.length === 'number' ? backend.mask.length : undefined },
                  onReveal: () => fetchKey(backend.id),
                  revealKey: `${backend.id}:${backend.masked ?? ''}`,
                }
              : {}),
          }),
        ),

        supportsUrl
          ? h(
              'div',
              { style: { display: 'block', marginBottom: '12px' } },
              h(MaskedRow, {
                label: urlField.label ?? '服务地址（可选）',
                value: urlValue,
                placeholder: urlField.placeholder ?? '请输入服务地址',
                onChange: (next) => {
                  setUrlValue(next)
                  setUrlInvalid(false)
                },
                // An address is not a secret: it is read, verified and copied.
                masked: false,
                invalid: urlInvalid,
                hint: urlInvalid
                  ? '地址需要以 http:// 或 https:// 开头。'
                  : urlHint(backend, urlValue),
                hintTone: urlInvalid ? 'error' : undefined,
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
        ),

        // Below the button, not beside it: the outcome of a click belongs on its
        // own line, where it is read as a result rather than as a caption.
        notice === undefined ? null : h(Notice, { tone: notice.tone, text: notice.text }),

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
          'DSH 里三个记忆后端的凭据都在这一页配置。每个 Key 写入它所属插件真正读取的那份存储，不复制、不改道——这里填完，对应插件立刻读到同一个值。',
        ),
        h(
          'p',
          { style: { margin: '0 0 20px', fontSize: '12px', color: TOKENS.muted } },
          'Key 只写不读：页面能显示已保存的是哪一把（前缀与长度），不会回显完整内容。服务地址可填可不填，留空使用插件自带的默认地址；自建或私有网络部署请填写实际地址。',
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
      installDotStyle()
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
    globalThis.__sections = { BackendSection, MaskedField, MemoriesSettings, successText, dotPlaceholder }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
