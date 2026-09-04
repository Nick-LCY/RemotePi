# M2 通路（web ↔ worker ↔ bridge）

> 状态：定稿（2026-09-05）。协议基线：[[architecture/protocol/README.md|隧道协议 v1]]（已定稿，PRD 与其零冲突）。

## 背景

M1 收官：monorepo 四包 + CI 双绿 + remote-pi.sankabox.com hello 闭环。协议 v1 已定稿落盘：信封 `{v, kind: "control"|"pi", type, id, session?, reply_to?, payload}`；control 8 个 type、pi 9 个 type；错误码 6 个；handshake 5 秒窗口、心跳 20s/30s×3、fatal 关闭码 1008、subprotocol `["remotepi.v1", token]` 均为锁版承诺。M1 遗留的 hello/echo 雏形与 5 条 envelope 测试将按 v1 全部重写。三个 M2 待决问题已敲定：token 由 bridge 启动动态生成（192-bit base64url，URL fragment 携带，不持久化）；CF 免费版（new_sqlite_classes，不启用 Hibernation）；bridge 分发 = GitHub Release 二进制（M2 仅本地构建运行，Release 流水线独立任务）。

## 目标

1. **隧道握手**：control/handshake 完成鉴权（subprotocol token、role 与入口路径、5s 窗口）；同 token 第二个 bridge 收 error(duplicate_bridge) 并断开，第一个不受影响
2. **保活**：ping/pong 双向转发、nonce 配对；20s 间隔 / 30s 超时 / 3 次判死
3. **在位状态**：DO 生成并广播 bridge_status（connected/closed/stale）；新 web 完成 handshake 后立刻补发当前状态
4. **广播**：单 bridge 多 web；bridge 出站广播给所有 web；web↔web 不互通
5. **错误码全集**：6 个 code 全部落地，terminal=true 关 1008
6. **web 验证面**：TokenPrompt / StatusBar / PingTester / BroadcastLog 四组件
7. **真实环境闭环**：web.remote-pi.sankabox.com 能连上本机 bridge 并显示在线

## 非目标

pi 进程管理与 JSONL 解析；session_state / session_list / result（无 pi 进程即无会话数据）；pi 家族 9 个 type；Hibernation；CI 自动部署（terraform apply / wrangler deploy 全部用户手动）；bridge systemd unit 与 Release 流水线；token 持久化与吊销；多房间；web 间私聊。

## 方案

### §1 shared（协议类型）

- `envelope.ts` 整文件重写：`PROTOCOL_VERSION = 1`；顶层 `z.discriminatedUnion('kind', [control 分支, pi 分支])`；control 分支内 `z.discriminatedUnion('type', [5 个])`；**pi 分支 M2 用 `z.never()` 占位**（Zod 空 discriminatedUnion 会抛错；M3 换成真 union 直接 append 9 个 type）
- 信封字段：v / kind / type / id（min1）/ session（optional）/ reply_to（optional）/ payload——session 与 reply_to M2 不填值但 schema 留位（envelope.md 锁版承诺）
- 5 个 payload schema：handshake `{role: enum('web'|'bridge'), token: min(1)}`；ping `{nonce?}`；pong `{nonce 必填}`；bridge_status `{online, changed_at: datetime, reason: enum('connected'|'closed'|'stale')}`；error `{code: enum(auth_failed/duplicate_bridge/invalid_envelope/unsupported_version/unsupported_type/internal), message, terminal?}`
- 命名契约沿用 M1 裁定：`HandshakeEnvelope` / `HandshakePayloadSchema` / `HandshakePayload`
- M1 的 hello / echo schema 与相关导出**彻底删除**，不留兼容 stub

### §2 bridge

