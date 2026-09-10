# 0011. bridge 接收侧 read-idle 判死：移除 bridge 主动 ping，改读侧滑动窗口

- 日期：2026-09-10
- 状态：已接受
- 背景：
  M2 落地时 bridge 与 web 互喊 ping/pong：双方各自 20s 发 `control/ping`，30s × 3 无 pong 即判定对端已死。链路正常时无感，但在 web 离线场景暴露根本性缺陷——

  缺陷链路：

  1. bridge 按 20s 节奏主动发 `control/ping {nonce: nanoid(8)}` 给 DO；
  2. DO `forwardToOpposite`（worker `room.ts:472-483`）将 bridge 的 ping 转发给所有网页；
  3. **网页离线**（用户关浏览器 / 切网络 / 手机锁屏）→ DO 的 web 连接不存在或不可达 → 转发操作走 no-op 静默丢弃；
  4. bridge 30s 内收不到 `control/pong` → 30s × 3 累计 90s 后 → bridge 判定 web 已死 → 主动 close；
  5. bridge close → DO 收 close → bridge 连接断开 → `bridge_status{online: false, reason: 'closed'}` 广播给所有 web；
  6. bridge `handleClose` 触发指数退避重连 → 重连成功后 DO 仍按 20s 节奏发 ping 给 bridge → bridge 又按 20s 发 ping 给 DO → 同样的 web 离线转发 no-op → 又累计 90s → 又 close → **无限退避重连循环**。

  缺陷本质：违背应用模型。**bridge 是常驻后台工人**（长连 worker DO，监管多个 pi 子进程），**web 是随上随下的遥控器**（用户开浏览器就连，关浏览器就走）。bridge 把 web 的死活当作自己的健康信号是角色错位——web 离线与 bridge 存活是正交事件；web 离线不应触发 bridge 自身重连循环，更不应连带 worker `bridge_status` 反复广播。

  实测验证：本地手动 `kill -STOP` bridge 进程观察后台，`bridge_status` 频繁在 `online:false reason:'closed'` 与重连间抖动，wss 日志可见 90s 一次的 close + 重连串——此缺陷在 M2 收官后长期存在，仅因 M2/M3/M4 验收期间 web 与 bridge 总是一起被使用而未暴露为用户感知缺陷。

