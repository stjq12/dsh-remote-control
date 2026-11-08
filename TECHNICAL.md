# dsh-remote-control 技术说明

本文件记录插件的实现原理、已验证的能力边界，以及**尚未解决的部分及其根因**。
目的是让后来的人（或未来的我）不必重新摸索一遍。

---

## 一、整体架构

插件把「本窗口的 DSH 页面」接到「另一台电脑上运行的 DSH」。
两台机器的装置是**同一个插件**，只是角色不同：

| 角色 | 术语 | 做什么 |
|---|---|---|
| **提供方** | B 侧 / 「本机」页 | 启动 `ws://<addr>:<port>/bridge`，把本机 DSH 的 RPC 和事件暴露出去 |
| **使用方** | A 侧 / 「远程」页 | 劫持本窗口页面的 `/api` 与 `$events`，改从对端取数据 |

```
浏览器页面
   │  /api/remote-control/api/*   ← 页面钩子改写（Web 用 tapIndex，桌面用 index-inject）
   ▼
A 侧插件（使用方）
   ├── RPC  ──── bridge WS ────> B 侧插件（提供方）──> 对端 DSH
   ├── stream ── bridge WS ────> 同上
   └── $events 流 ──> 本机 mux ＋ 手工注入对端事件
```

> **传输安全**：bridge 是明文 `ws://`，token 与 owner 级 RPC 都会在链路上以明文出现。只应在 Tailscale、SSH 隧道等已加密链路中使用；不要直接暴露到不可信局域网或公网。

**关键约束**：对端的 7400 端口**只有 bridge 的 WebSocket**，没有 HTTP `/api`。
所以页面无法直连对端，所有数据都必须经 bridge 中转。

---

## 二、已验证能力的对照表

DSH 的页面通过四条通道与服务端交互。原生与本插件的覆盖情况：

| 通道 | 方向 | DSH 原生 | 本插件 | 状态 |
|---|---|---|---|---|
| **RPC** | 页面 → 服务端 | 135 个端点（0.2.1-rc.5） | 135（参数适配 + 直通） | ✅ 完整 |
| **stream** | 服务端 → 页面 | `session/follow` 等 | 已转发 | ✅ 完整 |
| **emit** | 服务端 → 页面广播 | 26 个 | 26（`ctx.on` 监听后转发） | ✅ 完整 |
| **waterfall** | 双向（需应答） | 2 个 | 2 个 | ✅ 完整（单端弹窗） |

---

## 保存语义

`save` 只写记录，不 bind、不移动 live listener/proxy、不切换开关。地址字段沿用同一套校验：只要地址栏已有红框或当前值不合法，就不能保存；令牌不参与保存校验，空令牌也可以保存（点开关时才要求令牌）。保存后由开关负责真正应用。

## 本机绑定校验

- 地址必须是本机已有的 IPv4/IPv6 字面量；`0.0.0.0`/`::`、主机名和非法 IP 在点开关前由客户端拦下，服务端仍做同样校验。
- 端口必须是 1024–65535。开关只尝试请求的端口，被占用时返回 `EADDRINUSE`，不再向上扫描；地址栏和说明行会变红。
- 绑定失败（`EADDRNOTAVAIL`、`EADDRINUSE`）不会覆盖当前 preset；只有 bind 成功后才提交 host/port/token。

## 预设与开关

选择预设是纯记录编辑：只更新 `activeId` 并把该预设的 IP/令牌返回给表单，**不重配 listener/proxy，也不切换开关**。真正应用发生在点开关（toggle）时；保存/轮换等显式动作仍按各自语义处理。这样 `select` 不会触发持久化回调，避免把新预设的令牌写进旧预设。

## 三、为什么 RPC 需要参数适配

页面发出的 HTTP body 是**扁平**的，而对端 Gateway 的 descriptor 要求**嵌套**。
原生模式下这一步由 DSH 自己的 `/api` 层完成；远程模式下那一层在我们的机器上，
所以本插件必须自己补上。

```js
// 页面发
{ sessionId: 'abc', mode: 'queue', content: [...] }

// descriptor 要求
{ request: { sessionId: 'abc', mode: 'queue', content: [...] } }
```