- 启动：`crypto.randomBytes(24).toString('base64url')`（32 字符）→ stdout 打印 token 与分享 URL `https://web.remote-pi.sankabox.com/#<token>` → 立即连 WSS
- 连接：`wss://remote-pi.sankabox.com/bridge`（`--worker-url` 可配）；subprotocol 必须传 `["remotepi.v1", token]`
- handshake：upgrade 成功即发 `control/handshake {role:'bridge', token}`。**连接保持即视为握手成功——bridge 不等待任何 ack（bridge_status 只广播给网页，bridge 收不到）；失败通过 error 帧或断连感知并走重连**
- 心跳：20s 主动发 ping（nonce 用 nanoid(8)），30s × 3 无 pong → close → 重连
- 收 ping 回 pong（nonce 原样带回）；收到 bridge_status / error 仅日志
- 重连：指数退避 base=1s、cap=30s、加 jitter，成功后清零
- 包结构：`index.ts` / `token.ts` / `client.ts` / `logger.ts`

### §3 worker + DO

- wrangler.toml：name 由 `remotepi-hello` 改为 `remotepi-worker`（**部署顺序**：先 deploy 新名 worker，再更新 infra route 的 script 引用并 apply，避免域名空窗）；新增 TOML 表 `[durable_objects.bindings]`（name="ROOM" / class_name="Room"）与 `[migrations]`（new_sqlite_classes=["Room"]）；compatibility_date 不变
- `@cloudflare/workers-types` ^4 → ^5
- `index.ts`：`GET /` 保留 M1 hello 文本（ops smoke）；`/web` `/bridge` 非 upgrade 请求 → 426；upgrade 请求 → 从 `Sec-WebSocket-Protocol` 头提取 token（拆 "remotepi.v1, <token>" 取第 2 项）→ `idFromName(token)` → DO stub；其他路径 404。**token 只走 subprotocol，不引入 URL query**（协议锁版；若实测 CF 读不到该头，属协议偏离需显式记录再议）；token 缺失/非法 → 401
- `Room`：连接后启动 5s 握手 timer；首帧必须 handshake，role 与路径不符 → error(auth_failed, terminal)；同 token 已有 bridge → error(duplicate_bridge, terminal) + close 1008；校验通过 → 注册 + 清 timer + 广播 connected + 给该连接（web）补发当前状态
- 转发：web 入站 → 只转发给 bridge；bridge 入站 → 广播给所有 webs；ping/pong 原样不解析 payload
- **DO 主动探活**（协议 control.md §2 的兼容补充，见该文档备注）：每 20s 对各连接发自己的 ping，30s × 3 无 pong → 关闭该连接；被判死的是 bridge → 广播 stale
- webSocketClose：移除连接；bridge 关闭 → 广播 closed（webs 关闭不广播）
- envelope 解析失败 → error(invalid_envelope, 非致命)；v≠1 → error(unsupported_version, terminal)
- 包结构：`index.ts` / `room.ts` / `heartbeat.ts`

### §4 web

- **WSS 目标是 worker 域**：`wss://remote-pi.sankabox.com/web`（不是 Pages 子域——那里只有静态文件）；dev 用 `VITE_WSS_URL`（默认 `ws://localhost:8787/web`）
- URL fragment：hash 有 token 直接连；无 → TokenPrompt；token 只在内存与 hash，不写 localStorage
- subprotocol `["remotepi.v1", token]`
- 四组件：TokenPrompt（粘贴 token → 写 hash → 连接）；StatusBar（connecting/online/offline 三态 + 最近 changed_at）；PingTester（发 control/ping，收到 pong 显示 nonce 与往返耗时 ms——全链路验证面板）；BroadcastLog（time/kind/type/id/payload 摘要表格，保留 200 行）
- WsClient：单例（React Context）；20s 心跳；30s × 3 判死自愈（close + 退避重连）；入站解析失败 console.warn 丢弃（web 不发 error）
- `public/_redirects` SPA fallback

### §5 infra（Terraform）

- `pages.tf` 新增 `cloudflare_pages_project.remotepi_web`（production_branch=main；部署由 wrangler pages deploy 执行，不入 TF）
- `dns_web.tf` 新增 `web` CNAME → `remotepi-web.pages.dev`（proxied；**注意**：Pages 侧还需绑定自定义域，实现时核实走 TF 资源还是 Dashboard）
- 其余沿用 M1

### §6 测试

