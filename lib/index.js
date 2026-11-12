/**
 * Memory hub — Host half.
 *
 * Owns the loopback channel the settings page talks to. The page never touches
 * a file directly (a browser cannot), so every read and write of the three
 * backends' credentials passes through here, where the loopback gate lives.
 *
 * Routes:
 *
 *   GET  /dsh-memories/status   every backend's presence, path, and URL — no secret values
 *   POST /dsh-memories/save     one backend's key (and optional URL) into its own store
 *
 * Deliberately absent: any route that returns a key. A secret readable over
 * HTTP is readable in a screenshot, a shared window, and the devtools network
 * panel; "configured: true" is the whole answer the page needs.
 *
 * @module @local/dsh-memories
 */

import { BACKENDS, Config, ROUTE_PREFIX, detectInstalled, dshHome, ensureConfig, errorText, hindsightPath, isLoopback, openvikingPath, readJsonBody, sendJson } from './backends-entry.js'

/** Stable plugin name; must match the row inserted by `cordis.patch.yml`. */
export const name = 'dsh-memories'

/** Package name the Loader records for this row. */
const PACKAGE_NAME = '@local/dsh-memories'

export { Config, ROUTE_PREFIX }

/**
 * Display order.
 *
 * OpenViking → Hindsight → AgentArts, the order the user reads them in. This is
 * the ONE place the order is defined; the page renders whatever the Host
 * reports, in this sequence.
 */
export const BACKEND_IDS = ['openviking', 'hindsight', 'agentarts']