`SPECIAL_ARGS` 就是这张表。25 个需要适配，119 个结构天然一致。

**适配依据全部来自 DSH 的 descriptor 定义**（`SessionPromptRequest` 等），不是猜测。

---

## 四、waterfall 事件的接收（已解决）

### 现象（修复前）

| 场景 | 修复前结果 |
|---|---|
| 权限确认框（`approval/request`） | 远程看不到（修复后改为单端远程弹窗） |
| AI 提问（`user-questions/request`） | 远程看不到（修复后同上） |
| 其他（对话、列表、停止按钮、emit） | ✅ 正常 |

### 诊断过程与证据

**① B 侧监听器注册成功**

被控端日志：

```
question listener registered=true    ← 三次重启，每次都有
（无 question raised）                ← 提问时事件从未到达
```

**② 本机模拟全部通过**

用真实的 `ctx.waterfall` 派发语义测试，7 个选项 + 自定义输入的场景完整闭环：

```
B 侧推送: ✅ / agentId: session-real-1 / 选项数: 7
页面应答 → ctx.waterfall 返回: {"answers":[{"id":"q1","selected":["选题C"]}]}
```

**③ 根因：这两个事件是 agent-scoped**

DSH 定义：

```ts
'user-questions/request'(this: Scoped<Agent>, request, next): Promise<AskUserQuestionAnswer>
```

派发代码：

```js
this.ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...}, noAnswerer)
```

`scopeTarget` 构造的 `Context.filter` 会按 Agent 作用域过滤监听器。
**我们的插件注册在根 ctx 上，因此被拦下。**

**④ DSH 自己也不在 Host 侧监听**

```js
ctx.remote.$on("user-questions/request", function (request, next) { ... })
```

DSH 的提问 UI 是**页面侧（Client）**通过 `$on` 接收的，走的是对端自己的 `$events` 流。

**这就是关键差异**：

```
对端页面   → 连对端的 $events 流 → 收到提问 ✅
远程页面   → 连本机的 $events 流 → 收不到 ❌
```

### 已排除的方案

**方案 A：抢 `registerRemoteEvents`**

```js
registerRemoteEvents(source, host) {
  if (this.remoteEvents !== void 0) {
    throw new Error("...is already registered")
  }
}
```

`typertGateway` 只允许**一个**事件源注册，DSH 自己已占用。
**抢过来会让本机端（对端自己的页面）失效**——拆东墙补西墙，不可接受。

**方案 B：远程页面直连对端 `$events`**

对端 7400 端口只有 bridge WS，没有 HTTP `/api`，页面无法直接连接。

**方案 C：`ctx.on` 抓 waterfall**

已验证失败（就是当前状态）。

### 最终解法

**① 注册必须带 `{ prepend: true }`**

这两个事件是 agent-scoped，普通注册收不到；`prepend` 同时让我们排在本机 UI 的监听器之前。

**② 帧必须带 `wait: { callId, timed }`**

DSH 页面只在 `request.wait.timed === true` 时进入 claim 分支，而**只有 claim 分支会 `card.remove()`**。
缺这个字段，卡片在提交后不会消失。

**③ 必须适配 `userQuestions/attachWait`**

页面开一个流维持「等待中」：`attachWait(sessionId, callId, signal)`，而 descriptor 要求
`{ agentId, callId }`（`agent` 是 lookup，wire 名 `agentId`）。字段名不对则调用失败，claim 无法释放。

**④ 只能单端弹窗**

DSH 是「一次性 waterfall」：一端应答后，另一端的 `next()` 永远不会返回，它的卡片也不会消失。
两端的 UI 都不受我们控制，无法从外部关闭。
移动设备能做到双端，是因为它自带手机端 UI，可以广播 `question-resolved`——我们两端都是 DSH 页面，做不到。

所以：**有远程连接时只弹远程；没有连接时弹本机。**

### 曾考虑但放弃的下一步

- **路子 1**：找到「在 Agent 作用域内注册监听器」的公开 API。
  线索：`ctx.sessions.scopeOf(owner)`、`ctx.agents.withInitiator(agent, ...)`、`agentScope()`。
  **这些都是 DSH 内部符号，插件能否调用未经验证。**

