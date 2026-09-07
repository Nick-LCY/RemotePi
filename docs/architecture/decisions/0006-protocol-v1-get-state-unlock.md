# 0006. 协议 v1 control 家族破锁：新增 `get_state`

- 日期：2026-09-05
- 状态：已接受
- 背景：
  协议 v1（envelope / control / pi）锁版承诺"v1 存续期内 control 家族不再新增 type"，与 M3 PRD 的目标（web 端握手后必须能查询会话态 + blocked_on）形成冲突。

  M3 PRD `prds/m3-single-session.md` §修订注记（2026-09-05）原文列出破锁理由：
  1. v1 无第三方消费者（仅三端锁步部署）；
  2. `get_state` 是 web 端握手后必需的"会话态查询"，与 `session_list` 同形态（web → bridge，回执走 `result`），不引入新的转发/语义负担；
  3. 不破锁则 web 端只能用 `get_messages` 间接探测状态，浪费带宽 + 引入冗余字段；
  4. envelope 演进规则 (b) "control 家族 v1 内不再新增 type" 同步改为"除已破锁的 `get_state` 外不再新增"。
- 决策：
  1. **破锁**：control 家族由 8 个 type 增至 9 个 type，新增 `get_state`（payload `{}`，回执走 `result`）。详见 M3 PRD §1.1。
  2. **演进规则 (b) 同步修订**：`envelope.md` 中"v1 内不再新增 type" → "除 `get_state` 外不再新增"。
  3. **回执 data 形状**：`result.data = { phase, blocked_on? }`（blocked_on 与 §1.3 BlockedOnEntry 同形）。`phase` 取值沿用 5 相位枚举（不破锁）。
  4. **错误码集合**：复用 control.md §8 已锁版的 6 个 code，`get_state` 失败时不引入新 code。
  5. **bidirectional 引用**：本 ADR 与 envelope.md 锁版承诺清单、ADR-0003 末尾标注此破锁；确保后续维护者能双向定位决策源头。

- 影响：
  - shared 测试需新增 get_state payload 解析 / result 回执解析 / 非法 phase 拒（约 5 条用例，详见 M3 PRD §6.1）。
  - envelope.ts CONTROL_TYPES 字面量同步追加 `'get_state'`。
  - worker 维持中间层规则（透传 get_state + 透传 result 回执），零业务改动。
  - 与 ADR-0003 协同：get_state 是其"恢复仪式"（双查询之一）的载体；与 ADR-0004 协同：get_state 回执中的 `blocked_on` 是弹窗模型状态帧驱动的真相源。

## 双向引用

- [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]] —— 锁版承诺清单（control 8 → 9 type）与演进规则 (a)/(b) 同步修订的承载点。
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— 末尾注明：恢复仪式中 web 端握手后并行发 `pi/get_messages` + `control/get_state`（本 ADR 增补的 `get_state` 即其中之一）；自主 kill 标记 + exited 后 spawn 触发集 + get_state 永不 spawn 协同语义在此协同。
- [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] —— 末尾注明：弹窗模型升级为 `session_state.blocked_on` 状态帧驱动；`get_state` 回执中的 `blocked_on` 字段是弹窗模型状态帧驱动的真相源之一（与事件流 `pi/event` 双路并行）。
- [[architecture/decisions/0007-host-shared-pi-agent-dir.md|ADR-0007]] —— 共享 session 的恢复仪式由本 ADR 增补的 `get_state` 承载；web 端接管的最近会话即宿主机共享 agent 目录下的会话（与 M3 隔离方案的分歧点）。