export function apply(ctx, config) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      /* logging must never break the plugin */
    }
  }

  // Repair the schema binding if this module was first evaluated while
  // `schemastery` was unresolvable.
  ensureConfig()

  /**
   * Say where each backend's document lives, honouring the configured
   * overrides. The page shows these paths so "I saved it" can be checked
   * against a real file instead of trusted.
   */
  const paths = () => ({
    agentarts: `${dshHome()}/.credentials.yaml`,
    hindsight: text(config, 'hindsightConfigPath') || hindsightPath(),
    openviking: text(config, 'openvikingConfigPath') || openvikingPath(),
  })

  /**
   * Mount the routes once `webServer` exists.
   *
   * A synchronous `ctx.get('webServer')` in `apply` reads `undefined` whenever
   * this row activates before the web carrier; the route then silently never
   * exists and every page button posts into the SPA fallback (HTTP 405).
   * `ctx.inject` waits for the service instead.
   */
  const registerLater = (services, label, run) => {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(services, () => {
          try {
            const disposer = run()
            if (disposer !== undefined) ctx.effect(() => disposer, label)
          } catch (error) {
            ctx.logger?.error?.(error)
          }
        })
        return
      }
    } catch (error) {
      ctx.logger?.error?.(error)
    }
    try {
      const disposer = run()
      if (disposer !== undefined) ctx.effect(() => disposer, label)
    } catch (error) {
      ctx.logger?.error?.(error)
    }
  }

  registerLater(['webServer'], 'dsh-memories: settings route', () => {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log('dsh-memories: 当前部署没有 webServer，设置页通道不可用')
      return undefined
    }

    /** Collect every backend's current state, never its secret. */
    const describeAll = async () => {
      const where = paths()
      const result = {}
      for (const id of BACKEND_IDS) {
        const backend = BACKENDS[id]
        let state
        try {
          state = await backend.describe(ctx)
        } catch (error) {
          state = { configured: false, writable: false, detail: errorText(error) }
        }
        // Row-backed fields (AgentArts' space id, actor, endpoint) are read
        // separately, because they are configuration rather than a credential.
        let rows
        if (typeof backend.describeRows === 'function') {
          try {
            rows = await backend.describeRows(ctx)
          } catch {
            rows = undefined
          }
        }
        // A backend whose address lives in its row reports it as `url` too, so
        // the page seeds one field the same way for all three backends. Getting
        // this wrong is not cosmetic: the address input would start empty and
        // saving anything else would clear the stored endpoint.
        const rowUrl =
          backend.urlField?.where === 'row' && rows !== undefined && typeof rows.baseUrl === 'string'
            ? rows.baseUrl
            : undefined
        const installed = detectInstalled(ctx, id)
        result[id] = {
          id,
          title: backend.title,
          hint: backend.hint,
          path: state.path ?? where[id],
          configured: state.configured === true,
          writable: state.writable !== false,
          // Whether the owning plugin is actually live. A key saved for a
          // plugin that is not installed would never be read by anything.
          installed: installed.installed === true,
          ...(installed.installed === true ? {} : { missingReason: installed.reason }),
          ...(state.detail === undefined ? {} : { detail: state.detail }),
          ...(state.masked === undefined ? {} : { masked: state.masked }),
          ...(state.mask === undefined ? {} : { mask: state.mask }),
          ...(state.url === undefined ? {} : { url: state.url }),
          ...(rowUrl === undefined ? {} : { url: rowUrl }),
          ...(backend.urlField === undefined ? {} : { urlField: backend.urlField }),
          ...(state.account === undefined ? {} : { account: state.account }),
          ...(state.user === undefined ? {} : { user: state.user }),
          ...(rows === undefined ? {} : { rows }),
        }
      }
      return result
    }

    return webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET' && action === 'status') {
            sendJson(res, 200, { ok: true, backends: await describeAll() })
            return
          }

          // Reads may come from wherever the page is reachable; writes may not.
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '方法不允许' })
            return
          }
          if (!isLoopback(req.socket?.remoteAddress)) {
            sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
            return
          }

          if (action === 'save') {
            const body = await readJsonBody(req)
            const id = typeof body.target === 'string' ? body.target : ''
            const backend = BACKENDS[id]
            if (backend === undefined) {
              sendJson(res, 400, { ok: false, error: `未知的记忆后端：${id === '' ? '(空)' : id}` })
              return
            }

            // Refuse a write for a plugin that is not installed: saving a key
            // for it would look successful and be read by nothing.
            const installed = detectInstalled(ctx, id)
            if (installed.installed !== true) {
              sendJson(res, 409, {
                ok: false,
                error:
                  installed.reason === 'disabled'
                    ? `${backend.title} 的插件已安装但未启用，先启用它再配置。`
                    : `${backend.title} 的插件未安装，先安装它再配置。`,
                missing: true,
              })
              return
            }
            const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
            const serviceUrl = typeof body.url === 'string' ? body.url.trim() : ''
            // Where this backend's address lives decides how it is written:
            // a file-backed backend takes it through `writeBoth`, while a
            // row-backed one (AgentArts) passes it into `writeRows` as
            // `baseUrl` and gets it validated against that plugin's schema.
            const addressInRow = backend.urlField?.where === 'row'
            // Row-backed connection fields (AgentArts only, for now).
            const rowFields = {}
            if (typeof body.spaceId === 'string') rowFields.spaceId = body.spaceId.trim()
            if (typeof body.actorId === 'string') rowFields.actorId = body.actorId.trim()
            if (addressInRow && serviceUrl !== '') rowFields.baseUrl = serviceUrl
            const wantsRows = Object.keys(rowFields).length > 0 && typeof backend.writeRows === 'function'
            const fileUrl = addressInRow ? '' : serviceUrl
            if (key === '' && fileUrl === '' && !wantsRows) {
              sendJson(res, 400, { ok: false, error: '没有要保存的内容（Key、地址、Space 都是空的）' })
              return
            }

            const done = []
            const address = serviceUrl === '' ? undefined : serviceUrl
            // A service address that is not an http(s) URL is a typo, and a
            // typo written into a backend's config looks saved but breaks every
            // request. Refuse it while it is still on screen.
            if (address !== undefined && !/^https?:\/\/\S+$/i.test(address)) {
              sendJson(res, 400, {
                ok: false,
                error: '服务地址需要以 http:// 或 https:// 开头，比如 https://api.example.com。',
              })
              return
            }
            const keyPart = key === '' ? undefined : key
            // What the address was BEFORE the write, so the confirmation can
            // tell "changed it" from "it was already that". Without this, every
            // save reports a write to the address even when nothing moved.
            const urlBefore =
              typeof backend.describe === 'function' ? (await backend.describe(ctx))?.url : undefined
            const urlPart = addressInRow || address === undefined ? undefined : address
            if (keyPart !== undefined || urlPart !== undefined) {
              if (typeof backend.writeBoth === 'function') {
                // One read-modify-write keeps both changes; two writes would
                // each re-read and the second would drop the first.
                await backend.writeBoth(ctx, { apiKey: keyPart, url: urlPart })
                if (keyPart !== undefined) done.push('Key')
                // "Wrote the address" is only true if it now differs from what
                // was there. Saving the same URL twice should say so, not claim a
                // second write.
                if (urlPart !== undefined && urlPart !== urlBefore) done.push('地址')
              } else if (keyPart !== undefined && typeof backend.write === 'function') {
                await backend.write(ctx, keyPart)
                done.push('Key')
                if (urlPart !== undefined) {
                  sendJson(res, 400, {
                    ok: false,
                    error: `${backend.title} 不支持设置服务地址（Key 已保存）`,
                  })
                  return
                }
              } else if (urlPart !== undefined && typeof backend.writeUrl === 'function') {
                await backend.writeUrl(ctx, urlPart)
                if (urlPart !== urlBefore) done.push('地址')
              } else if (!wantsRows) {
                sendJson(res, 400, { ok: false, error: `${backend.title} 不支持这种保存` })
                return
              }
            }

            if (wantsRows) {
              // Compare before and after so the confirmation names what this
              // save actually changed. The page always sends every row field,
              // so reporting "wrote Space ID and Actor ID" on an address-only
              // save would be technically true and practically noise.
              const before = typeof backend.describeRows === 'function' ? await backend.describeRows(ctx) : undefined
              await backend.writeRows(ctx, rowFields)
              const changed = (name, key) =>
                rowFields[key] !== undefined && (before === undefined || before[key] !== rowFields[key])
              if (changed('Space ID', 'spaceId')) done.push('Space ID')
              if (changed('Actor ID', 'actorId')) done.push('Actor ID')
              if (changed('服务地址', 'baseUrl')) done.push('服务地址')
            }
            // Report the state after the write, so the page shows reality.
            const after = (await describeAll())[id]
            sendJson(res, 200, {
              ok: true,
              saved: done,
              backend: after,
              // Name what changed, and — for a key — say WHICH key is now stored.
              // "已写入 … 的 Key。" is a claim; "已写入 … 的 Key（sk-99 开头，共
              // 35 位）。" is something the reader can check against the panel of
              // the service they just opened.
              message:
                done.length === 0
                  ? `${backend.title} 的配置没有变化。`
                  : `已写入 ${backend.title} 的 ${done
                      .map((name) => (name === 'Key' && after.masked !== undefined ? `Key（${after.mask === undefined ? after.masked : `${after.mask.prefix} 开头，共 ${after.mask.length} 位`}）` : name))
                      .join(' 和 ')}。`,
            })
            return
          }

          sendJson(res, 404, { ok: false, error: `未知操作：${action}` })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    })
  })

  log(`dsh-memories: 记忆库配置页已挂载在 ${ROUTE_PREFIX}`)
}

/** Read a trimmed string from the config row. */
function text(config, key) {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim() : ''
}
