# 0013. bridge 重连状态机对 undici close 缺发的防御：身份守卫 + CONNECTING error 驱动 + idle 合成 handleClose

- 日期：2026-09-11
- 状态：已接受
- 背景：
  用户线上实测（2026-09-11 日志实锤）：bridge（Node 22 内置 `globalThis.WebSocket = undici`，非 `ws` 包）在 web 离线场景下发生**重连状态机永久停摆**——11:20:12 idle 超时 → 11:37:47 close(1006) 到达 → 此后**进程活着、零定时器、再无任何重连**，直至用户人工干预。链路日志三段：

  1. **11:20:12（read-idle 触发）**——服务器↔CF 网络路径静默死亡（无 FIN/RST，半开连接）→ ADR-0011 的 90s read-idle 正确触发 `ws.close(1000,'idle timeout')`。
  2. **11:20:12 → 11:37:35（17 分 24 秒空窗）**——close 帧发进死管道；Linux `tcp_retries2=15`（默认）重传预算耗尽前，TCP 层不会返回 ETIMEDOUT；实测 17 分 24 秒（11:20:12 → 11:37:35）后内核才由 ETIMEDOUT 触发 undici 补发 close(1006)。
  3. **11:37:35 → 11:37:47 → 永久**——close(1006) 到达后重连 attempt 1，重连失败（网络未恢复）：undici 在所有建连失败场景（HTTP 非 101 / ECONNREFUSED / SYN 黑洞）只派发 `onerror`、**永不派发 `onclose`**，错误消息统一为 `"Received network error or non-101 status code."`（网络错误与非 101 HTTP 响应混淆，bridge 不可区分）。而 bridge 重连只由 `onclose` 驱动、`handleError` 是纯日志（注释假设 "close event is the authoritative signal"——浏览器规范假设，undici 违反之）→ 重连状态机永久停摆，**进程活着、零定时器、零重连**。11:37:47 后日志无任何 reconnect 记录。

  事故期间附带观察：`handleIdleTimeout` 把 `this.ws` 置 null 后等 close 事件的 17 分钟空窗内，DO 侧 bridge 槽位由 ADR-0012 挑战式接管兜底（worker 已部署）——DO 侧无需任何改动。

  **实验实证（开发机 Node v22.23.1 / undici 7.29.0）**——把 bridge 客户端的 WebSocket 拉到 console 单跑，按六组场景测事件时序：

  - **A（503 响应）**——server 握手回 HTTP 503：error 事件 @29ms，close 事件**永不来**。
  - **B1（ECONNREFUSED）**——127.0.0.1 拒接：error 事件 @18ms，close 事件**永不来**。
  - **B2（SYN 黑洞）**——10.255.255.1（黑洞 IP）：error 事件 @~5s（undici 自有 connect 子超时触发），close 事件**永不来**。
  - **C1（已建连后 RST）**——server 端 `socket.destroy()`：close(1006) @2-3ms 即到。
  - **C2（已建连后异常 FIN）**——server 端 `socket.end()` 后立刻 `destroy()`：close(1006) @2-3ms 即到。
  - **C3（已建连后正常 FIN）**——server 端 `socket.end()`：close(1006) @2-3ms 即到。
  - **C4（已建连后纯静默）**——已握手成功后 server 端 `socket.pause()` 不再写、不 close、不 destroy：bridge 端 `ws.close(1000,'x')` 调用后，server 永远不回 ack，但 close 事件**60s 内不来**——此即线上 17 分钟机制的同形态（17 分钟是 tcp_retries2=15 的实测耗时，60s 测试用 `socket.pause` 模拟类似但有差异的"延迟关闭"）。
  - **C6（已建连后纯静默 + 无 close 调用）**——bridge 端什么都不做：close 事件**永不自己来**，靠 ADR-0011 90s read-idle 兜底。

  **关键观察**——**所有建连失败（A/B1/B2）的 `onerror` 都在毫秒~5 秒内到达，但 `onclose` 永不来**；**所有已建连后 RST/FIN（C1/C2/C3）的 `onclose` 在 2-3ms 内到达**。**结论**：bridge 重连状态机不能继续依赖 "close 事件是重连的唯一权威信号" 这一浏览器规范假设——必须把重连驱动权从 close 事件单点依赖改为 error/idle 双路径，并配合身份守卫处理晚到事件。

  与 ADR-0011（read-idle 检测）+ ADR-0012（DO 侧挑战式接管）的关系——三条防御机制正交协同，构成完整存活模型：
  - **ADR-0011** 管「检测连接死没死」（bridge 端 90s read-idle）。
  - **ADR-0012** 管「DO 侧槽位判活」（3s 挑战探测旧桥）。
  - **本 ADR** 管「检测到死之后如何不被 close 事件交付问题卡死」（重连驱动权去单点 + 身份守卫）。

  备选否决：

  - **备选 B：「connect 阶段加 watchdog 兜底 close 缺发」**——在 `handleConnect` 内启动 ~10s watchdog，超时未收到 close 也未收到 open 就主动走 handleClose。**否决**：实测所有失败模式 error 秒级到达（18ms / 29ms / ~5s），watchdog 是冗余的兜底；引入新定时器增加状态管理负担（stopped 语义 / 重入 / 同步 / 与 handleIdleTimeout 互斥），却不能解决"OPEN 后 zombie socket + 17 分钟 close 迟到"的核心问题（C4 形态）。若未来 undici 行为变化导致 error 不来，由本 ADR 已记录的实验矩阵 + 集成测试可快速定位，无需提前预判。
  - **备选 C：「完全自建握手协议层（不走 undici 的 WebSocket 抽象）」**——bridge 改用 `http` / `https` 模块直接 upgrade，自管握手状态。**否决**：放弃 Node 22 内置 WebSocket 的免费升级路径，重新引入 socket 管理负担；与「bridge 是薄客户端」的角色定位（ADR-0001）相悖；无收益。
  - **备选 D：「只补 `onerror` 驱动 CONNECTING 重连，不加身份守卫」**——`handleError` 检测 readyState===0 就 `handleClose(undefined)`，跳过身份守卫。**否决**：本 ADR 的核心场景正是「17 分钟后的 close(1006) 终于到达，污染新一轮重连的 attempt 账目与定时器」——没有身份守卫，handleClose 拿到的 `ws` 已是僵尸 ws，其晚到 close 会污染新一轮 `this.ws` 的定时器与日志，引入隐蔽的"重连时序错乱"次生缺陷。身份守卫是防御"晚到事件污染新 socket 状态"的硬要求，不只是风格选择。

