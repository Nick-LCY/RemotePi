---
prd: prds/m4-multi-session.md
status: todo
---
# 任务：web WebState 按 session 分桶 + 入站按 session 路由 + 出站自动带 session（裁定 A：session_list 自动带 currentWorkDir）+ ChatView per-session + RecoveryGate per-session + 跨会话 blocked_on 隔离

## 目标
按 [[prds/m4-multi-session.md|PRD §4.3 + §4.4 + §4.5 + §4.6 + §9.5]] 升级 web store + UI 接线：`WebState` 从单会话字段升级为按 session 分桶（`sessions: Record<sessionKey, SessionBucket>`）；入站分发按 `envelope.session` 字段写入对应桶；出站组装自动从 `currentSessionKey`（来自 hash）填 `session` 字段；`session_list` 自动从 `currentWorkDir` 填 `payload.work_dir`（裁定 A 操作惯例必带）；ChatView per-session 视图；RecoveryGate per-session（每个 sessionKey 独立一份 `RecoveryGate`，Map<sessionKey, RecoveryGate>）；跨会话 blocked_on 隔离（DialogHost 按 session 分桶）。

关键要点：

- **`WebState` 升级**（PRD §4.3）：
  ```ts
  interface WebState {
    // 全局
    bridgeStatus: BridgeStatusInfo | null;
    connState: ConnState;
    workDirs: string[]; // 镜像 bridge state.json（07-web-choice-page 已就绪）
    currentWorkDir: string | null; // 镜像当前 hash 的 work_dir，供出站自动填 session_list 等命令
    // 按 session 分桶
    sessions: Record<sessionKey, SessionBucket>;
    sessionList: SessionListEntry[]; // ChoicePage level=2 用（仅当前 work_dir 下会话）
  }
  interface SessionBucket {
    messages: AgentMessage[];
    streamingDraft: StreamingDraft | null;
    queue: QueueState;
    sessionPhase: SessionPhase;
    blockedOn: BlockedOnEntryPayload[];
    workDir: string; // 镜像 session_state.payload.work_dir
    recovery: 'pending' | 'ready' | 'error'; // 该 session 的 RecoveryGate 状态
  }
  ```
- **入站分发**（按 envelope.session 路由）：
  - WsClient 在 `case 'session_state':` / `case 'snapshot':` / `case 'command_result':` / `case 'event':` 时按 `envelope.session` 字段写入 `sessions[<key>]`（无 session 字段时回退 M3 单桶行为）
  - `session_state.payload.work_dir` 镜像到 `SessionBucket.workDir`
- **出站组装**：
  - 所有 pi 命令 / control `get_state` / `session_list` 自动从当前 `currentSessionKey`（来自 hash）填 `session` 字段
  - `session_list` 自动从 `currentWorkDir` 填 `payload.work_dir`（裁定 A 操作惯例必带）
- **多端各看各的 + 同看同步**（PRD §4.4）：
  - 广播语义不变（沿用 M3）；web store 入站按 `envelope.session` 写入对应桶
  - A 端看 session X、B 端看 session Y → 各自 UI 只渲染自己的 `sessions[X]` / `sessions[Y]`（互不可见）
  - A / B 同看 session X → 各自 UI 渲染同一桶 = 同步（与 M3 等价）
  - ChoicePage level=2 列表行 status 徽章由 `sessions[<key>].sessionPhase` 派生（每收到对应 session 的 session_state 都更新）——不需要轮询
- **弹窗归属会话**（PRD §4.5）：
  - DialogHost（M3 §4.2）从单 blockedOn 数组升级为按 session 分桶：`Record<sessionKey, BlockedOnEntryPayload[]>`
  - 当前 session 的弹窗按 M3 既有逻辑显示
  - 切到后台 session 时该 session 的 blockedOn 入桶但 UI 不显示（沿用 M3 "无乐观 UI" 规则：dialog 提交 / 取消 / 超时后才移除）
  - 切回该 session 时 DialogHost 重新 mount 弹窗（按 blockedOn 当前快照渲染），倒计时按 `Date.now() - entryEnqueuedAt - timeout` 计算（剩余时间，需在 session_state 入桶时记录 enqueuedAt 时间戳——可选字段）
  - **多端先答者胜**（沿用 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] §补注 3）：多端同看 session X，A 先提交 → bridge 处理 → broadcast session_state（blocked_on 移除该 id）→ B 端的桶也移除 → B 端 dialog 自动收起 + 收 `request_expired`
