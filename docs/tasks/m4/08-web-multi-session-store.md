---
prd: prds/m4-multi-session.md
status: done
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
- [ ] **任务 07 W2 移交（详见下方）**——`WsClient.sendSessionList` 出站补 `envelope.session` 字段（来自 `currentSessionKey`）；JSDoc 「W2 注记」段从「task 08 必须在此补」改写为「已补」备忘；测试 1.6 追加 `session` 断言 + 新增 1.6b 镜像按 session 分桶隔离；`sessionList` 镜像由全局字段改为按当前 sessionKey 分桶
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

## 任务 07 W2 移交

**义务来源**：任务 [[tasks/m4/07-web-choice-page.md|07]] review 修复轮 W2 注记（commit `df22eef`）——`WsClient.sendSessionList()` JSDoc 钉死「task 08 必须在此补 `session` envelope 字段」，代码注记位置 `packages/web/src/ws/WsClient.ts` `sendSessionList` JSDoc 块已链 `docs/tasks/m4/08-web-multi-session-store.md#任务-07-w2-移交` 锚点（即本段）。

**移交内容**：M4 ChoicePage 阶段命令为 control 族，`session_list` 在 bridge 端自答（不经 manager 路由），任务 07 实施期**省略** `envelope.session` 字段当前安全——无 manager 歧义、无 stem 路由问题。但任务 08 落地后 web store 按 session 分桶 + 出站自动从 `currentSessionKey` 填 `session` 字段后，`session_list` 必须**同步**补该字段（否则与「所有 pi 命令与 `get_state` 必须携带 session 字段」的强制约束不一致，破坏控制族命令与会话归属的语义一致性）。

**实施点**（任务 08 完成标准新增一条）：

1. `WsClient.sendSessionList(workDir)` 出站组装逻辑改为：
   ```ts
   sendSessionList(workDir: string): string {
     const id = this.makeId();
     this.sendRaw({
       v: PROTOCOL_VERSION,
       kind: 'control' as const,
       type: 'session_list' as const,
       id,
       session: this.currentSessionKey, // 任务 08 新增——与既有「出站自动从 currentSessionKey 填 session」约定一致
       payload: { work_dir: workDir },
     });
     this._lastSessionListId = id;
     return id;
   }
   ```