- **shared 17 条**（vitest，重写）：handshake 合法解析与窄化 / 缺 role / role 非法 / 缺 token；ping nonce 可选；pong nonce 必填（缺则拒）；bridge_status 三 reason 合法 / 非法 reason 拒；error 6 个 code 合法 / terminal 缺省可解析；v=2 拒；control 下未知 type 拒；kind=pi 当前任何 type 拒（空位）；kind 非 control|pi 拒；缺 id 拒；session/reply_to 缺省不影响解析
- **bridge 8 条**：token 长度 32 且字符集 ⊆ base64url；两次生成不等；share URL 拼接；WSS 构造 subprotocol 参数正确；收 ping 回 pong nonce 一致；退避序列 ≈1/2/4/8/16/30/30 + jitter；30s×3 判死触发 close 重连；stdout 含 token 与 URL
- **DO / web 手测**：wrangler dev + 浏览器 + wscat 发畸形包，不写自动化测试

## 验收清单

**roadmap 四条**：web 粘 token → StatusBar 在线；PingTester 发 ping 收到 pong 显示耗时；双 tab 同 token 同收广播；杀 bridge 进程 → 两 tab 5 秒内离线（reason=closed）
**心跳判死**：`kill -STOP` bridge → 90s 内广播 stale；`kill -CONT` → 自动重连恢复 connected
**错误码路径**（wscat）：无 subprotocol → 401；subprotocol 缺 token → 401；5s 无 handshake → auth_failed + 1008；role 与路径不符 → auth_failed；第二 bridge → duplicate_bridge + 1008 且第一个不受影响；畸形帧 → invalid_envelope 不断开；v=2 → unsupported_version + 1008
**技术**：shared 17 条 / bridge 8 条全绿；lint / typecheck / build 全绿；workers-types ^5 无 peer 警告；M1 hello/echo 无残留
**真实环境**：`https://web.remote-pi.sankabox.com/#<token>` 连本机 bridge 显示在线

## 任务拆分

| # | 标题 | 依赖 |
|---|---|---|
| 01 | shared 协议 v1 重写（envelope + control 5 type schema） | — |
| 02 | shared 测试重写（17 条；可与 01 同一提交） | 01 |
| 03 | bridge 客户端（token/WSS/handshake/心跳/重连）+ 8 条单测 | 01 |
| 04 | worker + DO Room（路由/鉴权/广播/判死/错误码）+ types bump | 01 |
| 05 | web 四组件 + WsClient | 01 |
| 06 | Terraform Pages 资源 + 三端联调手测验收 + getting-started 更新 | 03/04/05 |

03 / 04 / 05 可并行。

## 交付约定

**所有任务只在本地 commit，不 push**。push 由用户在本地验证（lint/typecheck/test/build 全绿 + 三端手测通过）后手动执行，触发 CI。CI 不做任何部署。

## 用户操作清单

- CF API Token 补 Pages:Edit 权限
- 部署顺序：`cd infra && terraform apply`（Pages 项目 + CNAME）→ `pnpm --filter worker run deploy:cf`（remotepi-worker 上线）→ 更新 infra route script 引用后再 apply → web `build` + `wrangler pages deploy dist --project-name=remotepi-web` → 浏览器验证
- Pages 自定义域若需 Dashboard 绑定，apply 后在 CF Dashboard 操作（实现时核实）

## 风险与实现时核实

CF Workers 能否读 Sec-WebSocket-Protocol 头（读不到则 query 兜底属协议偏离需记录）；免费版 DO 配额数字；new_sqlite_classes 实际行为；cloudflare_pages_project 5.x 必填字段；Pages 自定义域绑定方式；DO 常驻 setInterval 与平台驱逐（手测 10 分钟空闲）；浏览器 subprotocol 数组兼容性；worker bundle 体积（zod ~50KB，上限 1MB）

## 相关

[[architecture/protocol/README.md|协议 v1]] / [[roadmap.md]] / [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]] / [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] / [[prds/m1-infrastructure.md|M1 PRD]] / [[current-state.md]] / [[getting-started.md]]