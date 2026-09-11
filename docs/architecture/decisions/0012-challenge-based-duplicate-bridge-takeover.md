# 0012. duplicate-bridge 挑战式接管：DO 侧活性探测闭环 bridge 1006 僵尸占槽永久拒新 bug

- 日期：2026-09-10
- 状态：已接受
- 背景：
  用户线上实测：在 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] 修补落地、bridge 已切到接收侧 read-idle 后，又观察到一类**新暴露**缺陷——bridge 进程异常断开（close code **1006**，纯 TCP 层断，无 close frame）后，**快速重连被 DO 永久拒绝**（`error(duplicate_bridge)` + close 1008），bridge 退避重连永远打不通，必须等到原槽位在心跳 30s×3 ≈ 90s 后被 stale 判死才恢复。

  实测链路（重现三步）：

  1. 用户在远端服务器跑 bridge，operator 触发 `kill -9` 或网络瞬断（中间网络设备静默掐断、TCP 层 RST 不送达本地）→ bridge 进程侧的 `WebSocket.close` 回调**不会**被触发（1006 是底层 TCP 中断特征，workerd 不保证对纯 TCP 层断开派发 `close`/`error` 事件——`workerd` 文档 §「WebSocket 关闭」明示此行为差异）；
  2. DO 端 `Room` 的 `this.webs.delete(ws)` / `this.bridge = null` 依赖 `webSocketClose` / `webSocketError` 回调清账——回调没派发，**僵尸 ws 长期霸占 `this.bridge` 槽位**；
  3. 用户重启 bridge → 新 ws 上来 → handshake → DO `handleHandshake` 走到 `duplicate_bridge` 检查 → `this.bridge !== null`（僵尸还在）→ **新桥立即被拒（terminal 1008）** → bridge 退避重连 → 同一份僵尸仍在 → 永远拒。

  三层根因（按主因 / 放大器 / 卫生缺陷分类）：

  1. **主因（DO 侧 duplicate 检查无活性判断）**——worker `room.ts` 旧 `handleHandshake` 对 duplicate 检查是纯对象身份比对（`this.bridge !== meta.ws`），**协议 §1 本意是"拒绝第二个**活着的** bridge"，实现却把尸体也当活人拒**。协议层语义错位是此 bug 的根因层。
  2. **放大器（bridge 侧退避每次 `handleOpen` 归零）**——`packages/bridge/src/client.ts` `handleOpen` 每次 WS open 即 `attempt = 0` → 被 1008 拒后退避永远卡 800-1200ms 高频重试 → 僵尸存活期内永久锤 DO；无放大器时，bug 只是延迟若干秒恢复；有放大器时，bug 表现为"永远无法重连"。bridge 单测 5e 钉死这条。
  3. **卫生缺陷（worker 侧 stale 清理与 tick 异常隔离）**——(a) `tickHeartbeat` stale 判死分支漏 `webs.delete(ws)`（僵尸条目泄漏，与 bug 同根：cleanup 路径不全）；(b) `tickHeartbeat` 循环内对僵尸 ws 的 `send()` 若抛异常会中断整个 tick → stale 永不触发 → 用户实测"永远无法重连"是 (a)(b) 之一导致的实际表现。worker 单测 7/8 钉死这两条。

  三层叠加：主因让"1006 后 zombie 占槽"成为可能；放大器让"DO 永久拒新"成为体验；卫生缺陷让"原本 90s 后 stale 应能恢复"也失效。三层必须一并修——只修任一层都不够。

  备选记录：

  - **方案 B「无条件接管 / last-writer-wins」**——duplicate 命中直接纳新（踢旧 + 广播 stale + 纳新）。**否决**：双活 bridge 实例同时握手时互踢抖动（哪边都认为自己合法 → 30s×3 内反复踢对方，UI 闪烁）；不可作为通用语义。
  - **方案 C「仅调参：缩短 heartbeat 30s×3 → 5s×3」**——让 stale 更快触发。**否决**：仍存分钟级断连窗口（5×3 = 15s × 抖动），且 heartbeat 高频化会显著增加无意义 ping/pong 流量；调参只覆盖卫生缺陷，对主因无解。

  决策：
  采用 **方案 A「挑战式接管」**——duplicate 命中时不立即拒绝，而是向在位旧桥发 `control/ping` 挑战探测，按 3s 预算等 pong；旧桥 3s 内回 pong → 证明旧桥活着 → 拒绝新桥（terminal 1008）；旧桥 3s 内未回 → 视为僵尸踢旧 + 纳新。决策要点：

  1. **挑战 nonce + budget 与 heartbeat 账目完全独立**——`ConnMeta` 新增 `challengeNonce` / `challengeSentAt` 两个字段，独立于 `pendingPingNonce` / `pingSentAt` / `missedPong` heartbeat 账目；不共享、不互相消费。理由：若共享，一个慢但活的 bridge 收到挑战 ping 时回 pong，会顺手清掉一个真实的待回答 heartbeat nonce——掩盖真 stale。`routeOpenMessage` 的 pong 处理采用三桶优先级：① 挑战 nonce 命中 + 挑战在位 → `resolveChallenge(true)`；② heartbeat nonce 命中 → 清账；③ 都不命中 → 转发到对端。worker 单测 6 钉死两条账目独立。
  2. **`CHALLENGE_TIMEOUT_MS = 3_000`**——挑战预算定值 3 秒，依据三条：(a) DO 心跳 ping → bridge 本地 `replyToPing` 回 pong 的本地链路延迟 < 1ms（pong 在 ping 出队后立即返回），3s 是活连接所需的 10⁶ 倍余量；(b) 介于 handshake 5s 窗口与 heartbeat 20s 周期之间，留有清晰边界；(c) 用户视角"看到 web UI 桥离线 → 重连 → 桥上线"的总体验链路在 3s 内完成，无可感暂停。注意与 `PONG_TIMEOUT_MS = 30_000`（heartbeat 30s×3 = 90s stale）**正交**：前者是"现役 bridge 是否存活"的一次性确认；后者是"heartbeat 周期内是否有应答"的循环判定。两常量在 `routeOpenMessage` 与 `tickHeartbeat` 各管各的账目。
  3. **挑战期边界语义**：
     - **挑战期第二个新桥 → 立即拒绝**——`handleHandshake` 先查 `this.challenge !== null`（先到先得），命中直接 `duplicate_bridge` 拒掉；避免多桥并发挑战互踢。
     - **挑战期旧桥主动断开 → 跳过 stale 广播直接纳新**——`handleDisconnect` 走 `ch.oldWs === ws` 分支，调 `resolveChallenge(false, nonce, /*broadcastStaleForOld*/ false)`；`resolveChallenge` 的 `broadcastStaleForOld` seam 是为这一边界保留的——若旧桥是用户主动 kill（操作者已知它死了），再发 stale → connected 闪烁会让 web UI bar 抖一下；操作者行为不应触发 stale 路径。
     - **挑战超时后迟到 pong → 安全 no-op**——`resolveChallenge` 用 `expectedNonce` 守门（`ch.nonce !== expectedNonce` → 早返），nonce 已清账 + 挑战已 null + 状态机已回退，迟到 pong 进 (b)/(c) 桶自然 fallback。worker 单测 9 钉死。
     - **挑战期新桥停放期接管其 5s handshake timer**——`startChallenge` 第一步 `clearTimeout(newMeta.handshakeTimer); newMeta.handshakeTimer = null`，把 challenger 的 5s 预算收归 challenge 账目下；3s 解决后 challenger 要么被 `resolveChallenge(true)` 路径 `sendTerminalError` 关闭（无需 5s 计时器），要么被 `resolveChallenge(false)` 路径 promote（promote 时清账）。
  4. **卫生缺陷一并闭合**——(a) `tickHeartbeat` stale 分支补 `webs.delete(ws)`（在 `ws.close` 前，与 `handleDisconnect` 的删除顺序对齐）；(b) `tickHeartbeat` 循环 per-connection try/catch（异常按死连接清理——clear bridge slot + broadcast stale + webs.delete + best-effort close——不中断循环）。这两点即使没有主因也是必须的清理缺陷，闭环必须在此一并落实。worker 单测 7/8 钉死。
  5. **bridge 侧 `attempt` 重置时机——`handshakeConfirmed` 门控**——`packages/bridge/src/client.ts` 改造为：(a) `handleOpen` 不再 `attempt = 0`（仅 `handshakeConfirmed = false` + 发 handshake + arm idle deadline）；(b) `handleMessage` 首个 `safeParse` 成功的 inbound envelope 经 `handshakeConfirmed` 门控 `attempt = 0` 并打 `"handshake confirmed by server"` 日志。语义：解析失败不刷新（与 [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] §决策.3 同哲学——「服务器狂发坏帧本身即病态信号」是当前实现的有意选择）。效果：1008 拒后退避指数增长至 30s cap（800/1600/3200/6400/12800ms 5 周期 → 30s 平尾）；正常重连握手确认后归零，后续闪断仍从 1s 起步。bridge 单测 5e（连续 1008 钉死指数增长）+ 5f（首解析成功归零 + 下次断开从 attempt 1 起步）钉死。
  6. **wire 协议零变化**——`control/ping` / `control/pong` / `duplicate_bridge` / `bridge_status` 帧全部复用既有结构；`bridge_status.reason` 枚举复用既有 `'stale'` / `'connected'`（挑战超时踢旧即发 `reason:'stale'`），不新增 reason；web / shared 零改动；不启用 Hibernation（维持 M2 决策）。
  7. **测试基建**——worker 测试基建从零搭建：`worker/vitest.config.ts` + `worker/src/__tests__/fake-ws.ts`（`FakeWebSocket` / `fakeWebSocketPair` 工具）+ `worker/src/__tests__/room.test.ts` 11 条用例（覆盖挑战 + pong 拒新 / 挑战超时踢旧纳新 / 挑战中旧桥断立即纳新 / 挑战中新桥断取消 / 第三桥立即拒 / 双 nonce 独立 / stale 清理完整 / send 异常不杀 tick / 迟到 pong 安全 / 标准断开清理 / heartbeat pong 回归）。

