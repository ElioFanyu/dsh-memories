# dsh-memories（记忆库）

在一页里配置 DSH 里三个记忆后端的凭据。

装好之后，**设置 → 记忆库**（就在「内置插件」下面），按以下顺序列出三个后端：

1. **OpenViking 记忆**
2. **Hindsight 记忆**
3. **华为云 AgentArts 记忆库**

每个后端一个 Key 输入框、一个保存按钮。

## 插件未安装时会怎样

判断依据是**该插件是否真的在 Loader 里有一行启用中的行**，不是「包里有没有」——
一个躺在 `dependencies` 里的包是被装到磁盘上但不起作用的。

- 插件没安装 / 装在但未启用：区块标题旁显示「插件未安装」或「已安装未启用」，
  **保存按钮禁用**，旁边写明原因
- 服务端也会拒绝（HTTP 409），所以绕过界面也写不进去——
  给一个不会读取它的插件存 Key，看起来成功、实际永远不生效

检测**故意 fail-open**：Loader 读不到时一律当作已安装。
错误的「未安装」会挡住本来能用的配置（伤害更大），
而错误的「已安装」最多是存了个没人读的 Key，用户很快就发现没有效果。

> 实测踩过的坑：Loader 的 `entries()` 返回的是 **Map（可迭代对象）**，
> 不是数组。用 `Array.isArray` 判断会让每个包都被判成「已安装」——三栏全部显示正常，
> 而其中两个根本没装。现在会物化这个可迭代对象。

## 为什么需要它

三个记忆插件各自把 Key 存在完全不同的地方，而且**都没有配置界面**：

| 后端 | Key 存在哪 | 存的是什么 |
| --- | --- | --- |
| 华为 AgentArts | `<DSH_HOME>/.credentials.yaml`（DSH 凭据库） | `AGENTARTS_MEMORY_API_KEY` |
| Hindsight | `~/.hindsight/coding-agent.json` | `apiToken` |
| OpenViking | `~/.openviking/ovcli.conf` | `plugin.apiKey`（+ 顶层 `url`） |

要改一个 Key，原来得手工编辑三种不同格式的文件。这个插件把三处收进一页，
**并且写进各自真正被读取的位置**——它是一层前端，不是第二份副本。

## 设计取舍

**不镜像配置。** 每个 Key 只写进它的主人读取的那一处，没有缓存副本。
好处是两边永远不会出现「页面说已配置，插件读到的是空的」这种分裂。

**只改自己拥有的字段。** `coding-agent.json` 里还有几十个 Hindsight 设置，
`ovcli.conf` 里可能有其它 harness 的段（`plugin.claude.apiKey` 等）。
写入时只动 `apiToken` / `plugin.apiKey` / `url`，其余原样保留——
这一点有测试盯着，因为一个天真的「整体重写」会悄悄清掉用户配置。

**Key 只写不读。** 页面能显示「已配置 / 未配置」，但不会把值回显。
能被渲染出来的密钥，就会出现在截图、共享屏幕和 devtools 的网络面板里。

**写操作只接受本机回环地址。** 页面本身可能从别的机器可达。

**坏文件不覆盖。** 如果 `coding-agent.json` 或 `ovcli.conf` 不是合法 JSON，
保存会报错并保留原文件——用户还能手工修。

## 一次读写，不是两次

同时改 Key 和地址时，走一个 `writeBoth`：一次读、合并、一次写。
分成两次的话，第二次会从「第一次落盘之前」的快照开始，把第一次的改动丢掉。
这个 bug 在测试里抓到过一次（`openviking can set the service url on its own`）。

## 华为 AgentArts 插件的配置页去哪了

`@local/dsh-agentarts-memory` 原来自己有一个「AgentArts 记忆库」设置页。
现在它**没有设置页了**——Key、Space ID、Actor ID 都在这页的 AgentArts 区块里。

那个插件仍然保留 Host 半边（`agentarts_memory` 工具 + 回环路由），
所以能力没有减少，只是配置入口合并了。**同一个连接字段出现在两个表单里，
就是值悄悄回退的原因**，所以这里不做双入口。

## 配置项

插件自己的设置很少，因为它不存 Key：

| 字段 | 说明 |
| --- | --- |
| `hindsightConfigPath` | 覆盖 `~/.hindsight/coding-agent.json`；留空用默认 |
| `openvikingConfigPath` | 覆盖 `~/.openviking/ovcli.conf`；留空用默认 |
| `hindsightApiUrl` | 文档里没有 `apiUrl` 时写入的默认值 |

两个路径字段是给非默认安装用的（自定义 `HINDSIGHT_CONFIG`、共享的 OpenViking）。

## 路由

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-memories/status` | 三个后端的配置状态、文件路径、是否已安装、非敏感字段（含 AgentArts 的 Space/Actor） |
| `POST /dsh-memories/save` | 写一个后端的 Key / 地址 / Space；插件未安装时返回 409 |

两个都不返回密钥值。

## 已知限制

- 只配置凭据，不替代那三个插件本身的功能。
- 不校验 Key 是否有效：三个后端的鉴权方式和错误码都不同，各插件自己的日志更准确。
- `ovcli.conf` 里 `plugin.dsh.apiKey`（harness 专属写法）会被读取、但保存时只写
  `plugin.apiKey`，因为两者可能被有意设成不同值。