- **路子 2**：让 B 侧新增一个 HTTP `/api` 代理，远程页面直连。
  需要在对端另开端口 + 处理认证，架构改动较大。

- **路子 3**：接受现状。远程模式下看不到确认框和提问框，其余功能完整。

---

## 五、连接失败的回退

桥不可达时（对端休眠、重启、网络断开），代理**第一次失败就回退到本机 Host**，窗口继续可用，不再卡在重连里。

```
第一次桥失败 → 响应带 `x-remote-control-failure` → 页面 hook 切回本机并 reload；插件不会在后台静默把业务请求改到本机
任一次成功   → bridgeFailures = 0 → 恢复走桥
```

卡片可通过 `snapshot().fallback` 读到是否处于回退状态。

---

## 六、卸载行为

插件停用（`ctx.effect` 的 dispose）时会：

1. 取消所有事件监听器
2. 把未决的确认解析为 `cancelled`、提问解析为 `{ answers: [] }`；最后一个控制端断开后还有 10 秒重连宽限，而不是一直等 5 分钟
3. 清空 `statusSinks` / `approvalSinks`
4. **销毁所有已建立的 WebSocket 连接**（`liveSockets`）
5. 关闭监听端口（`listener.close()`）

第 4 步是必需的：关闭 HTTP 服务只阻止新连接，已建立的 socket 会继续存活并收到一个已不存在插件的推送。

---

## 七、已知的其他限制

| 限制 | 原因 |
|---|---|
| 远程上传文件不可用 | 桌面端上传走 XHR + 文件路径，字节不经过桥；移动设备插件用的是自己实现的分块上传，未移植 |
| 刷新令牌 | 旧 token 立即失效，已连接的客户端会被断开；无需重启 Host |
| 多控制端不过滤 | 重放的审批会推给所有连接（单控制端场景无影响） |

---

## 八、诊断日志

诊断日志默认关闭；设置 `DSH_REMOTE_CONTROL_TRACE=1` 后才写入 `~/.dsh/remote-control-trace.log`（不可写时退回系统临时目录），权限 0600。插件代码不保留测试用 `console` 输出；`ctx.logger` 的启动/生命周期信息也只在 trace 模式下输出，正常启动不写日志或诊断文件。

常用检索：

```bash
grep -E "plugin loaded"        ~/.dsh/remote-control-trace.log   # 版本确认
grep -E "question|approval"    ~/.dsh/remote-control-trace.log   # 交互事件
grep -E "emit "                ~/.dsh/remote-control-trace.log   # 广播事件
grep -E "relay failed"         ~/.dsh/remote-control-trace.log   # RPC 失败
grep -E "inject"               ~/.dsh/remote-control-trace.log   # 注入页面
```

**关键日志含义**

### 服务端（跑 DSH 的那台）

| 日志 | 含义 |
|---|---|
| `question listener registered=true` | 监听注册成功（每次插件加载一行） |
| `question hook fired` | Cordis 把事件交给了我们（过滤已放行） |
| `question raised sinks=N agent=yes/no questions=N` | 事件到达，附带连接数与问题数 |
| `question skipped: <原因>` | 我们的守卫拒绝了转发（无连接 / 缺 agent.id / 空问题） |
| `question forwarded <id> sinks=N` | 已推给远程端 |
| `question answered <id> -> N answer(s)` | 收到远程端的应答 |
| `replay N pending: <id,...> sinks=N` | **新连接触发了重放**（同一 id 会被再推一次） |
| `connection registered / released sinks=N` | 连接增删；两者数量应相等 |
| `approval raised / forwarded / answered` | 权限确认的同一套日志 |

### 远程端（显示的那台）

| 日志 | 含义 |
|---|---|
| `frame kind=event event=<名称>` | 收到服务端推送 |
| `inject-waterfall {...}` | 已注入页面的提问/确认卡片 |
| `inject-waterfall skipped (already delivered) <id>` | **去重生效**（重放没有产生第二张卡片） |
| `inject-emit {...}` | 已注入广播事件 |
| `inject delivered to <streamId>` | 确认写进了页面流 |
| `inject dropped: stream gone` | 页面流已关闭，丢弃 |
| `inject write failed: <原因>` | 写入失败 |