2. JSDoc 顶部「Review 修复轮 W2 注记」段从「task 08 必须在此补」改写为「task 08 落地后已补 session 字段，与同段「出站自动带 session」约定一致」——注记段保留作为设计历程备忘。
3. 既有任务 08「入站分发按 `envelope.session` 路由」段已覆盖 `session_list` 回执按 session 分桶的镜像更新路径（`sessionList` 字段写入对应 session 桶而非全局字段，**仅当 `currentSessionKey === envelope.session` 时更新**——任务 07 实施期 `sessionList` 是全局字段，任务 08 需调整为按当前 session 镜像，避免跨 session 误路由）。
4. 测试：`__tests__/ws-client-choice-page.test.ts` 1.6「sendSessionList(work_dir) → payload.work_dir set（裁定 A 操作惯例）」用例追加断言 `envelope.session === currentSessionKey`；新增测试 1.6b「sendSessionList 后 web store sessionList 镜像按当前 sessionKey 分桶，跨 session 隔离」。
5. 与 [[tasks/m4/07-web-choice-page.md#完成情况|任务 07 完成情况]]「与任务 08 边界」段呼应：任务 07 实施期 `WsClient` 已留 stem 回填 stub（pending → 真实 stem 时触发 level2 重查）；任务 08 消费该 stub 时一并消费本段「按 session 分桶的镜像更新」语义。

**边界澄清**：本移交**不**覆盖 `list_directories` / `work_dir_*` / `get_state` 等其他出站命令——它们在任务 08「出站组装」段已有约定（自动从 `currentSessionKey` 填 session 字段，本任务一并落地），仅 `session_list` 因任务 07 实施期安全省略需 W2 移交明确。其他命令的 session 字段补齐在任务 08 任务清单本身，本段不重复定义。

## 完成情况

任务完成，4 笔本地 commit：**`264cefc`**（实施：SessionBucket 按 session 分桶 + 入站按 envelope.session 路由 + 出站自动带 session + ChatView/RecoveryGate per-session + 跨会话 blocked_on 隔离 + stem 回填 watcher，初始含一处 M3-compat 偏离——`#<token>` 老链接进 recovery 而非 choiceLevel1，为保 e2e 3 场景全绿）+ **`051b45b`**（review 修复轮 R1-R5 + W8：reviewer 裁决方案 B **翻转偏离回 strict 钉子 6**——`#<token>` → `choiceLevel1` 严格分派 + 入站 fallback 链修正为 `envelope.session ?? currentSessionKey ?? M3_LEGACY_KEY` 三处 + recovery 仪式 dual queries 带 session 字段 + stem 回填桶迁移 `'new' → <stem>` + 测试与生产现实对齐 + watcher 单测）+ **`35120fc`**（R6 e2e 三场景迁移 M4 URL 流——`level1 → level2 → 新建会话 → &session=new → ChatView → 等待 stem 回填`，初跑 1/3 红）+ **`f1ede7d`**（e2e 根因修复：bridge 在 stem 派生前转发的 pending 信封带内部键 `new:<work_dir>` 泄上 wire，web 未识别 → watcher 误回填 `&session=new:<work_dir>` 触发 bridge 按 Branch1+2 拒 + 桶误迁移；另 (c) 场景步骤顺序 bug——stem 在 prompt 前不可能派生。修复：watcher 跳 pending-key 形态 + WsClient 折叠回 `'new'` 桶 + `migratePendingBucket` 防御 + spec 顺序修正。**e2e 3/3 绿 × 2 次连跑**（10.9s））。reviewer 初审 **6 Critical / 4 Warning / 6 Suggestion**——**全部处置**（W7 退役评估以 grep 清单形式留档、挂账任务 09；S11 PRD §4.3 字段说明补注归任务 09；其余落地或合理跳过）。测试基线 **单测 583 → 625**（+42）/ **e2e 3/3 绿×2** / web build **251.65 → 252.84 KB**（+1.19 KB）。**零 bridge/worker/shared 改动**（R1-R7 全 web + e2e 闭环）。

### `264cefc` 实施（SessionBucket 分桶 + 路由 + per-session 视图全量）

- **`packages/web/src/store.ts`** — `WebState` 升级为 `sessions: Record<sessionKey, SessionBucket>` + 既有全局字段（`bridgeStatus` / `connState` / `workDirs` / `currentWorkDir`）保留。`SessionBucket` 实施期落地 **9 字段**（PRD §4.3 写 7 字段，实施期增 `sessionList` 按桶镜像 + `_draftHasDelta` 内部 flag——`sessionList` 取代 PRD 原意「按 session 镜像」（原意下「`sessionList: SessionListEntry[]`」是 `WebState` 顶层字段，任务 07 落地时是该形态；任务 08 分桶后语义改为每个桶独立持有该 session 自己的会话列表快照——与 ChatView per-session 一致性更佳，渲染「`sessionList` 取自 `sessions[sessionKey].sessionList`」）；`_draftHasDelta` 用于 `streamingDraft` 与 `messages` 收敛时的去重守护——防 React 死循环（与 M3 任务 07 snapshot 死循环根因一类）。S11 处置：实际 9 字段 vs PRD 7 字段的差异在 PRD §4.3 修订注记补注（任务 09 docs-sync 范围）；本任务清单提交完成情况时只作 7 字段清单的「实际落地 9 字段」挂账，不改 PRD 主体。
- **`packages/web/src/ws/WsClient.ts`** — 入站分发按 `envelope.session` 路由（4 类 envelope：`session_state` / `snapshot` / `command_result` / `event`）→ 写入 `sessions[<key>]` 对应桶；`session_state.payload.work_dir` 镜像到 `SessionBucket.workDir`；出站组装所有 pi 命令 + control `get_state` / `session_list` / `list_directories` / `work_dir_*` 自动从 `currentSessionKey` 填 `session` 字段（来自 hash），`session_list` 自动从 `currentWorkDir` 填 `payload.work_dir`（裁定 A 操作惯例必带）。**M3-compat 初始偏离**：`#<token>` 老链接进 `RecoveryView`（recovery 仪式）而非 `choiceLevel1`（两键决策表 level1）——为保 e2e 3 场景（M3 token-only URL 形态）全绿先做妥协；reviewer **裁决方案 B 翻转回 strict 钉子 6**（`051b45b`）。
- **`packages/web/src/ChatView.tsx`**（M3 §4.3）— 接 `session: sessionKey` prop；store 读写走 `sessions[session]`；输入框 / `agent_settled` 提示 / `queue_update` 显示 / `abort` / `steer` / `follow_up` 按钮全部 per-session（每个 session 各看各的，互不可见；A / B 同看 session X 同步——与 M3 等价）。
- **`packages/web/src/recovery.ts`** — `RecoveryGate` per-session（`Map<sessionKey, RecoveryGate>`）：进入该 session 时创建；离开不销毁（暂存以备切回时避免重发仪式）；"未加载"（`status: 'unknown'`）的 session 进入触发新仪式（与 M3 同路径——exited 时 `get_messages` 触发带 `--session` 的 spawn）。**recovery 仪式 dual queries 带 session**（R1 修复）：`get_messages` + `get_state` 并行发，**两条都带 `session` 字段**（fix 前仪式不发 session 字段触发 M3-compat 路径，与 M4 强 session 字段约定不一致）。
- **`packages/web/src/DialogHost.tsx`** — 按 session 分桶 `Record<sessionKey, BlockedOnEntryPayload[]>`：当前 session 的弹窗按 M3 既有逻辑显示；切到后台时 UI 不显示但入桶（沿用 M3「无乐观 UI」规则：dialog 提交 / 取消 / 超时后才移除）；切回该 session 时 DialogHost 重新 mount 弹窗（按 blockedOn 当前快照渲染），倒计时按 `Date.now() - enqueuedAt - timeout` 计算（剩余时间，`enqueuedAt` 时间戳在 `session_state` 入桶时记录——可选字段）。**跨会话 blocked_on 隔离**（多端先答者胜沿用 [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] §补注 3）：多端同看 session X，A 先提交 → bridge 处理 → broadcast `session_state`（blocked_on 移除该 id）→ B 端的桶也移除 → B 端 dialog 自动收起 + 收 `request_expired`。
- **stem 回填 watcher**（钉子 5 第 4 时机）— 监听 `session_state{session: <stem>}` 入站（来自 bridge 任务 06 pending → 真实 stem 迁移后广播）→ 任务 07 留的 stub 消费 + 任务 08 落地连带触发 level2 重查（pending → 真实 stem 时一次 refresh）——与「退回 level2」「workDir 变化」三路合并为同一 `useEffect` 依赖。**桶迁移**（R5 修复）：pending 桶（`'new'` 键）收到第一个 `session_state{session: <stem>}` 入站时，bucket 字段整体迁移（`messages` / `streamingDraft` / `queue` / `sessionPhase` / `blockedOn` / `workDir` / `recovery` / `sessionList` / `_draftHasDelta` 9 字段全量 move），迁移后 `'new'` 桶清空 + `<stem>` 桶可见；`migratePendingBucket` 防御（迁移时若 `<stem>` 桶已存在则合并而非覆盖——防极端竞态「同一 session 在两处进入」）。

### `051b45b` review 修复轮（**6C / 4W / 6S 全部处置**，W7 挂账任务 09 评估，S11 挂账任务 09 PRD 补注）

**核心修复——reviewer 裁决方案 B 翻转 M3-compat 偏离回 strict 钉子 6（R1 核心修复）**：实施期 `#<token>` 老链接分派走 `RecoveryView`（为保 e2e 3 场景），reviewer 抓出该偏离破坏了裁定 B + 钉子 6 的严格分派（hash 三键决策表 4 行：TokenPrompt / level1 / level2 / ChatView；M3 老链接 `#<token>` 应走 level1 强制两级起点，与裁定 A 自然兜底）。**翻转方案**：hash 解析时三键决策表严格按 4 行分派 → `#<token>` → level1 → 用户从 level1 选 work_dir → level2 → 选 session → ChatView。e2e 3 场景需要从 M3 token-only URL 形态**迁移到 M4 URL 形态**（`level1 → level2 → 新建会话 → &session=new → ChatView`）——这是 R6 commit `35120fc` 的范围。

- **R1** 翻转偏离回 strict 钉子 6 + e2e 三场景迁移。
- **R2** 入站 fallback 链修正为 `envelope.session ?? currentSessionKey ?? M3_LEGACY_KEY` 三处（`WsClient` 入站 `case` 4 类 envelope 写入桶时 `sessionKey` 来源统一；`m3-legacy` 兜底兼容 M3 token-only URL 入站 `session_state`，该桶无消费者——与任务 06 C2 移交义务一致）。
- **R3** recovery 仪式 dual queries 带 session（见上）。
- **R4** stem 回填桶迁移 + `migratePendingBucket` 防御（见上）。
- **R5** 测试与生产现实对齐——`WsClient` 出站方法（5 个 control + 6 个 pi）一律从 `currentSessionKey` / `currentWorkDir` 派生；测试桩不再 mock `currentSessionKey: null`（M3 兼容路径走 `M3_LEGACY_KEY` fallback 单一通道）；新测试覆盖 9 字段 bucket 写入读取一致性。
- **R7/W8** watcher 单测覆盖「`session_state` 入站 → 触发 stem 回填 → level2 重查」链路（mock WsClient 发送 `session_state{session: stem}` → 断言 store stem 桶就绪 + `triggerLevel2Refresh` 调用）。
- **W7 处置**——M3_LEGACY 退役评估以 grep 清单形式留档（本任务完成情况下方「C2 退役评估结论」段），挂账任务 09 评估最终退役口径（任务 09 范围沿用任务 06 C2 移交义务路径，任务 08 落地只是评估输入）。
- **S11 处置**——SessionBucket 9 字段 vs PRD §4.3 7 字段的差异在 PRD §修订注记补注（任务 09 范围），本任务不改 PRD 主体。

### `35120fc` R6 e2e 三场景迁移 M4 URL 流

**迁移动机**——R1 翻转后，e2e 3 场景从 M3 token-only URL 形态（`#<token>` → RecoveryView → ChatView）迁移到 M4 URL 形态（`#<token>` → level1 → 选 work_dir → level2 → 选 session / 新建 → ChatView）。三场景各自重写：

- **(a) 流式渲染**：`#<token>` → level1 → 选 work_dir → level2 → 新建会话（`&session=new`）→ ChatView 等待 stem 回填 → 等待流式消息 → 断言 message-row 文本与条数。
- **(b) F5 恢复**：`#<token>&work_dir=<encoded>&session=<stem>` → ChatView → 发送 prompt → 收到流式 → F5 → hash 维持 → ChatView 直接进入 → 逐字段对账 reload 前后 message-row 文本与条数。
- **(c) 多端弹窗先答者胜**：`#<token>&work_dir=<encoded>&session=<stem>` → 双 context 同 token + 同 session → A 后答 / B 端观察 + observation annotation 记录 `request_expired`。

**初跑 1/3 红**（场景 c）——A 端新建会话后 bridge 转发 `session_state{session: 'new:<work_dir>'}` 给 web（任务 06 实施期 pending 键控内部键 `new:<work_dir>` 泄上 wire——任务 06 §钉子 2 mapKey 实现细节漏出 wire 层），web 收到后 watcher 误把 `&session=new:<work_dir>` 回填进 hash（key 形态不被 `decideView` 决策表识别，应折叠回 `&session=new`），触发 bridge 按 Branch1（`session: <stem>` 命中）+ Branch2（`session: 'new'` 必带 work_dir）拒收。另一观察：场景 (c) 步骤顺序 bug——spec 在新建会话后立刻发 prompt 等待 stem 回填，但 stem 派生发生在第一个 prompt 写入触发 spawn 之后（与任务 06 §钉子 2 边界一致：spawning → ready 期间 `session: 'new'` 占位；首个非 handshake stdout 事件触发派生），spec 写「等待 stem 回填」是 `&session=new` 状态下空等待，期望瞬间派生——根因是 spec 顺序把「点新建」与「发 prompt」颠倒，stem 派生点不可能在 prompt 前。

### `f1ede7d` e2e 根因修复（4 笔根因 + 4 笔防御修复）

**根因 A**（任务 06 §钉子 2 实施期 mapKey 泄上 wire）——bridge `BridgeSessionLayer` 在 pending 阶段 map 键为 `new:<work_dir>`（任务 06 §钉子 2），其 `session_state` 广播带 `session: <内部键>`（`new:<work_dir>` 形态）。该内部键是 bridge 内部状态机的实现细节，不应泄上 wire——web 端 `decideView` 决策表不识别该形态。**修复 1（web 端防御）**：watcher 跳 pending-key 形态（正则 `^new:.+` 形态不触发回填）；**修复 2（web 端折叠）**：`WsClient` 收到 `session_state` 入站时检测 `session` 字段是否含 `:`（pending-key 形态特征）→ 折叠回 `'new'` 桶（`sessions['new']` 保留，pending-key 形态的 stem 不入桶）；**修复 3（web 端桶迁移防御）**：`migratePendingBucket('new' → <stem>)` 仅在 `<stem>` 不含 `:` 时执行（防 bridge 内部键误迁移到真实桶，污染 stem 桶）。

**根因 B**（spec 步骤顺序 bug）——场景 (c) 步骤把「点新建会话」与「发 prompt」颠倒（按 M3 路径理解发 prompt 触发状态恢复，与 M4 `&session=new` pending 路径冲突）。**修复 4**：场景 (c) spec 步骤修正为先发 prompt（pending 阶段）→ 等待 stem 回填（bridge 派生真实 stem 后广播 `session_state{session: <stem>}`）→ watcher 触发回填 → 后续断言。spec 顺序与 M4 §钉子 2 边界完全对齐。

**e2e 3/3 绿 × 2 次连跑**（10.9s）——修复后连跑两次稳定（既验证 green 状态，也验证非 flaky）。**M3 token-only URL `#<token>` 当前仅剩后台兼容语义**——e2e 不再走该路径；M3_LEGACY 桶无活跃消费者（`m3-legacy` 键 manager 的 `session_state` 广播带 `session: 'm3-legacy'`，web 按 session 分桶时该桶无消费者——沿用任务 06 C2 移交义务的入站侧对应行为）。

### 5 项边界决策要点

1. **M3-compat 初始偏离 → 翻转回 strict 钉子 6**（R1 核心修复）——实施期 `#<token>` 进 RecoveryView 为保 e2e；reviewer 抓出该偏离破坏裁定 B + 钉子 6（hash 三键决策表严格 4 行分派）→ 翻转后 `#<token>` 严格走 level1，e2e 同步迁移到 M4 URL 形态。**教训一句**：任务 06 C2 移交义务说「M4 正常 web 流程不得依赖 session-less 命令」，但实施期 e2e 3 场景仍走 `#<token>` token-only URL 形态时，web 端**也不应**给该路径开特殊入口（保持决策表 4 行严格分派，e2e 改造随之）——一次性 e2e 迁移比长期维护两套分派更简单。
2. **SessionBucket 9 字段 vs PRD §4.3 7 字段**（S11 挂账）——PRD §4.3 写 `messages` / `streamingDraft` / `queue` / `sessionPhase` / `blockedOn` / `workDir` / `recovery` 7 字段；实施期增 `sessionList`（按桶镜像，替代 `WebState.sessionList` 全局字段语义——保持 ChatView per-session 一致性，避免「session_list 全局但渲染时按 session 过滤」的隐式语义漂移）+ `_draftHasDelta`（内部 flag，守护 `streamingDraft` 与 `messages` 收敛时 React 死循环，与 M3 任务 07 snapshot 死循环根因一类）。**任务 09 docs-sync 范围**：PRD §修订注记补注「§4.3 实施期增 2 字段」一行，不改 PRD 主体。
3. **入站 fallback 链三处统一**（R2）——`envelope.session ?? currentSessionKey ?? M3_LEGACY_KEY` 三处兜底（`WsClient` 入站 4 类 envelope 写入桶时 sessionKey 来源一致；`m3-legacy` 兜底服务 M3 token-only URL 兼容入站，该桶无消费者；`currentSessionKey` 兜底服务 M3 single-bucket 入站未带 session 字段的过渡场景）。**M3 路径触发 `M3_LEGACY_KEY` fallback**；**M4 路径触发 `currentSessionKey` fallback**；**M3-compat path 触发 `M3_LEGACY_KEY` fallback**。**不**混淆语义（不入 store 的桶无消费者——避免 M3-compat 入站污染 M4 桶）。
4. **M3_LEGACY 退役评估结论——保留，挂账任务 09**——C2 评估「`M3_LEGACY_KEY` / `resolveM3CompatManager` / `defaultWorkDir` 三处代码退役」是任务 06 留给本任务的评估点。**本次评估结论：保留**。**理由（grep 清单）**：

   | 标识符 | 出现位置 | 用途 |
   |--------|----------|------|
   | `M3_LEGACY_KEY` / `m3-legacy` | `bridge/index.ts` (349, 367) / `bridge/session-layer.ts` (173, 332-337, 816-817, 1114-1115) | 导出常量 + 三处内部使用（map 键、outbound 标记、广播标记）|
   | `M3_LEGACY_KEY` / `m3-legacy` | `web/hash.ts` (252) / `web/App.tsx` (87, 230) / `web/ws/WsClient.ts` (121, 481, 500, 1067, 1071, 1148, 1174, 1209, 1239 等) / `web/ws/stem-refilled.ts` (65, 129) | 入站 fallback / M3 老链接兼容视作 level1 / session_list 镜像按 session 分桶隔离守卫 / stem 回填跳过 pending-key 形态 + 测试文件若干 |
   | `resolveM3CompatManager` | `bridge/session-layer.ts` (1067, 1071, 1107 定义) | `defaultWorkDir` auto-spawn 路径入口 |
   | `defaultWorkDir` | `bridge/index.ts` (357, 381) / `bridge/session-layer.ts` (289, 376, 406, 798, 808, 817, 1057, 1096, 1111-1115) | 构造参数 + 多处使用（auto-spawn M3-compat manager）|

   **M4 正常 web 流程不依赖 session-less 命令**（任务 06 C2 移交义务 + R2 翻转后所有出站入站带 session 字段）；**`M3_LEGACY_KEY` 桶仅剩后台兼容语义**——`#<token>` 老链接现在正确落入 level1（M3 老链接兼容走 `choiceLevel1` 决策表分支 + 入站 `session_state{session: 'm3-legacy'}` 经 `WsClient` 兜底入 `m3-legacy` 桶无消费者）。**退役触发条件尚未满足**——保留三处代码 + JSDoc 互引。**任务 09 docs-sync 范围**：① 评估 PRD §修订注记是否需追加 2026-09-08 任务 08 退役评估条（结论 = 暂不退役，挂账 M+ / M5 评估——任务 10 E2E 全部迁移到带 session 字段后再次评估）；② ADR-0008 §影响段无需改（M3-compat 路径未变）；③ getting-started URL hash 文档无需改（M3 老链接兼容已说明）。
5. **测试 / 构建基线**——单测 **583 → 625**（+42：实施 +25 / R1-R7 修复轮净 +17）+ e2e 3/3 绿 × 2 次连跑（10.9s）+ web build **251.65 → 252.84 KB**（+1.19 KB：watcher 单测 + `migratePendingBucket` 防御 + R3/R4/R5 测试桩调整）；`packages/web` 改 5 文件（`store.ts` 升级 9 字段 / `WsClient.ts` 入站 fallback 三处 + 出站自动带 session / `ChatView.tsx` per-session prop / `recovery.ts` Map<sessionKey, RecoveryGate> / `DialogHost.tsx` 按 session 分桶）；测试文件改 4 + 新建 1（`__tests__/ws-client-session-routing.test.ts` 新建 18 + 4 文件净 +24）；`packages/bridge` / `packages/worker` / `packages/shared` **零改动**（R1-R7 全 web + e2e 闭环）；既有 583 测试零回归（M3 任务 06/07 web 单测基线未被 M4 任务 08 引入回归）。

### 移交义务闭环确认（C2 / W2 / stem 回填 hook）

- **C2 移交义务**（任务 06 接收）——web M4 流程的所有 pi 命令与 `get_state` **必须携带 session 字段**（R2 翻转后所有出站入站带 session 字段统一 + 入站 fallback 链三处显式覆盖 `M3_LEGACY_KEY`）→ **义务闭环 ✓**。
- **W2 移交义务**（任务 07 接收）——`WsClient.sendSessionList(workDir)` 出站补 `envelope.session` 字段（来自 `currentSessionKey`）+ JSDoc 「Review 修复轮 W2 注记」段从「task 08 必须在此补」改写为「已补」+ 测试 1.6 追加 `session` 断言 + 新增 1.6b 镜像按 session 分桶隔离 → **义务闭环 ✓**。
- **stem 回填 hook**（任务 07 留 stub）——pending → 真实 stem 时连带一次 level2 refresh（钉子 5 第 4 时机）→ **消费 stub 闭环 ✓**。

### 与 [[tasks/m4/07-web-choice-page.md|任务 07]] / [[tasks/m4/06-bridge-session-layer.md|任务 06]] / [[tasks/m4/02-shared-protocol-v3.md|任务 02]] 对照

| 维度 | M4 任务 [[tasks/m4/02-shared-protocol-v3.md\|02]] | M4 任务 [[tasks/m4/06-bridge-session-layer.md\|06]] | M4 任务 [[tasks/m4/07-web-choice-page.md\|07]] | M4 任务 08（本任务） |
|------|---------------------------------|---------------------------------|---------------------------------|---------------------|
| 测试基线 | shared 308 不变 | **485 单测** / 32 集成 | 485 → **583 单测** | 583 → **625 单测** + e2e 3/3 绿 × 2 |
| 新建核心文件 | `work-dirs.ts` / `session-list.ts` | `session-layer.ts` | `hash.ts` / `ChoicePage.tsx` / `DirectoryBrowser.tsx` | `__tests__/ws-client-session-routing.test.ts`（watcher 单测新建）|
| 关键 seam | envelope `session` 启用规则 + ADR-0010 | `BridgeSessionLayer` 多 manager Map + SPAWN_TIMEOUT_MS + pending 键控 | `decideView` 决策表 + `registerReplyResolver` 一次回调 | SessionBucket 9 字段分桶 + `migratePendingBucket` 防御 + 入站 fallback 链三处 + stem 回填 watcher + **strict 钉子 6 翻转**（`#<token>` → level1）|
| review 结论 | 0C / 4W / 7S（6 项落地 + S1/S3/S5 递延任务 09）| **2C / 7W / 9S 全部处置**（C2 m3-legacy 文档化转任务 08 退役评估）| **1C / 6W / 5S 全部处置**（C1+W1+W5 轮询架构重构）| **6C / 4W / 6S 全部处置**（C1 翻转 strict 钉子 6；W7 退役评估挂账任务 09；S11 PRD §4.3 9 字段补注挂账任务 09；其余落地或合理跳过）|
| 教训承接 | M3 `1c86aca` worker 转发链教训 | M3 `get_messages.reply_to` 翻译层教训 + **真 pi 探针铁律** | M3 task 07 `registerReplyResolver` 范式（迁移至 ChoicePage）+ M3 task 06 ChatView type 路由范式 | M3 task 07 snapshot 死循环教训（`_draftHasDelta` 守护）+ M3 task 06 §钉子 2 内部键泄 wire 教训（`new:<work_dir>` 形态）+ M3 task 06 §钉子 2 边界教训（stem 派生在 prompt 后，非前）|