- 决策：
  全部修复落在 bridge 单端（`packages/bridge/src/client.ts`），**wire 协议 / worker / web / shared 零改动**。六条决策：

  1. **身份守卫（identity guard）—— 防御晚到事件污染新 socket 状态**：在 `connect()` 的四个 `new WebSocket(url)` 委托 handler（`onopen` / `onmessage` / `onclose` / `onerror`）闭包捕获本地 `ws` 实例；委托桥入口第一行加 `if (ws !== this.ws) return;`——任何**非当前 `this.ws`** 的迟到事件（含 17 分钟后的僵尸 close(1006)）被拒绝，防止其污染新连接的 idle 计时器、attempt 账目、`handshakeConfirmed` 状态与日志流。这是状态机完整性的硬要求。

  2. **`handleError` 参与状态驱动（仅 CONNECTING 阶段）**：日志逻辑保留，但按 readyState 分支：CONNECTING → `'socket error (no close will follow; reconnecting)'`，其余（OPEN / CLOSING / CLOSED）保留 `'socket error (close will follow)'`。CONNECTING 分支随后 `if (ws.readyState === 0) this.handleClose(undefined)`，驱动 handleClose 走 attempt++ / 退避 / scheduleReconnect 通路。OPEN 阶段 error 保持 log-only——依据：实验 C1/C2/C3 证明 OPEN 后 close 可靠到达（RST/FIN 即时），纯静默由 ADR-0011 的 90s read-idle 兜底，立即重连会与随后必然到来的 close 竞争，引入 attempt 双触发的抖动。

  3. **`handleIdleTimeout` 立即调度重连（消除 tcp_retries2 17 分钟空窗）**：`if (this.stopped) return;` → warn 日志 → `this.ws = null`（**先置空使 sync / 迟到 close 被身份守卫拒绝**——顺序不能反）→ `ws.close(1000,'idle timeout')`（保留 wire 行为，不破坏协议兼容性）→ 直接 `this.handleClose(undefined, { code: 1000, reason: 'idle timeout' })` 走既有的 `attempt++` / 退避 / scheduleReconnect 通路，**不再等 close 事件**。这一步消除"close 帧发进死管道 → 等 tcp_retries2 耗尽 → 17 分钟后 ETIMEDOUT → undici 补 close(1006)"的空窗，是本修复的核心。

  4. **`handleClose` 签名扩展为合成事件**：`handleClose(ev?: { code?: number; reason?: string } | CloseEvent, synthetic?: { code?: number; reason?: string })`——为合成路径加第二个可选参数；内部 `code = synthetic?.code ?? (ev as CloseEvent)?.code ?? 1006`（缺省 1006 与 undici 行为对齐），`reason = synthetic?.reason ?? (ev as CloseEvent)?.reason`。`attempt++` / stopped 守卫 / `computeBackoff` / `scheduleReconnect` 逐字节不变；只是 `code` 取出源从单一 CloseEvent 改为 `synthetic ?? ev` 二选一。

  5. **不加 connect 阶段 watchdog**：实测 A / B1 / B2 三种失败模式 error 全部秒级到达（29ms / 18ms / ~5s），watchdog 冗余且引入新定时器状态管理负担（与 handleIdleTimeout 互斥 / 重入 / stopped 语义）；若未来 undici 行为变化（error 也不来），由本 ADR 已记录的实验矩阵 + 集成测试可快速定位。

  6. **既有语义原样保留**——明确本 ADR **不改**：ADR-0011 的 `IDLE_TIMEOUT_MS = 90_000` read-idle 检测、`armIdleDeadline` 在 `handleOpen` / `safeParse` 成功后刷新；ADR-0012 的 `handshakeConfirmed` 门控 attempt 归零、`handleOpen` 不归零；`computeBackoff`（`BACKOFF_BASE_MS = 1_000` / `BACKOFF_CAP_MS = 30_000` / ±20% jitter）；`stopped` 语义（`stop()` 后任何路径不得重连，包括 CONNECTING 阶段 error 与 idle 触发的合成 handleClose）。

  关键设计原则：**重连驱动权去单点依赖 + 身份守卫净化晚到事件**——前者把"权威信号"从 close 事件扩展为 close / error / idle 三源；后者确保任一源产生的旧事件都不会污染新 socket 状态。两条必须同时落地，缺一不可（备选 D 论证）。