- **ChatView per-session**（PRD §4.6）：
  - ChatView（M3 §4.3）接 `session: sessionKey` prop，所有 store 读写走 `sessions[session]`
  - 输入框禁用 / 可用、agent_settled 提示、queue_update 显示、abort / steer / follow_up 按钮全部 per-session
- **RecoveryGate per-session**：
  - 每个 sessionKey 独立一份 RecoveryGate（Map<sessionKey, RecoveryGate>）
  - 进入该 session 时创建；离开不销毁（暂存以备切回时避免重发仪式）
  - "未加载"（`status: 'unknown'`）的 session：进入触发新仪式（与 M3 同路径：exited 时 get_messages 触发带 `--session` 的 spawn）

## 完成标准
- [ ] `packages/web/src/store.ts`：`WebState` 升级为 `sessions: Record<sessionKey, SessionBucket>` + `currentWorkDir: string | null`；既有 M3 字段（`bridgeStatus` / `connState` / `workDirs`）保留
- [ ] `SessionBucket` 类型定义完整：messages / streamingDraft / queue / sessionPhase / blockedOn / workDir / recovery 7 字段
- [ ] `packages/web/src/ws/WsClient.ts`：入站分发按 `envelope.session` 字段写入 `sessions[<key>]`（4 类 envelope：session_state / snapshot / command_result / event）；`session_state.payload.work_dir` 镜像到 `SessionBucket.workDir`
- [ ] `packages/web/src/ws/WsClient.ts`：出站组装自动从 `currentSessionKey` 填 `session` 字段；`session_list` 自动从 `currentWorkDir` 填 `payload.work_dir`（裁定 A）
- [ ] `packages/web/src/ChatView.tsx`（M3 §4.3）：接 `session: sessionKey` prop；store 读写走 `sessions[session]`；输入框 / agent_settled / queue_update / abort / steer / follow_up 全部 per-session
- [ ] `packages/web/src/recovery.ts`：RecoveryGate per-session（Map<sessionKey, RecoveryGate>）；进入该 session 时创建；离开不销毁（暂存以备切回）
- [ ] `packages/web/src/DialogHost.tsx`：按 session 分桶 `Record<sessionKey, BlockedOnEntryPayload[]>`；切到后台时 UI 不显示但入桶；切回时恢复显示 + 倒计时（按 `Date.now() - enqueuedAt - timeout` 计算）；enqueuedAt 时间戳记录到 session_state 入桶时
- [ ] **任务 06 C2 移交义务（详见下方）**——web M4 流程的所有 pi 命令与 `get_state` **必须携带 session 字段**；任务 08 落地后评估 `M3_LEGACY_KEY` auto-spawn 路径退役
- [ ] **测试**（PRD §9.5）：store 按 session 分桶（多 session 并行各自 phase / messages / blockedOn 独立）/ 切会话 dialog 归属切换 / enqueuedAt 倒计时计算 / RecoveryGate per-session 创建 + 暂存 / 出站自动带 session + work_dir / 入站按 session 路由
- [ ] 既有 M3 web 测试零回归（任务 06/07 行为不被破坏）
- [ ] `pnpm --filter @remotepi/web build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（schema 消费前置）
- 依赖 [[tasks/m4/03-shared-tests.md|03-shared-tests]]（协议测试覆盖）
- 依赖 [[tasks/m4/06-bridge-session-layer.md|06-bridge-session-layer]]（bridge 多 manager + status 字段 + pending 键控 + 广播 session_state 协同）
- 依赖 [[tasks/m4/07-web-choice-page.md|07-web-choice-page]]（ChoicePage level=2 + URL hash 三字段解析 + currentWorkDir 镜像）

## 参考
- [[prds/m4-multi-session.md|PRD §4.3 store 按 session 分桶]]
- [[prds/m4-multi-session.md|PRD §4.4 多端各看各的]]
- [[prds/m4-multi-session.md|PRD §4.5 弹窗归属会话]]
- [[prds/m4-multi-session.md|PRD §4.6 ChatView per-session]]
- [[prds/m4-multi-session.md|PRD §9.5 web 测试]]
- [[tasks/m3/06-web-chat.md|tasks/m3/06]] ChatView 基线
- [[tasks/m3/07-web-recovery.md|tasks/m3/07]] RecoveryGate 基线
- [[tasks/m4/01-web-recovery-timeout.md|01-web-recovery-timeout]] 5s 修复协同（RecoveryGate 升级）
- [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] §补注 3 多端先答者胜

## 任务 06 C2 移交义务（最小侵入）

**义务来源**：任务 [[tasks/m4/06-bridge-session-layer.md|06]] review C2 方案 a 文档化（commit `8200068`）+ 过渡性设计 JSDoc 互引（`BridgeSessionLayer.M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处已加）。**任务 08 是该路径的评估退役点**。

