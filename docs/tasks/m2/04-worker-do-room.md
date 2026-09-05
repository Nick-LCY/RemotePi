---
prd: prds/m2-tunnel.md
status: done
---
# 任务：worker + DO Room（路由 / 鉴权 / 广播 / 判死 / 错误码）

> **2026-09-05 修订（部署形态改定，task 06 处理）**：网页合并进主域后，worker `GET /` 返 hello 让位给 web SPA（Worker Static Assets SPA fallback）；ops 探活挪到 `/healthz`（返 `ok`）。本任务原交付的「`GET /` 返回 hello」会被覆盖——task 06 在本任务产物基础上调整 `index.ts`，加 `run_worker_first` 路由 `/web` `/bridge` `/healthz` 与 `[assets]` 配置。本任务产物（Room DO / token 鉴权 / 转发 / 错误码 / 探活判死）不变。

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §3 worker + DO]] 实现 CF Worker 入口（路由 / token 提取 / DO stub）+ Room 类（握手鉴权 / 转发 / 广播 / 探活 / 错误码矩阵）。`wrangler.toml` name 改为 `remotepi-worker`、加 DO binding 与 sqlite migration；`@cloudflare/workers-types` ^4 → ^5。

关键要点：

- `wrangler.toml`：
  - `name = "remotepi-hello"` → `"remotepi-worker"`
  - 新增 `[durable_objects.bindings]` 表（name="ROOM" / class_name="Room"）
  - 新增 `[migrations]` 表（new_sqlite_classes=["Room"]；不启用 Hibernation）
  - `compatibility_date` 不变（M1 已定）
  - **部署顺序**：先 `wrangler deploy` 把新名 worker 上线（占位空 worker 也行），再让用户去 infra route 把 `script` 引用从 `remotepi-hello` 改为 `remotepi-worker`，最后 `terraform apply`——避免域名空窗（用户操作清单见 PRD）
- `package.json`：`@cloudflare/workers-types` `^4.x` → `^5.x`；`wrangler` 版本同步升（实测 wrangler 4.128+ 与 workers-types ^5 兼容）
- `index.ts`：
  - `GET /` 保留 M1 hello 文本（ops smoke 探测）
  - `/web` `/bridge` 非 upgrade 请求 → `426 Upgrade Required`
  - `/web` `/bridge` upgrade 请求：从 `request.headers.get('Sec-WebSocket-Protocol')` 提取 token（按 "remotepi.v1, <token>" 格式拆第二项）；token 缺失或格式不符 → `401`
  - `idFromName(token)` → `env.ROOM.get(id)` → DO stub
  - 其他路径 → `404`
  - **token 只走 subprotocol，不引入 URL query**（协议锁版；若实测 CF 读不到该头，属协议偏离，需显式记录到当前状态再议）
- `room.ts`（Room DO 类）：
  - `webSocketMessage(ws, msg)`：解析 envelope；envelope 解析失败 → 回 `error(invalid_envelope, terminal:false)`；`v ≠ 1` → 回 `error(unsupported_version, terminal:true)` + close 1008
  - 握手校验（5s timer）：首帧必须为 `control/handshake`；`role` 与入口路径不符 → `error(auth_failed, terminal:true)` + close 1008；同 token 已有 bridge → `error(duplicate_bridge, terminal:true)` + close 1008；校验通过 → 注册连接、清 timer、`broadcast(bridge_status{online:true, reason:'connected'})`、若 web 端再补发当前状态
  - 转发：web 入站 → 单发给 bridge；bridge 入站 → 广播给所有 webs；`ping`/`pong` 原样转发不解析 payload
  - `webSocketClose(ws)`：移除连接；若是 bridge → `broadcast(bridge_status{online:false, reason:'closed'})`；web 关闭不广播
  - `webSocketError`：同 close 处理
- `heartbeat.ts`：DO 主动探活模块（PRD §3 兼容补充，与协议 control.md §2 备注呼应）：
  - 每 20s 对各连接发自己的 ping（控制面内部 ping，envelope 走 `control/ping`，与业务 ping 形态一致；中间层发的 ping 同样遵守转发规则——bridge 收到会回 pong，DO 收到自己的 pong 算存活）
  - 30s × 3 无 pong → 关闭该连接；关闭的是 bridge → `broadcast(stale)`
- `Room` 在 `blockConcurrencyWhile` 里启动心跳 loop（`setInterval` 20s）；DO 闲置被驱逐的语义不在 M2 处理（手测 10 分钟空闲）
- 错误码矩阵（必须全部落地）：
  | 触发条件 | code | terminal | 关闭码 |
  |---------|------|----------|--------|
  | subprotocol 缺失/格式错 | （401 在 `index.ts`） | — | — |
  | 5s 无 handshake | auth_failed | true | 1008 |
  | role 与入口不符 | auth_failed | true | 1008 |
  | 同 token 第二 bridge | duplicate_bridge | true | 1008 |
  | envelope 解析失败 | invalid_envelope | false | — |
  | v ≠ 1 | unsupported_version | true | 1008 |
- 不写自动化测试（PRD §6：DO 与 web 一起 `wrangler dev` + 浏览器 + wscat 手测）
- 不接 pi 业务；不持久化任何业务数据

## 完成标准
- [ ] `worker/wrangler.toml`：`name = "remotepi-worker"`；新增 `[durable_objects.bindings]`（name="ROOM" / class_name="Room"）与 `[migrations]`（new_sqlite_classes=["Room"]）；`compatibility_date` 不变
- [ ] `worker/package.json`：`@cloudflare/workers-types` ^5；pnpm install 无 peer 警告；`wrangler` 与 types 同步升级
- [ ] `worker/src/index.ts`：`GET /` 返回 M1 hello；`/web` `/bridge` upgrade 请求按 Sec-WebSocket-Protocol 提取 token → `idFromName(token)` → `env.ROOM.get(id).fetch(req)`；非 upgrade 请求 → 426；token 缺失/非法 → 401；其他路径 → 404
- [ ] `worker/src/room.ts`：Room DO 类实现握手 timer（5s）、role 校验、duplicate_bridge 检测、转发规则、错误码矩阵（含 invalid_envelope 非致命、unsupported_version fatal）；bridge 关闭广播 `closed`；新 web 补发当前 bridge_status
- [ ] `worker/src/heartbeat.ts`：每 20s 对各连接发 ping；30s×3 无 pong 关闭该连接；判死 bridge → 广播 stale
- [ ] `pnpm -r build`（含 `wrangler deploy --dry-run --outdir=dist`）全绿；`pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] 不写自动化测试（PRD §6 明确手测），但任务完成时需给出验证脚本/步骤（PRD §验收清单错误码路径与心跳判死）

## 依赖
- 依赖 [[tasks/m2/01-shared-envelope-v1.md|01-shared-envelope-v1]]（需要 v1 envelope + 5 payload schema 才能构造握手/心跳/错误帧）
- 不依赖 02/03/05（与 03 / 05 可并行；手测与 06 一起做）