- 影响：
  - **worker 代码侧**：`worker/src/room.ts` 新增 `CHALLENGE_TIMEOUT_MS = 3_000` 常量 + `ConnMeta` 新增 `challengeNonce` / `challengeSentAt` 两字段 + `Room` 新增 `private challenge: { oldWs, newWs, nonce, timer, startedAt } | null` 状态 + `handleHandshake` duplicate 检查改两路（`this.challenge !== null` 立即拒；`this.bridge !== null && this.bridge !== meta.ws` 启动挑战）+ `startChallenge` / `resolveChallenge` 两个新私有方法 + `routeOpenMessage` pong 处理改三桶（挑战命中 / heartbeat 命中 / 不命中转发）+ `tickHeartbeat` 加 per-connection try/catch + stale 分支补 `webs.delete(ws)` + `handleDisconnect` 挑战相关分支两个（`ch.newWs === ws` 取消挑战；`ch.oldWs === ws` 立即纳新 + `broadcastStaleForOld=false`）。测试基建：`worker/vitest.config.ts` 新建 + `worker/src/__tests__/fake-ws.ts` 新建（`FakeWebSocket` 实现 `addEventListener` + `send` + `close` 三件套 + 工具模拟 helper）+ `worker/src/__tests__/room.test.ts` 新建 11 条用例。
  - **bridge 代码侧**：`packages/bridge/src/client.ts` 新增 `private handshakeConfirmed = false` 字段 + `handleOpen` 改为仅 `handshakeConfirmed = false` + 发握手 + arm idle（不再 `attempt = 0`）+ `handleMessage` 首个 `safeParse` 成功路径新增 `handshakeConfirmed` 门控归零 + `"handshake confirmed by server"` 日志。新增 `packages/bridge/src/__tests__/client.test.ts` 用例 5e（连续 1008 指数退避钉桩）+ 5f（首解析成功 attempt 归零 + 下次断开从 1 起步）。
  - **web / shared 零改动**——web 端 WsClient 不感知 DO 挑战式接管；shared 不增 schema 字段；`CONTROL_TYPES` 字面量不变。
  - **wire 协议零变化**——`control/ping` / `control/pong` / `duplicate_bridge` / `bridge_status` 帧结构不变；`bridge_status.reason` 枚举 `'connected' | 'closed' | 'stale'` 不新增；envelope schema 锁版承诺不变。
  - **向后兼容**：
    - **DO 对旧版 bridge 完全兼容**——旧 bridge 照常应答挑战 ping（bridge `replyToPing` 路径不变）；旧 DO 对新 bridge：新 bridge 重连仍会被老 DO 拒直到 90s stale 触发，行为与 bug 前一致——即 bridge / worker 可独立升级，无协同部署要求。
    - **新 DO 对新 bridge 完全兼容**——本 ADR 的核心修复路径。
    - **用户行动**：bridge / worker 可**独立升级**——worker 先上即解决拒绝循环（挑战式接管在 DO 侧，bridge 不感知）；bridge 端退避修复后上只是少锤服务器（避免无谓重连开销）。建议两条同步上，效果最优。
  - **文档同步落地**（本 ADR 同步修订文档库）：
    - [[architecture/protocol/control.md]] 顶部修订注记追加本轮条目 + §1 handshake duplicate 规则改为挑战式接管语义 + §4 bridge_status 触发时机补挑战超时路径 + §8 error 表 `duplicate_bridge` 触发条件修订 + §配套常量表新增 `CHALLENGE_TIMEOUT_MS = 3_000` 行（含与 `PONG_TIMEOUT_MS = 30_000` 正交辨析）+ 新增 §10「DO 侧 duplicate-bridge 挑战式接管」节（仿 §9 接收侧 read-idle 判死节结构：应用模型 / 机制 / wire 不变 / web 端不变 / 向后兼容）。
    - [[current-state.md]] 「测试基线」段：单测 691 → 704（shared 136 + bridge 372 + web 185 + **worker 11**，worker 从零新建）+ commit 引用更新为 `252fef6` + 修正 A' 修补工作区未提交的过时表述（A' 已随 `6763901` + `8ccbe4f` 入库，本地 main 领先 origin/main 4 个 commit 未 push：`8bf630d` / `6763901` / `8ccbe4f` / `252fef6`）+ 「最近变更」节顶部新增 2026-09-10 本轮条目。
  - **测试基线（2026-09-10 实施期）**：单测 **691 → 704**（+13：bridge 370 → 372 = 5e/5f +2；worker 0 → 11 = 从零新建）/ 集成 **32/32** 零回归 / e2e **8/8** 零回归 / lint 0 error（5 warnings 为 web WsClient pre-existing）/ typecheck 4/4 / `pnpm -r build` 绿。
  - **review 结论（2026-09-10）**：**0 Critical / 2 Warning 全修**（W1 = 误导性注释——`startChallenge` JSDoc 的「oldMeta.phase === 'open'」措辞改为「oldMeta.phase 任意即可——`handleHandshake` 调用点已限定」；W2 = 测试定时器泄漏——`useFakeTimers()` 用例每个 afterEach `vi.useRealTimers()` 收口）/ **5 Suggestions 中 4 修 1 留**：S1 = 防御注释与断言加固（已修）/ S2 = `tickHeartbeat` per-connection catch 拆 `tickOneConnection` 提取（已修）/ S3 = stale 分支 + tick catch 双层 `webs.delete` 去重（已修）/ S4 = `broadcastStaleForOld` seam 加注释 + 误用例警告（已修）/ **S5 = 本 ADR 落档**。
  - **commit**：最终 `252fef6`（amend 后终版；最初 `4070c93`，review 修复轮 amend 合并）。修复性质：**在线热修复**，直接落在 M4 收官后，无对应里程碑任务文件（M4 已于 2026-09-10 §10 手测验收收单）。
  - **与 ADR-0001 协同**：本 ADR 不改 [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]] 的三组件拓扑 + Cloudflare DO 中转结构；仅在 DO 侧 duplicate 检查语义层做加固——「同一 token 只能有一个活 bridge」的应用模型不变，实现层把「活」字补回。
  - **与 ADR-0011 正交协同**：[ADR-0011] 管 bridge 端读空闲判死（bridge 进程内管理 WSS 连接，90s 无 inbound frame → 关闭重连）；本 ADR 管 DO 端 duplicate 判活（DO 进程内管理 bridge 槽位，duplicate 命中时用 3s 挑战确认旧 bridge 是否真活）。两者**互不覆盖**——ADR-0011 让"bridge 自身进程"知道"server 是否还在推数据"；本 ADR 让"server"知道"占着 bridge 槽位的 ws 是否真活"。前者是 bridge 端的健康监测；后者是 server 端的活性确认。前者走 `control/ping` + `control/pong` 在 `pingIntervalMs=20s`/`pongTimeoutsBeforeDead=3`/`idleTimeoutMs=90s` 路径；后者走同帧 `control/ping` 但走独立 `challengeNonce`/`CHALLENGE_TIMEOUT_MS=3s` 一次性预算路径。两路径在 worker `room.ts` 同文件但完全不同的字段与流程，互不干扰。
  - **与 ADR-0003 协同**：本 ADR 让 idle / spawn / 进程级 5min 判死（[[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]]）与 WSS 连接级判死（ADR-0011 + 本 ADR）三层一起构成立体存活模型——pi 子进程层 5min idle / bridge WSS 层 90s read-idle / DO bridge 槽位层 3s challenge 一次性探测。