### 1. web M4 流程的所有 pi 命令与 `get_state` 必须携带 session 字段

- **强制约束**：任务 08 落地的 `WsClient` 出站组装逻辑（已在「出站组装」段描述——所有 pi 命令 / `get_state` / `session_list` 自动从 `currentSessionKey` 填 `session` 字段）必须**严格**保证 web M4 流程不发出 session-less envelope。
- **例外范围**：`M3_LEGACY_KEY` 兼容路径仅服务于 M3 token-only URL（`#<token>` 无 work_dir / session）——目前仅 e2e 3 场景（沿用 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] MVP）依赖该 URL。**M4 正常 web 流程不得依赖 session-less 命令**。
- **入站侧对应**：`M3_LEGACY_KEY` 键 manager 的 `session_state` 广播会带 `session: 'm3-legacy'`——web 按 session 分桶时该桶无消费者（无 UI 渲染、不影响任何状态）；web 端可不特殊处理 m3-legacy 桶（静默丢弃即可），但**不得**主动发送 session-less envelope 触发该路径创建。

### 2. 任务 08 落地后评估 M3-compat auto-spawn 路径退役

任务 08 完成后落地以下检查与处置（**最小侵入**，非阻塞本任务完成，但需在完成情况里交代结论）：

1. **检查 `M3_LEGACY_KEY` map 键 manager 是否仍存在**：
   - grep `M3_LEGACY_KEY` / `m3-legacy` / `resolveM3CompatManager` 在 `packages/bridge/src` 出现位置 → 确认仍由任务 06 引入的三处持有（导出常量 / `getOrCreateManagerForSession` 分支 5+6 / `resolveM3CompatManager` 自身）；
   - 评估 E2E 3 场景是否仍依赖 `#<token>` token-only URL 触发 M3-compat 路径（`tests/e2e/` 下的 spec 路径）。
2. **若 E2E 已迁移到带 session 字段**（任务 10 E2E 扩展范围内可能顺手迁移）→ 删除 `BridgeSessionLayer.M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处代码（JSDoc 已加互引方便移除）；删除 `BridgeSessionLayerOptions.defaultWorkDir` 字段 + `index.ts` 接线 `defaultWorkDir: config.work_dir` 一行；同步落档 [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] §影响段 + [[prds/m4-multi-session.md|PRD §修订注记]]（追加 2026-09-08 任务 08 退役评估条）。
3. **若 E2E 仍依赖 token-only URL** → 保留三处代码，但在 [[current-state.md|TODO/阻塞]] 追加挂账条目「M3_LEGACY_KEY 路径退役待 E2E 迁移（task 10 范围）」，与 任务 09 docs-sync 任务清单并列；任务 10 完成情况里确认 E2E 是否需扩展到带 session 字段。

### 3. 互引关系（本任务与任务 06 / 任务 09 / 任务 10）

- **任务 06 完成情况**——「C2 移交义务」段已写明本评估点与退役路径。
- **任务 09 docs-sync**——任务 06 review C2 文档化要求 `M3_LEGACY_KEY` JSDoc 互引，但**无需修改**任务 02 协议层 / ADR-0010（协议层不受 M3-compat 影响）；任务 09 只需校对 envelope.md / control.md / pi.md 是否需补「M3-compat 路径退役评估」段落——按任务 06 完成情况结论，若退役则补、若保留则不补。
- **任务 10 E2E 扩展**——`(d) 目录浏览` / `(e) 多端各看各的` / `(f) 跨会话 blocked_on 隔离` / `(g) 钉子 3 work_dir_remove 活会话` / `(h) 钉子 2 pending 键控` 5 新场景需带 `session` 字段——任务 08 web 落地后 E2E spec 默认带 session 字段，**不**依赖 `M3_LEGACY_KEY` 路径；任务 10 完成时统一交代 M3-compat 评估结论（退役 / 保留挂账）。