- 影响：
  - **bridge 代码侧**：`packages/bridge/src/client.ts`（约 +150 / -24）——
    - `connect()` 四个 handler 全部加身份守卫 `if (ws !== this.ws) return;`（决策.1）。
    - `handleError` 改为按 `ws.readyState` 分支打日志文案，CONNECTING 分支后追加 `this.handleClose(undefined)`（决策.2）。
    - `handleIdleTimeout` 重写：stopped 守卫 → warn → `this.ws = null` → `ws.close(1000,'idle timeout')` → `this.handleClose(undefined, { code: 1000, reason: 'idle timeout' })`（决策.3）。
    - `handleClose` 签名扩展为 `handleClose(ev?: ..., synthetic?: { code?: number; reason?: string })`，内部 `code = synthetic?.code ?? ev?.code ?? 1006`；`attempt++` / stopped / 退避 / scheduleReconnect 逐字节不变（决策.4）。
    - 文件头 JSDoc 改写条目 2 / 4 / 6：条目 2「重连机制」新增「error / idle 双源驱动 + 身份守卫」表述；条目 4「重连退避」备注 `handleClose` 合成路径同样走 `computeBackoff`；条目 6「重连状态机净化」新增「身份守卫净化晚到事件」段。
    - 不动 `IDLE_TIMEOUT_MS` / `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` / `computeBackoff` / `handshakeConfirmed`（决策.6）。
  - **bridge 测试侧**：`packages/bridge/src/__tests__/client.test.ts`（约 +200 / -30）——
    - `MockSocket` 加 `suppressOnclose: boolean` 选项（默认 false），模拟 undici 在建连失败时只发 error 不发 close 的行为（A / B1 / B2 实验矩阵的代码侧还原）。
    - 新增 helper `readReconnectDelay(stub, opts?: { prefix?: string })`，读取最近一次 `scheduleReconnect` 调用的延迟 + 可选前缀过滤（便于钉桩多 attempt 序列）。
    - 新增用例 **5g–5l**（共 6 条）：
      - **5g**：`onerror` 在 CONNECTING 触发 handleClose（attempt++ → scheduleReconnect 被调用）—— `MockSocket.suppressOnclose: true` + new WebSocket → emit 'error' → 验证 attempt=1 + scheduleReconnect 调用 + 日志文案 `'no close will follow; reconnecting'`。
      - **5h**：`onerror` 在 OPEN 阶段**不**触发 handleClose（保持 log-only）—— WebSocket 走完 open → emit 'error' → 验证 attempt 不变 + scheduleReconnect 未被调用 + 日志文案 `'close will follow'`。
      - **5i**：僵尸 socket 的晚到 close 被身份守卫拒绝—— `ws1 = new MockSocket({ suppressOnclose: true })` → emit 'error' → handleClose 触发 → `this.ws = ws2 = new MockSocket(...)` → emit 'close' on ws1 → 验证 `ws2` 的 attempt / 计时器 / 日志不被污染 + `ws1` 的 close 被守卫拒绝（钉桩 warn 日志）。
      - **5j**：handleIdleTimeout 立即合成 handleClose（不等 close 事件）—— `vi.useFakeTimers()` → trigger idle → advance → 验证 handleClose 被以 `{ code: 1000, reason: 'idle timeout' }` 调用 + `ws.close(1000,'idle timeout')` 已发出 + `this.ws === null`。
      - **5k**：handleIdleTimeout 与 stopped 互斥—— `stop()` 后再 trigger idle → 验证 handleClose 未被调用 + warn 日志包含 `'stopped'`。
      - **5l**：合成 handleClose 的 attempt++ 与真实 close 走同一退避序列—— 连续 3 次 CONNECTING error + `readReconnectDelay({ prefix: 'attempt ' })` → 验证 attempt 序列 1 → 2 → 3 对应的退避延迟遵循 `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` / ±20% jitter。
    - 既有用例 "onerror logs a warn" 适配为三形态各用新 socket 实例（OPEN error / CONNECTING error / 旧 socket 晚到 error），确保既有覆盖面不被压缩。
  - **wire 协议零变化**——`control/handshake` / `control/ping` / `control/pong` / `duplicate_bridge` / `bridge_status` 帧结构、13 control type、9 pi type、envelope schema 全部不动。
  - **worker 零改动**——`worker/src/room.ts` / `heartbeat.ts` / `room.test.ts` 不动；本修复完成后，bridge 重启若遇 zombie 槽位仍由 ADR-0012 挑战式接管在 DO 侧闭环。
  - **web 零改动**——web WsClient 不感知 bridge 内部状态机；既有 ping/pong 互喊语义不变。
  - **shared 零改动**——协议 schema 不变；`CONTROL_TYPES` 字面量不变。
  - **测试基线（2026-09-11 实施期）**：单测 **704 → 710**（+6：bridge 372 → **378** = 5g/5h/5i/5j/5k/5l；shared 136 / worker 11 零回归；web **未跑**——工作区有 M5 第二块任务 04（Tailwind v4 引入）的 in-flight dirty area 不属本修复；web 的 3 个在途失败用例经 stash 验证为 M5-04 自身所致）/ 集成 **32/32 零回归** / e2e **未跑**（同前理由；M5-04 任务收官时统一跑全量）；typecheck ✓（4 包）/ lint **0 error**（5 warnings 均为 web WsClient pre-existing）/ `pnpm --filter bridge --filter shared build` 绿。
  - **review 结论（2026-09-11）**：**0 Critical / 0 blocking Warning / 3 Suggestions** 全部落地（CONNECTING 阶段 error 日志文案按 readyState 分支——决定.2 已落地；5i 僵尸 socket 验证补 warn 面包屑断言，便于测试失败时定位是身份守卫还是状态机本身；`readReconnectDelay` helper 加前缀参数便于多 attempt 序列钉桩）。
  - **修复性质**：在线热修复（与 ADR-0011 / ADR-0012 同性质），直接落在 M5 第一块收官后 + M5 第二块任务 04 in-flight 时段，无对应里程碑任务文件（M5 第一块 2026-09-11 已收官 + M5 第二块 2026-09-11 立项 D8-D13，5 任务 todo；本修复不属于其中任何一项）。
  - **部署**：「服务器端 bridge 更新重启」TODO 条目（加载 commit `252fef6` 的 attempt 退避修复 + ADR-0011 read-idle 判死）现在同时加载本修复——重启一次同时激活：ADR-0011 read-idle 检测 + ADR-0012 退避门控 + 本 ADR 身份守卫 + CONNECTING error 驱动 + idle 合成 handleClose。三条 ADR 在同一份 bridge 二进制内，无需拆分部署。
  - **与 ADR-0011 正交协同**：[ADR-0011] 管"检测连接死没死"（bridge 进程内 90s read-idle）；本 ADR 管"检测到死之后如何不被 close 事件交付问题卡死"（重连驱动权从 close 事件单点依赖改为 error / idle 双路径 + 身份守卫）。两者**正交不重叠**——前者负责"判死"，后者负责"判死后驱动重连"。
  - **与 ADR-0012 正交协同**：[ADR-0012] 管 DO 侧槽位判活（duplicate 命中时 3s 挑战探测旧桥）；本 ADR 管 bridge 侧重连驱动（去单点依赖 + 身份守卫）。两者**正交不重叠**——前者发生在 DO 进程内（worker `room.ts`），后者发生在 bridge 进程内（`packages/bridge/src/client.ts`）。bridge 重启后重连若遇僵尸槽位，由 ADR-0012 挑战式接管在 DO 侧闭环；本 ADR 让 bridge 不论遇到什么失败模式都能可靠触发重连。
  - **与 ADR-0011 / ADR-0012 共同构成立体重连存活模型**：(1) **判死层**（ADR-0011：90s read-idle 检测连接是否真死）；(2) **驱动层**（本 ADR：error / idle / close 三源驱动重连 + 身份守卫净化晚到事件）；(3) **槽位层**（ADR-0012：3s 挑战探测旧桥槽位活性）。三层一起覆盖 "bridge 重连状态机不会因为任何失败模式而永久停摆" 的完整防御。