- 决策：
  采用 **方案 A'：bridge 接收侧 read-idle 判死**——bridge 不再主动发 `control/ping`；改在 bridge 端维护一个「最近一次解析成功的 inbound envelope」时间戳，滑动窗口超时即判死 close + 退避重连。落地点：`packages/bridge/src/client.ts` 新增 `IDLE_TIMEOUT_MS = 90_000`（≈ DO 20s 心跳 ×3 + 余量）+ 每次收到任何解析成功的 inbound envelope 刷新计时器 + 超时 → `warn "no inbound frame for 90000ms, closing"` → `ws.close(1000, 'idle timeout')` → 现有 `handleClose` 路径生效（close code 1000 走正常重连；1008 仍保留协议 fatal 关闭，语义不变）。`case 'ping': replyToPing` 原样保留（DO `heartbeat.ts` 每 20s 直发 ping 给 bridge，不回会被 DO 30s×3 判死）。`case 'pong'` 静默 no-op（bridge 无 pending nonce）。选项 `pongTimeoutMs` 改名 `idleTimeoutMs`；删除 `pingIntervalMs` / `pongTimeoutsBeforeDead` 两个旧选项。

  决策要点：

  1. **应用模型 vs 实现细节的边界**——bridge 是常驻工人 / web 是遥控器的应用模型早在 M1 topology ADR 就已确立（[[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]]），但 M2 实施期 ping/pong 互喊的 client.ts 实现未把这条模型边界落到客户端——bridge 在 web 离线时无法存活是该模型在客户端实现层的首次兑现。
  2. **wire 协议零变化**——`control/ping` / `control/pong` 帧结构不变（nonce 可选 / 必填规则不变）；DO `heartbeat.ts` 每 20s 直发 ping 给 bridge 的行为不变；中间层 `routeOpenMessage` 的 default 转发分支不变；新 bridge 对老 web 完全兼容，老 bridge 对新 worker 也完全兼容（DO 仍按 30s×3 规则对待旧 bridge 发的 ping）。
  3. **滑动窗口覆盖范围**——`IDLE_TIMEOUT_MS` 计时器刷新条件 = 任何**解析成功**的 inbound envelope，包括 `control/ping`（DO 直发或 web 转发）/ `control/pong` / `control/handshake` / `control/bridge_status` / `control/result` / `control/error` / `control/session_state` / `control/session_list` / `control/get_state` 回执 / 全部 pi 家族 envelope。**故意排除解析失败帧**——reviewer S5 注记「服务器狂发坏帧本身即病态信号」是当前实现的有意选择，若改「任何 inbound 都刷新」会让真正死掉的连接借坏帧延命。本决策采纳当前实现，不追加刷新坏帧的语义。
  4. **90s 阈值的依据**——等于 DO 主动判死阈值（30s × 3 = 90s）+ 余量：bridge 不主动 ping 后，bridge 端 inbound 流完全由 DO 20s 心跳驱动，90s ≈ 3 个 DO 心跳周期 + jitter 余量——足够宽容单个心跳丢失而不误判，足够紧凑让真正死掉的连接被及时 reap。
  5. **close code 选择**——`ws.close(1000, 'idle timeout')` 走正常 close code（1000 = normal closure）让现有 `handleClose` 退避重连路径生效；1008 仍保留协议 fatal 关闭（[[architecture/protocol/control.md#配套常量|control.md §配套常量]]），与 read-idle 判死语义正交。
  6. **用户行动提示**——本地跑旧版 bridge 的实例需择机重启才生效（重启时加载新版 `packages/bridge`，行为自动切到接收侧 read-idle）；旧版 bridge 在 5min 内连续触发旧 30s×3 判死 → 无限退避重连循环的缺陷随重启一并消失。

  备选否决：

  - **备选 B：DO 对 bridge 的 ping 代答**——DO 收到 bridge 的 ping 后，若 web 离线，立即用 DO 自己 nonce 的 pong 直接回 bridge（绕开 web）。理由：保留原 30s×3 互喊规则不变，仅在中间层补一个 web-offline fast-path。
    - **否决理由一**：需破「中间层原样转发」语义——`worker/room.ts:472-483` 的 `forwardToOpposite` 历来是「收到什么转发什么，不生成新内容」（这是中间层薄壳设计的核心约束，详见 ADR-0001 §决策）。让 DO 自己生成 `control/pong` 替代 web 应答，等于让中间层首次「伪造对端响应」，需另立 ADR 论证此破例的合理性与未来边界。
    - **否决理由二**：改动面落在 worker 端——worker 是生产部署的稳定性关键节点，bridge 端纯客户端行为变更可以单点灰度，worker 改动必须与 bridge 锁步部署；用户裁定 bridge 单端切换 + 文档注记的方式成本更低。
    - **否决理由三**：本质仍把「web 离线」当作 bridge 的健康信号——与应用模型错位的根因（bridge 不应关心 web 死活）未消除，仅用中间层代答掩盖症状；web 离线时 bridge 仍按 30s×3 节奏判死，只是死不了。
  - **备选 C：bridge 移除所有心跳 / 不判死**——bridge 完全依赖底层 TCP keepalive + 自然断连检测。**否决**：TCP keepalive 默认 2 小时，远超用户对「bridge 看起来死了」的容忍度；自然断连（FIN / RST）在中间网络设备静默掐断时不会触发（这正是 ping/pong 互喊最初存在的理由），会回退到 M2 之前「bridge 永远 alive 但实际半死」的状态。
  - **备选 D：bridge 仅判 ping/pong 流，不判其他 envelope**——只对 ping/pong 维护滑动窗口，忽略其他 envelope。**否决**：bridge 业务本就依赖 server 持续推送（session_state / event 流等），如果 server 不推业务帧但仍能回 pong，bridge 仍处于「半活」状态，与方案 A' 滑动窗口覆盖全部 inbound envelope 的语义不符。

- 影响：
  - **bridge 代码侧**：`packages/bridge/src/client.ts` 删除 `PING_INTERVAL_MS` / `PONG_TIMEOUTS_BEFORE_DEAD` 常量与对应循环逻辑；`PONG_TIMEOUT_MS` 改名为 `IDLE_TIMEOUT_MS = 90_000`；新增 inbound envelope 解析成功路径上的计时器刷新逻辑 + 超时 → warn + close(1000) 路径。`case 'ping'` 仍 `replyToPing`；`case 'pong'` 静默 no-op（保留现有分支结构，不删逻辑）。选项名 `pongTimeoutMs` → `idleTimeoutMs`；删除 `pingIntervalMs` / `pongTimeoutsBeforeDead`。`packages/bridge/src/__tests__/client.test.ts` 新增 3 条用例（5b / 5c / 5d 编号沿用既有）：(a) 任意 inbound envelope 刷新 idle 计时器；(b) 90s 超时触发 close(1000, 'idle timeout')；(c) close 后续走 handleClose 退避重连路径。
  - **worker 零改动**——`worker/src/heartbeat.ts` 每 20s 直发 ping 给 bridge 的行为不变；30s × 3 判死规则不变（worker 不感知 bridge 是否主动 ping，DO 仍按 30s × 3 判死其对端）。
  - **web 零改动**——web 端 WsClient 仍按 20s 主动发 ping + 30s × 3 无 pong 判死旧规则；web 端对老版本 bridge 与新版本 bridge 完全兼容（web 不感知 bridge 是否主动 ping）。
  - **wire 协议零变化**——`control/ping` / `control/pong` 帧结构 / nonce 字段规则不变；中间层 `routeOpenMessage` default 转发分支不变；13 control type + 9 pi type 不变。
  - **向后兼容**：
    - **DO 对旧版 bridge 完全兼容**——旧 bridge 仍按 20s 节奏发 ping，DO 照常转发并按 30s × 3 规则对待；旧 bridge 不受影响。
    - **新 bridge 对老版本 web 完全兼容**——web 主动 ping 仍能被新 bridge 收到并回 pong（bridge 对 ping 应答路径未变）。
    - **bridge 切换无需 worker 配合部署**——纯客户端行为变更 + 文档注记；worker / DO / web 三端无需同步切换。
  - **用户行动**：本地跑旧版 bridge 的实例需择机重启才生效。**注**：bridge 默认无自动升级机制（systemd 服务不会自动 reload 新二进制），用户需主动 `systemctl restart remotepi-bridge` 或重启 bridge 进程；重启时加载新版 `packages/bridge`，行为自动切到 §决策 接收侧 read-idle。
  - **文档同步落地**（本 ADR 同步修订文档库）：
    - [[architecture/protocol/control.md]] 顶部修订注记 + §2 ping 备注 + §3 pong 规则修订 + §配套常量表新增 `IDLE_TIMEOUT_MS = 90_000` 行（含同名辨析） + 新增 §9「接收侧 read-idle 判死」节。
    - [[prds/m3-single-session.md]] §2.1 line 181 「心跳 / 重连时序常量维持代码常量（PING_INTERVAL_MS / PONG_TIMEOUT_MS 等）」更新为「bridge 客户端接收侧 read-idle 阈值 `IDLE_TIMEOUT_MS = 90_000`（bridge client 侧，详见 ADR-0011）；`PING_INTERVAL_MS` 已随 A' 移除；`PONG_TIMEOUT_MS` 已随 A' 改名为 IDLE_TIMEOUT_MS」，引用本 ADR。
    - [[current-state.md]] 「最近变更」节顶部加条目（2026-09-10，M4 验收期修补口径，因 M4 已于 2026-09-10 §10 手测验收收单）。
  - **测试基线（2026-09-10 实施期）**：单测 **688 → 691**（+3：5b / 5c / 5d 三条）；集成 **32/32** 零回归；e2e **8/8** 零回归；lint 0 error（5 warnings 均为 web WsClient pre-existing，非本改动引入）；typecheck 4/4；`pnpm -r build` 绿。
  - **review 结论**（2026-09-10）：**0 Critical / 0 blocking Warning / 5 Suggestions**（含 docs grep `IDLE_TIMEOUT_MS` 同名辨析提醒——已由本 ADR §影响「文档同步落地」段与 control.md §配套常量同名辨析段同步回应；含 safeParse 后才刷新 idle 的语义注记——已由本 ADR §决策.3 「故意排除解析失败帧」段同步回应）。
  - **与 ADR-0001 协同**：本 ADR 是 [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]] 「bridge 常驻 / web 随上随下」应用模型在 client.ts 实现层的首次兑现——bridge 端 ping/pong 互喊实现未把模型边界落到客户端，是 M2 实施期的细节偏差，本 ADR 显式补回模型语义。
  - **与 ADR-0003 辨析（同名 `IDLE_TIMEOUT_MS`）**：文档库当前存在两处 `IDLE_TIMEOUT_MS`——(a) `PiProcessManager` 5 分钟空闲杀 pi 子进程常量（[[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] §3，作用域 = 每个 pi 子进程 manager，逐会话复制）；(b) `BridgeClient` 90 秒接收侧 read-idle 判死常量（本 ADR §决策，作用域 = bridge WSS 连接本身）。**两者层级不同**：(a) 在 bridge 进程内管理子进程；(b) 在 bridge 进程内管理 WSS 长连接。实现时各自模块内常量化（`packages/bridge/src/pi-process.ts` 与 `packages/bridge/src/client.ts` 分别导出），不共享。文档侧由 [[architecture/protocol/control.md#配套常量|control.md §配套常量]]「同名辨析」段统一注明。

## 双向引用

- [[architecture/protocol/control.md#2-ping]] —— §2 ping 方向与规则修订（bridge 不再主动发）；配套原样转发语义不变。
- [[architecture/protocol/control.md#3-pong]] —— §3 pong 规则修订（bridge 不再执行 30s×3；收 pong 静默 no-op）。
- [[architecture/protocol/control.md#9-bridge-接收侧-read-idle-判死]] —— 新增 §9 接收侧 read-idle 判死机制（应用模型 / 四条机制 / wire 不变 / web 端不变 / 向后兼容）。
- [[architecture/protocol/control.md#配套常量]] —— §配套常量表新增 `IDLE_TIMEOUT_MS = 90_000` 行 + 同名辨析段。
- [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]] —— bridge 常驻 / web 随上随下的应用模型承载点；本 ADR 是该模型在 client.ts 实现层的首次兑现。
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— `PiProcessManager.IDLE_TIMEOUT_MS = 5 * 60_000`（5 分钟空闲杀 pi 子进程）；与本 ADR `BridgeClient.IDLE_TIMEOUT_MS = 90_000` 同名但作用域不同，详见 ADR-0011 §影响段「与 ADR-0003 辨析」。
- [[prds/m3-single-session.md#§2.1 配置文件|M3 PRD §2.1]] —— line 181 「心跳 / 重连时序常量维持代码常量」原文更新为本 ADR 落地的现役常量。
- [[current-state.md#最近变更]] —— 2026-09-10 条目落地（M4 验收期修补口径，因 M4 已于 2026-09-10 §10 手测验收收单）。
- `packages/bridge/src/client.ts` —— 实施承载点（`IDLE_TIMEOUT_MS = 90_000` 常量 + inbound envelope 解析成功路径上的计时器刷新 + 超时 close(1000, 'idle timeout') 路径）。
- `worker/src/heartbeat.ts` —— DO 心跳直发 ping 给 bridge（每 20s / 30s × 3 判死规则不变；与本 ADR 互补：DO 主动 ping + bridge 接收侧 read-idle 是同一存活信号的两端）。
- `worker/src/room.ts:472-483` —— `forwardToOpposite` 原样转发（不再收到 bridge→DO 的 ping 帧时该路径在 bridge→DO 方向空跑，业务零影响；web→DO 方向仍正常工作）。