### 排查「选项框不消失」

1. 服务端有 `answered` → 应答到了；问题在页面卡片状态
2. 服务端只有 `forwarded` 没有 `answered` → 应答没回来，查远程端的 `$events/result`
3. 远程端有 `inject-waterfall` 两次同一 id → 去重失效（应看到 `skipped` 而不是第二次 `inject`）

---

## 九、关键实现细节

### 页面钩子（两平台差异）

```js
// Web：DSH 渲染 index.html 时插入
server.tapIndex((html) => html.replace(/<head([^>]*)>/i, `<head$1>${tag}`))

// 桌面：Electron 从磁盘读 index.html，tapIndex 不会被调用
ctx.on('webserver/index-inject', (table) => {
  table.push({ kind: 'script', placement: 'head', text: pageHookScript() })
})
```

早期只实现了 `tapIndex`，导致桌面端按钮出现但点击无效。

### 状态按钮（已解决）

页面订阅的是 `$events` 里的 `{ type:'emit', event:'api-session/status', args:[sessionId, running] }`。
**格式必须完全一致**——用 `notification` 会导致页面判定为畸形帧并断开重连。

### emit 的 JSON 安全

DSH 的行为是「拒绝非 JSON 的普通事件参数」：

```js
// 我们照做：不可序列化则整条丢弃，而不是转成 null
if (wire.some((entry) => entry.ok !== true)) return
```

### pending lifetime（与原生一致）

```js
const cause = request?.signal
cause?.addEventListener('abort', () => settle('cancelled'))
setTimeout(() => settle('rejected'), APPROVAL_TIMEOUT_MS)   // fail closed
```

---

## 十、状态文件

```json
// ~/.dsh/remote-control.json  权限 0600，原子写
{
  "version": 2,
  "local":  { "enabled": false, "activeId": "...", "presets": [...] },
  "remote": { "enabled": false, "activeId": "...", "presets": [...] }
}
```

`cordis.patch.yml` 只提供**首次种子**，程序不改写它。

---

## 十一、页面代理鉴权（2026-11-05 P0/P1 修复）

`/remote-control/api/*`、`/download`、`/present-host`、`/state`、`/transport`、`/rbr/*` 不再把
loopback/LAN 当作身份。统一走 `lib/auth.js` 的 `authorizeOwner()`：

1. 先试 `ctx.connection.admit(req)`：owner Cookie + Host/Origin 栅栏通过才放行；guest 直接拒绝。
2. 没有 Cookie（桌面壳等）时，接受页面 hook 注入的 per-process capability（`x-dsh-remote-control-capability`），
   但要求请求目标是本机 bind 地址/loopback/trusted host，或来源是非 HTTP 的 `dsh-app:` 页面。
3. capability 不写日志、不进 JSON、不进下载 URL；下载用 60 秒、绑定 path 的 HMAC ticket。
4. `launchToken` 只保留在 `relayLocalLoopback`/`relayLocalStream` 内部，不再出现在 `snapshot()` 响应中。
5. mux WebSocket 继续用 per-process `rc` secret；它等同于页面 capability。

`bridge` 的 bearer token + 明文 `ws://` 仍是独立边界：本地代理鉴权修好后，仍然只能在
Tailscale/SSH/WireGuard 等可信链路使用。

**bridge 不支持 WSS/TLS**：`normalizeAddress()` 只接受 `http://`/`ws://`，B 侧使用明文
`http.createServer`。如果文档或 UI 出现“WSS”作为 bridge 的安全选项，那是不准确的；本机
relay 可能按 DSH webServer 协议使用 `https/wss`，但那是页面到本机 Host 的另一条腿。

---

## 十二、传输性能与资源边界（2026-11-06 P2/P3）

- **每页一条 stream channel**：同一页面 mux 的所有远程 stream 共用一条 bridge WS，按 `id`
  多路复用；`$events` 仍是本机 Host 的流，mirror 单独一条。空闲 60 秒关闭，keepalive 30 秒 ping、
  90 秒无响应断开；transport 变化时主动关闭。