## 双向引用

- [[architecture/protocol/control.md#1-handshake]] —— §1 handshake duplicate 规则修订（挑战式接管语义）。
- [[architecture/protocol/control.md#4-bridge_status]] —— §4 bridge_status 触发时机补挑战超时路径（复用 `reason:'stale'`）。
- [[architecture/protocol/control.md#8-error]] —— §8 error 表 `duplicate_bridge` 触发条件修订。
- [[architecture/protocol/control.md#配套常量]] —— §配套常量表新增 `CHALLENGE_TIMEOUT_MS = 3_000` 行 + 与 `PONG_TIMEOUT_MS = 30_000` 正交辨析。
- [[architecture/protocol/control.md#10-do-侧-duplicate-bridge-挑战式接管]] —— 新增 §10 挑战式接管节（应用模型 / 五条机制 / wire 不变 / web 端不变 / 向后兼容）。
- [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]] —— 三组件拓扑 + Cloudflare DO 中转；「同一 token 只能有一个活 bridge」的应用模型承载点。
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— `PiProcessManager.IDLE_TIMEOUT_MS = 5 * 60_000`（5min 空闲杀 pi 子进程）；与本 ADR `CHALLENGE_TIMEOUT_MS = 3_000` 层级不同但共同构成立体存活模型。
- [[architecture/decisions/0011-bridge-receiver-side-read-idle-deadlock.md|ADR-0011]] —— bridge 接收侧 read-idle 判死（bridge 端读空闲判死，90s）；与本 ADR DO 端 duplicate 判活（3s challenge 一次性探测）**正交协同**——前者管 bridge WSS 连接层，后者管 DO bridge 槽位层。
- [[current-state.md#最近变更]] —— 2026-09-10 条目落地（在线热修复，无对应里程碑任务文件）。
- [[current-state.md#任务看板]] —— 测试基线更新 691 → 704（worker 从零新建 11 条）。
- `worker/src/room.ts` —— 实施承载点（`CHALLENGE_TIMEOUT_MS = 3_000` + `startChallenge` / `resolveChallenge` + `ConnMeta.challengeNonce`/`challengeSentAt` + `routeOpenMessage` pong 三桶 + `tickHeartbeat` per-connection try/catch + stale 分支 `webs.delete` 补全 + `handleDisconnect` 挑战相关分支两个）。
- `worker/src/heartbeat.ts` —— 现有 heartbeat 逻辑不变（每 20s 直发 ping + 30s×3 stale 规则），与本 ADR 挑战探测**账目独立**。
- `worker/vitest.config.ts` + `worker/src/__tests__/fake-ws.ts` + `worker/src/__tests__/room.test.ts` —— 测试基建从零搭建，11 条用例钉死挑战 + pong / 挑战超时 / 挑战中旧桥断 / 挑战中新桥断 / 第三桥 / 双 nonce 独立 / stale 清理 / send 异常 / 迟到 pong / 标准断开 / heartbeat pong 回归。
- `packages/bridge/src/client.ts` —— bridge 侧改造承载点（`handshakeConfirmed` 门控 + `handleOpen` 不再归零 + `handleMessage` 首个 `safeParse` 成功归零 + `"handshake confirmed by server"` 日志）。
- `packages/bridge/src/__tests__/client.test.ts` —— 用例 5e（连续 1008 指数退避钉桩）+ 5f（首解析成功 attempt 归零 + 下次断开从 1 起步）。