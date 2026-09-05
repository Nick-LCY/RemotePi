---
prd: prds/m2-tunnel.md
status: done
---
# 任务：bridge 客户端（token / WSS / handshake / 心跳 / 重连）

> **2026-09-05 修订（部署形态改定，task 06 处理）**：网页合并进主域，bridge `shareUrl()` 默认 base 从 `https://web.remote-pi.sankabox.com` 改为 `https://remote-pi.sankabox.com`（对应单测断言同步）。本任务交付的代码（WSS / handshake / 心跳 / 重连 / token 生成）不变，base 常量与测试在 task 06 调整。

## 目标
按 [[prds/m2-tunnel.md|M2 PRD §2 bridge]] 实现 `packages/bridge` 守护进程：启动生成 token → stdout 打印分享 URL → 连 WSS → handshake → 心跳 → 收 ping 回 pong → 退避重连。包结构 `index.ts` / `token.ts` / `client.ts` / `logger.ts`；写 8 条 vitest 单测。

关键要点：

- `token.ts`：`generateToken()` 用 `crypto.randomBytes(24).toString('base64url')`（32 字符；base64url 字符集 ⊆ [A-Za-z0-9_-]）；`shareUrl(token, base?)` 拼 `https://remote-pi.sankabox.com/#<token>`，`base` 可覆盖（dev 默认 `http://localhost:5173`）。> **2026-09-05 修订**：网页已合并进主域（见 [[prds/m2-tunnel.md|M2 PRD]]），原 `web.remote-pi.sankabox.com` 方案作废，默认 base 改为主域
- `logger.ts`：极简 logger，info/warn/error 三级，stdout 输出；不引入 pino / winston
- `client.ts`：核心 WSS 客户端类（不直接 spawn 进程，便于单测）：
  - 构造时 `new WebSocket(url, ["remotepi.v1", token])`
  - `onopen` → 发 `control/handshake {role:'bridge', token}`（一次即可，连接保持即视为握手成功——bridge 不等待 ack；见 PRD §2 注）
  - `onmessage` 解析 envelope：收到 `control/ping` → 回 `control/pong {nonce}`（nonce 原样带回）；收到 `control/bridge_status` / `control/error` 仅记录日志
  - 心跳：每 20s 主动发 `control/ping {nonce: nanoid(8)}`；30s × 3 无 pong → 主动 close → 触发退避重连
  - 收 `error(terminal:true)` → 等服务端 close，再退避重连
  - 重连：指数退避 base=1s、cap=30s、加 jitter（±20%）；成功后清零 delay
- `index.ts`：`generateToken()` → 打印 token + `shareUrl(token)` → 立即 `new Client(url).start()`；`--worker-url` 命令行 flag 可覆盖默认 `wss://remote-pi.sankabox.com/bridge`
- 不引入 pi 子进程（M2 不接 pi）；不写 systemd unit（独立任务）
- 单测 8 条（PRD §6 列出的清单，下文为复述）：
  1. token 长度 === 32 且字符集 ⊆ base64url（`/^[A-Za-z0-9_-]{32}$/`）
  2. 两次 `generateToken()` 结果不等
  3. `shareUrl('abc')` === `'https://remote-pi.sankabox.com/#abc'`（默认 base）
  4. `Client` 构造时 WSS 用 `subprotocols: ['remotepi.v1', token]` 参数（可用 fake/mocked WebSocket 校验）
  5. 收到 `control/ping {nonce:'n1'}` → 发 `control/pong {nonce:'n1'}`（nonce 一致）
  6. 退避序列 ≈ 1/2/4/8/16/30/30 + jitter（±20% 范围断言：assert delay >= base*0.8 && delay <= base*1.2，cap 30）
  7. 30s × 3 判死：连续 3 次心跳超时 → close → 重连次数 === 1
  8. `index.ts` 启动 stdout 含 token 与 shareUrl（spawn 子进程捕 stdout 断言或 logger spy）

## 完成标准
- [ ] `packages/bridge/src/token.ts` 实现 `generateToken()` 与 `shareUrl(token, base?)`；token 长度 32、字符集 ⊆ base64url
- [ ] `packages/bridge/src/logger.ts` 实现 info/warn/error；stdout 输出
- [ ] `packages/bridge/src/client.ts` 实现 WSS 客户端：handshake（不等 ack）、20s 心跳（nanoid(8) nonce）、收 ping 回 pong（nonce 一致）、30s×3 判死 close、指数退避（base=1s、cap=30s、jitter）
- [ ] `packages/bridge/src/index.ts` 启动流程：generate token → stdout token + shareUrl → 立即 start Client；接受 `--worker-url` 命令行 flag（默认 `wss://remote-pi.sankabox.com/bridge`）
- [ ] `packages/bridge/src/__tests__/` 落地 8 条用例（编号 1–8 与上方一一对应），全绿
- [ ] `pnpm --filter @remotepi/bridge test` 全绿；`pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` 全绿
- [ ] 不引入 pi 子进程；`packages/bridge/src/` 不引用 `@earendil-works/pi-coding-agent`（M3 再接）；`peerDependencies.optional` 沿用 M1
- [ ] M1 的 hello 占位 `console.log` 删除；启动流程符合 PRD §2 描述

## 依赖
- 依赖 [[tasks/m2/01-shared-envelope-v1.md|01-shared-envelope-v1]]（需要 v1 envelope + 5 payload schema 才能构造握手/心跳/错误帧）
- 不依赖 02（测试可独立编写；CI 时 02 必须先绿）