- **增量帧队列**：`lib/frames.js` 保存 chunk 列表，凑满整帧后只 `Buffer.concat` 一次；4 MB
  1 KB 分片从秒级降到线性，16 MB 帧不再逐 chunk 复制。
- **统一 1 MiB 分块**：`readBytes` 不设直读阈值；6.7 MB PDF 约 7 次往返，1 MiB 在 0.7 Mbps / 500 ms 下约 11 s，单请求不会触发 30 s 超时；2 MiB 分块在 0.7 Mbps 下约 30.5 s，已取消。
- **读取上限**：文本 `read` 组装上限 8 MB，普通 JSON 结果上限 16 MB，字节结果总量 64 MB；
  `settings` 预读 256 KB，`/transport` 和 ticket 请求 64 KB。A 侧在收到字节结果时按
  Host 声明的 slot 长度**预分配并原地填充**，超过 64 MB 在分配前返回
  `remote-control/too-large`；multipart 响应按块写回并等待 `drain`，不再 `Buffer.concat`
  整包复制。
- **下载/管道**：客户端关闭会拒绝 `drain` 等待并释放上游；WebSocket 写缓冲 A 侧 8 MB、B 侧 96 MB 时关闭慢端。B 侧一次 8 MB PDF 结果会拆成 32 个 base64 帧同步写入，8 MB 上限会误杀；96 MB 覆盖 64 MB 字节结果 base64 后的约 85 MB 并保留慢端保护。
- **审批宽限**：最后一个控制端断开后 10 秒内允许重连；超过后确认解析为 `cancelled`、提问为空答案。
- **Session control**：远程直接转发 B 的 `session/control` 流（baseline + 实时 projection 帧），不再每 4 秒用 `session/list`/`session/projections` 合成；模型选择、权限等投影因此即时回显。旧的轮询合成代码保留但不再使用。
- **TLS/跨平台**：本机 relay 按 `webServer.protocol` 使用 `https/wss`（不是 bridge；bridge 仍然是
  `ws://`）；文件路径识别 POSIX、Windows drive-letter 和 UNC；`ws` 查找修正了少一层 `dirname`
  和旧 Node 的 `getBuiltinModule` 缺失。
- **配置**：profile 的 seed `host/port` 现在会生成首个 preset；`clientMarker` 同时驱动 hook、client
  和 state 路由；不存在的 `locale/*.json` 导出已删除。

---

## 十三、远程下载策略与服务时长（P0-3）

- `local.fileRead = { mode: 'off' | 'shared' | 'home', root: string | null }`，默认
  `{ mode: 'off', root: null }`，跨重启保留；bridge 开关仍然在重启后强制关闭。
- `shared` 允许 DSH workspace + `root`（`root` 为 `null` 时只允许 workspace）；
  `home` 允许 `os.homedir()` 内且不在静态 denylist 内的文件；`off` 全部拒绝。
- workspace 动态来自 `ctx.get('workspaceRegistry')?.list()` 的注册路径；
  `ctx.get('sandboxPolicy')?.resolve().workspaceRoot` 作为无 registry 时的 fallback。
  `file-read` 没有 sessionId，不能假设 `sandboxPolicy.resolve()` 一定是当前会话 cwd；
  registry 会在切换/新增工作区后实时更新，不把路径写进 state。
  若 registry 尚未包含新建会话，再用 `ctx.get('sessions')` 的 live `header.cwd` 补齐。
- 静态 denylist 按平台区分：macOS 的 `~/Library`、`.dsh`、`.ssh` 等；Windows 的
  `%APPDATA%`、`%LOCALAPPDATA%`、`%SYSTEMROOT%` 等；Linux 的 `/etc`、`~/.config`、
  keyrings 等。denylist 只在 `home` 模式生效；`shared` 没有额外 denylist，用户选择的
  目录就是允许范围。
- 判定前对 root 和 target 做 `realpath`；只允许普通文件；`open` 使用 `O_NOFOLLOW`
  并核对打开后的 `dev/ino`，拒绝 symlink 替换/文件变更。
