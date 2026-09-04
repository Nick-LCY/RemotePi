---
prd: prds/m2-tunnel.md
status: done
---
# 任务：web 四组件 + WsClient

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §4 web]] 实现 React SPA：`WsClient` 单例（Context）+ 四组件（TokenPrompt / StatusBar / PingTester / BroadcastLog）。WSS 连 worker 域 `wss://remote-pi.sankabox.com/web`（dev 用 `VITE_WSS_URL`），token 走 URL fragment。

关键要点：

- `WsClient`（单例 React Context）：
  - 构造时读 `location.hash`（`#<token>`）；hash 存在 → 连；不存在 → 渲染 `<TokenPrompt />`
  - subprotocol：`["remotepi.v1", token]`
  - 出站：心跳 20s 发 `control/ping {nonce: nanoid(8)}`；收 `control/pong {nonce}` → 计次；30s × 3 无 pong → close + 退避重连（同 bridge 退避策略：base=1s、cap=30s、jitter）
  - 入站：解析 envelope；`control/bridge_status` → 更新 `StatusBar`；`control/pong` → 完成 nonce 配对与 RTT 计算；其他 type → 入 `BroadcastLog`（保留 200 行）；解析失败 `console.warn` 丢弃（**web 不发 error 帧**）
  - `close` / `error` 事件：状态置 offline 并触发退避重连
  - token 只在内存与 `location.hash`，**不写 localStorage**
- `<TokenPrompt />`：输入框 → 粘贴 token → 写 `location.hash` → 触发 WsClient 重连
- `<StatusBar />`：`connecting` / `online` / `offline` 三态 + 最近 `bridge_status.changed_at` 与 `reason`
- `<PingTester />`：按钮 → 发 `control/ping {nonce}`，记录发送时间；收 `control/pong` 显示 nonce 与 RTT（ms）；最近 N 条历史
- `<BroadcastLog />`：表格 `time / kind / type / id / payload 摘要`（payload 摘 JSON.stringify 截断前 200 字符），保留 200 行
- WSS URL 由 `import.meta.env.VITE_WSS_URL` 提供，默认 `ws://localhost:8787/web`（dev 走 `wrangler dev`）；生产构建期望 `wss://remote-pi.sankabox.com/web`（通过构建时 env 注入）
- `public/_redirects`：SPA fallback（`/* /index.html 200`）—— Pages 自定义域 SPA 路由需要
- `vite.config.ts`：dev server 默认端口 5173；无需额外代理（web 直连 worker 域，跨域由 worker / Pages 配）
- 不接 pi 业务；仅控制面四组件

## 完成标准
- [ ] `packages/web/src/ws/` 落地 `WsClient`（class + React Context + hook）；20s 心跳 + 30s×3 判死 + 退避重连；入站解析失败 console.warn 丢弃
- [ ] `packages/web/src/components/` 落地四组件：
  - `TokenPrompt`：粘贴 token → 写 `location.hash` → 触发重连
  - `StatusBar`：connecting/online/offline + `changed_at` + `reason`
  - `PingTester`：发 ping + 显示 nonce + RTT(ms)
  - `BroadcastLog`：time/kind/type/id/payload 摘要表格，保留 200 行
- [ ] `packages/web/src/main.tsx` 与 `<App />`：读 `location.hash` 决定渲染 TokenPrompt 还是带其余三组件的 layout
- [ ] WSS 配置：读 `import.meta.env.VITE_WSS_URL`（默认 `ws://localhost:8787/web`）；subprotocol `["remotepi.v1", token]`；token 只在内存与 hash，不写 localStorage（grep 验证 `localStorage.setItem` 不出现于 ws 模块）
- [ ] `packages/web/public/_redirects` 存在并含 SPA fallback（`/* /index.html 200`）
- [ ] `pnpm --filter @remotepi/web build`（`vite build`）成功产出 `dist/`；`pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] 不写自动化测试（PRD §6：手测）；任务完成时需给出 wrangler dev + 浏览器手测脚本（与任务 04 一起在 06 走通）

## 依赖
- 依赖 [[tasks/m2/01-shared-envelope-v1.md|01-shared-envelope-v1]]（需要 v1 envelope + 5 payload schema 才能构造握手/心跳/广播帧）
- 不依赖 02/03/04（与 03 / 04 可并行）