## 双向引用

- [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] —— bridge 接收侧 read-idle 判死（90s）；本 ADR 是其「检测到死之后的驱动路径」（handleIdleTimeout 不再等 close 事件，立即合成 handleClose）+ 「建连失败的兜底」（handleError 在 CONNECTING 阶段驱动 handleClose）。两者**正交协同**——前者管"判死"，后者管"判死后驱动重连"。
- [[architecture/decisions/0012-challenge-based-duplicate-bridge-takeover.md|ADR-0012]] —— DO 侧 duplicate-bridge 挑战式接管（3s 挑战探测）；本 ADR 是 bridge 侧"重连状态机不会被任何失败模式卡死"。两者**正交协同**——前者发生在 worker `room.ts`，后者发生在 `packages/bridge/src/client.ts`；bridge 重启后重连若遇僵尸槽位由 ADR-0012 闭环。
- [[current-state.md#最近变更]] —— 2026-09-11 本轮条目落地（在线热修复，无对应里程碑任务文件）。
- [[current-state.md#TODO--阻塞]] —— 「服务器端 bridge 更新重启」条目同时加载本修复（与 ADR-0011 read-idle + ADR-0012 退避门控一并加载）。
- `packages/bridge/src/client.ts` —— 实施承载点（决策.1 身份守卫 + 决策.2 handleError CONNECTING 分支 + 决策.3 handleIdleTimeout 重写 + 决策.4 handleClose synthetic 参数 + 决策.6 既有语义原样保留）。
- `packages/bridge/src/__tests__/client.test.ts` —— 测试承载点（`MockSocket.suppressOnclose` 模拟僵尸 socket + `readReconnectDelay` helper + 新用例 5g/5h/5i/5j/5k/5l + 既有 "onerror logs a warn" 适配为三形态）。