- 远程右侧边栏下载键先向 A Host 的 `/remote-control/can-read?path=...` 请求一个
  per-path 布尔值；没有值不渲染，`false` 渲染为灰色 +「当前设置无下载权限」，
  `true` 才可点击。B 的 `file-read-check` 返回该值；真正下载时 B 仍逐次校验。
- 原 DSH 文件卡 open-with/download 事件已删除；`canOpenWorkspacePath` 仍返回
  `false` 以隐藏原生 open-with，`openWorkspacePath` 有防御性拒绝，避免在 B 上打开文件。
- DSH 自身的 `workspaceFiles/readBytes` / `read` 不走这条下载策略，远程预览仍可用；
  因此该策略是下载通道/防手滑，不是对 owner 级读取的完整安全边界。
- `local.durationMs` 默认 1 小时，可选 5m/30m/1h/3h/12h/24h/永久，跨重启保留。
  Host 在 bind 成功后计时；到期自动关闭 listener、断开 socket、settle 审批并保存
  `enabled=false`。永久 = 直到 DSH 退出或手动关闭，不是跨重启自动监听。

---

## 十四、P1 修复补充（2026-11-08）

- **WebSocket 单帧上限**：A 的 `connectUpstream()` `maxPayload` 提升到 20 MB，
  继续保留普通 JSON 结果 16 MB 的业务上限；`readBytes`/`file-read` 的字节流仍是
  1 MiB 请求 / 256 KiB 结果帧，不依赖这个上限。
- **文本读取**：`readText` 同时检查 Host 返回的总 `bytes` 和后续每块累计字节，
  超过 8 MB 返回 `remote-control/too-large`，不再只检查第一块。
- **B 侧 idle 淘汰**：每个 bridge socket 记录 `lastSeen`；任入站数据刷新；
  30 秒检查一次，90 秒无数据即 `shutdown(1001)` 并移除 approval sink，
  半开控制端不会再把本地审批框压住 5 分钟。
- **slowloris 边界**：B 的 `http.Server` 设置 `headersTimeout=10s`、
  `requestTimeout=15s`、`keepAliveTimeout=5s`、`maxConnections=128`。
- **capability 范围**：`capabilityMatches()` 不再接受 `?rc=`；
  HTTP 路由只认 capability header；mux upgrade 仍由 `handleUpgrade` 单独校验 `rc`。
- **readBytes 日志**：`readBytesLog()` 受 `DSH_REMOTE_CONTROL_TRACE` 控制，
  默认不写盘。
- **Windows 下载 ticket**：`verifyTicket()` 使用 `isAbsolutePath()`，
  与 `issueTicket()`/`handleFileRoute()` 一致。
- **loopback 回退**：`isLoopbackHostname()` 使用严格 `127.0.0.0/8` IPv4 正则，
  不再把 `127.evil.example` 当 loopback。

## 十五、P2 修复补充（2026-11-08）

- **RPC 关联 id**：A 不再把页面的 `rpcId` 直接拼成 bridge 的 `id`，而是为每个
  bridge 请求生成内部随机 id；页面 `rpcId` 只用于回填响应。超长/重复/空页面 id
  不再影响 bridge 的 128 字节 id 限制或并发请求。
- **错误帧关联**：B 对可关联的 `namespace/method`、`args` 等错误回带原始 `id`；
  无法关联的 JSON/非对象/非法 id 错误带 `fatal: true` 并关闭该 socket。A 只接受
  与本请求 id 相同的错误；`fatal` 错误按连接级失败处理，避免一个坏帧误杀同一
  socket 上所有并发 RPC。
- **字节结果内存**：A 的 `rpcOnConnection` 对 `result-bytes` 维护总量上限；按
  `{ __bytes, length }` 预分配 `Uint8Array` 并原地填充；`sendRpcResult` 逐段
  `res.write` 并等待 `drain`，去掉 multipart 整包 `Buffer.concat`。实测 64 MB
  结果峰值由约 550 MB 降到约 187 MB（同一台本机、同一 fake-B 场景），超限返回
  业务错误 `remote-control/too-large`。
- **兼容性**：Host 未声明 `length` 时仍走旧的 chunk 列表 + `Buffer.concat` 回退；
  旧 Host/新 A、新 Host/旧 A 均可继续工作。
