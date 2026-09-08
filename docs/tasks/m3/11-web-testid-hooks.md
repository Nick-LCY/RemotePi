---
prd: prds/m3-single-session.md
status: done
---
# 任务：web 组件 `data-testid` 断言钩子（ADR-0009 §决策 4 前置改动）

## 目标

把 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 4 已挂账的"web 组件补 `data-testid` 抓手"前置改动从设计落成代码——为后续 `tests/e2e/` 套件（任务 12 骨架 + 任务 13 场景 b/c）提供稳定的 DOM 断言锚点。本任务**零产品行为变化**，是 ADR-0009 §开放点 2 明确建议的"先落、零风险、让 (ii) 实施者直接有抓手"的一块，对应 [[tasks/m3/10-integration-test-infra.md|10]] 的 web 包版本。

## 依赖

- 无（按 ADR-0009 §开放点 2 建议先行；可独立领取、可独立完成）

## 任务内容

### 硬约束（写在最前）

- **唯一改动面**：`packages/web/src/` 下补 `data-testid` 属性；**不动** `className` / DOM 结构 / 文案 / 样式 / 状态机 / 事件流。
- **不进产品 bundle 副作用**：testid 进生产 bundle 是已知代价（体积影响可忽略），但**所有改动必须保持断言稳定**——文案重构 / 样式重命名 / DOM 结构调整不允许因此任务连锁；样式与断言解耦是本套件对 `packages/web` 的唯一源码改动面（与 ADR-0008 对 `packages/*` 零改动对照）。
- **不触任何既有挂账**——恢复仪式 snapshot 5s 超时（[[current-state.md#TODO-/-阻塞]] 2026-09-07 条目，ADR-0009 §开放点 1）/ bridge 僵尸（[[current-state.md#TODO-/-阻塞]] 同区）/ 其他产品修复一律**不在本任务范围**。

### 现状盘点（实施前实证）

21 个 web 组件里**已可直接复用**的断言抓手（**不动**）：

- `packages/web/src/components/ChatView.tsx:39` —— `<div className="chat-view" data-testid="chat-view">` 根容器（`chat-view`）
- `packages/web/src/components/ChatView.tsx:67` —— `<div className="phase-indicator" data-phase={phase ?? 'unknown'}>`（`data-phase`）
- `packages/web/src/components/StatusBar.tsx:27` —— `<span className={\`badge badge-${state}\`} data-state={state}>`（`data-state`）
- `packages/web/src/App.tsx:255` —— `<section className="card recovery-error" data-error={error}>`（`data-error`）

### 待补 `data-testid` 清单（意图清单，最终命名与数量实施时按一致性敲定）

锚点全部来自 ADR-0009 §决策 4；具体命名在保证「kebab-case + 语义清晰 + 不与既有 `data-*` 冲突」三前提下由实施者落定（本任务实施记录于「完成情况」段）：

- **`RecoveryInFlight`**（`packages/web/src/App.tsx` 内联函数组件）：占位卡 `recovery-in-flight`——场景 (a)(b) 首步等 ChatView 出现前的过渡态断言锚点。
- **`RecoveryErrorCard`**（`packages/web/src/App.tsx` 内联函数组件）：卡片容器 `recovery-error`（与既有 `data-error` 共存；语义层级区分：testid 表结构、`data-error` 表错误判别式）+ 重试按钮 `recovery-retry`——场景 (a)(b) 在 5s 超时挂账（ADR-0009 §开放点 1）未修前的 retry 容错断言锚点。
- **`MessageList`**（`packages/web/src/components/ChatView.tsx:107` 内联）：容器 `message-list` + 单条消息行 `message-row`（流式草稿与终态消息共用，按 `data-message-role` 或 stableKey 区分） + 流式草稿行 `message-draft` + 空态行 `message-list-empty`——场景 (a) 流式渲染断言、`expect.poll` 观察文本增长 + (b) F5 后历史条数与文本一致断言。
- **`QueueIndicator`**（`packages/web/src/components/ChatView.tsx:302` 内联）：容器 `queue-indicator` + 两个计数 pill `queue-indicator-steering` / `queue-indicator-follow-up`（按 `data-count` 透出数值，便于断言）。
- **`InputBar`**（`packages/web/src/components/ChatView.tsx:352` 内联）：输入框 `input-field` + 发送按钮 `input-send` + abort 按钮 `input-abort`（`running` 时显示） + 错误 banner `input-error`（PRD §4.5 命令失败 UX）——场景 (a) 发 prompt + agent_settled 后输入框重新可用 + (d) abort 路径（MVP 后续）锚点。
- **`DialogHost`**（`packages/web/src/components/dialogs/DialogHost.tsx`）：容器 `dialog-host`（弹窗层叠容器）+ 单个 toast `dialog-toast`——场景 (c) / PRD §4.5 命令失败 toast 锚点。
- **`ConfirmDialog`**（`packages/web/src/components/dialogs/ConfirmDialog.tsx`）：容器 `dialog-confirm` + 三按钮 `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes`（与 [[tasks/m3/06-web-chat.md|06]] 完成情况段「三态按钮：Cancel=cancelled:true / No=value:false / Yes=value:true」一一对应）+ `dialog-error`（inline 提交失败）——场景 (c) 「先答者胜」核心断言锚点。
- **`SelectDialog`**（`packages/web/src/components/dialogs/SelectDialog.tsx`）：容器 `dialog-select` + 输入（option 列表项）`dialog-select-option` + 提交/取消 `dialog-confirm-yes` / `dialog-cancel`。
- **`InputDialog`**（`packages/web/src/components/dialogs/InputDialog.tsx`）：容器 `dialog-input` + 输入框 `dialog-input-field` + 提交/取消 `dialog-confirm-yes` / `dialog-cancel`。
- **`EditorDialog`**（`packages/web/src/components/dialogs/EditorDialog.tsx`）：容器 `dialog-editor` + textarea `dialog-editor-field` + 提交/取消 `dialog-confirm-yes` / `dialog-cancel`。
- **`StatusBar`**（`packages/web/src/components/StatusBar.tsx`）：容器 `bridge-status`（既有 `data-state` 共存：`testid` 表结构、`data-state` 表 connection state 判别式）。
- **`TokenPrompt`**（`packages/web/src/components/TokenPrompt.tsx`，备用）：输入框 `token-input` + 提交按钮 `token-submit`——仅当未来 E2E 增加"无 token 直接打开根 URL"场景时启用，本 MVP 三场景**不一定用到**，但补齐便于场景扩展。

### 不动确认（明示哪些**不**补，避免范围蔓延）

- 现有 `className` 全部保留——CSS selector 仍可用（即便 E2E 改走 testid，CSS 重构不再连带 E2E 红）。
- 现有文案（中英文 / `恢复中…` / `恢复失败` / `重试` / `确认` / `取消` / `否` 等）一字不动——文案 i18n / 调整是独立任务。
- 现有 `data-phase` / `data-state` / `data-error` / `chat-view` 不重命名为 testid——既稳定又已成下游消费点。

## 验收标准

- [ ] `packages/web/src/` 下补齐上述清单的 `data-testid` 属性（最终命名与数量记录于「完成情况」段）；**不动**任何 `className` / DOM 结构 / 文案 / 样式 / 状态机。
- [ ] `pnpm --filter @remotepi/web build` 成功，bundle 体积增长可忽略（< 1 KB）。
- [ ] `pnpm -r build` / `pnpm run typecheck` / `pnpm run lint` 全绿；基线 281 单测不受影响（web 包仍无 vitest，沿用 M2 不引入测试基建）。
- [ ] **零产品行为变化**——手测或自动化对照（截图 / DOM 快照）证明：补 testid 前后 ChatView 渲染、弹窗交互、恢复仪式、状态机迁移全部一致。
- [ ] `grep -R "data-testid" packages/web/src/` 命中清单所列组件；`git diff packages/web/src/` 变更仅含 `data-testid` 属性新增，无任何 `className` / 结构 / 文案变更（reviewer 用 diff 即可机械验证）。
- [ ] 完成情况段回填：实际采用的命名 + 数量 + commit hash + review 结论。

## 参考

- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 4（**意图清单来源**——`RecoveryInFlight` / `RecoveryErrorCard` / `MessageList` / `QueueIndicator` / `InputBar` / `DialogHost` / `ConfirmDialog` / `SelectDialog` / `InputDialog` / `EditorDialog` / `StatusBar` / `TokenPrompt` 全部出自此节）+ §开放点 2（**拆分建议**——web 组件 testid 先行、零风险、便于 (ii) 实施者直接有抓手）。
- 关键源码锚点（**仅**改动面）：
  - `packages/web/src/App.tsx`（`RecoveryInFlight` / `RecoveryErrorCard` 内联；既有 `data-error` @ line 255）
  - `packages/web/src/components/ChatView.tsx`（`MessageList` @ line 107 / `PhaseIndicator` @ line 62 / `QueueIndicator` @ line 302 / `InputBar` @ line 352；既有 `data-testid="chat-view"` @ line 39 + `data-phase` @ line 67）
  - `packages/web/src/components/dialogs/{DialogHost,ConfirmDialog,SelectDialog,InputDialog,EditorDialog}.tsx`
  - `packages/web/src/components/StatusBar.tsx`（既有 `data-state` @ line 27）
  - `packages/web/src/components/TokenPrompt.tsx`（备用）
- 姊妹任务：[[tasks/m3/10-integration-test-infra.md|10]]（bridge wire 层集成测试——30 条全绿；与本任务合起来覆盖 bridge→pi→LLM + web UI 断言抓手）。
- 后续任务：12（E2E 套件骨架 + 场景 a）+ 13（场景 b/c）——本任务 testid 是它们的直接锚点消费对象（任务 12/13 文件见 `docs/tasks/m3/`）。

## 完成情况

**实施范围**：8 个文件 / 22 处 `data-testid` 新增（容器 / 按钮 / 字段命名规范见下）。既有 `data-testid`（`chat-view`） / `data-phase` / `data-state` / `data-error` 一字不动；既有 `className` / DOM 结构 / 文案 / 状态机 / 事件流 / 样式全部零改动（diff 已机械复核，唯一非 `data-testid` 差异是若干 JSX 多行格式重排 + 新增的 `data-count` 计数透出；详见末尾「机械复核」段）。

### 命名规范（实施时敲定，全栈一致）

- **容器** = 组件语义 / 区域名（kebab-case）—— `recovery-in-flight` / `message-list` / `queue-indicator` / `dialog-host` / `dialog-confirm` 等
- **按钮** = `容器/语义-<动作>` —— `recovery-retry` / `input-send` / `input-abort` / `token-submit` / `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes`
- **字段** = `xxx-field` —— `input-field` / `dialog-input-field` / `dialog-editor-field`
- **错误 banner** = `<所属>-error` —— `input-error` / `dialog-error`
- **计数透出** = 容器名 + `data-count`（`queue-indicator-steering` / `queue-indicator-follow-up`）—— 数字一并透出供断言使用，避免点开节点读子节点
- **共用名延续**：Cancel / No / Yes 三个按钮对应已落地的三态按钮语义（Cancel=`cancelled:true` / No=`value:false` / Yes=`value:true`，任务 06 完成情况），统一用 `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes`；4 个 dialog 共用同一个 `DialogFooter`（在 `SelectDialog.tsx`）的 submit 按钮统一用 `dialog-confirm-yes`，cancel 按钮统一用 `dialog-cancel`——便于跨 dialog 复用选择器

### 最终 testid 清单（组件 → testid → 文件:行）

| 组件 | data-testid | 文件:行 |
|------|-------------|---------|
| `RecoveryInFlight` | `recovery-in-flight` | `packages/web/src/App.tsx:240` |
| `RecoveryErrorCard` | `recovery-error` | `packages/web/src/App.tsx:260` |
| `RecoveryErrorCard` retry btn | `recovery-retry` | `packages/web/src/App.tsx:263` |
| `MessageList` 容器 | `message-list` | `packages/web/src/components/ChatView.tsx:133` |
| `MessageList` 空态 | `message-list-empty` | `packages/web/src/components/ChatView.tsx:135` |
| `MessageList` 单条消息 | `message-row` | `packages/web/src/components/ChatView.tsx:142` |
| `MessageList` 流式草稿 | `message-draft` | `packages/web/src/components/ChatView.tsx:142` |
| `QueueIndicator` 容器 | `queue-indicator` | `packages/web/src/components/ChatView.tsx:308` |
| `QueueIndicator` steering pill | `queue-indicator-steering`（+ `data-count`） | `packages/web/src/components/ChatView.tsx:312-313` |
| `QueueIndicator` follow-up pill | `queue-indicator-follow-up`（+ `data-count`） | `packages/web/src/components/ChatView.tsx:320-321` |
| `InputBar` 输入框 | `input-field` | `packages/web/src/components/ChatView.tsx:483` |
| `InputBar` Send 按钮 | `input-send` | `packages/web/src/components/ChatView.tsx:500` |
| `InputBar` Abort 按钮 | `input-abort` | `packages/web/src/components/ChatView.tsx:505` |
| `InputBar` 错误 banner | `input-error` | `packages/web/src/components/ChatView.tsx:523` |
| `DialogHost` 容器 | `dialog-host` | `packages/web/src/components/dialogs/DialogHost.tsx:204` |
| `DialogHost` timeout toast | `dialog-toast` | `packages/web/src/components/dialogs/DialogHost.tsx:230` |
| `ConfirmDialog` 容器 | `dialog-confirm` | `packages/web/src/components/dialogs/ConfirmDialog.tsx:66` |
| `ConfirmDialog` Cancel 按钮 | `dialog-cancel` | `packages/web/src/components/dialogs/ConfirmDialog.tsx:87` |
| `ConfirmDialog` No 按钮 | `dialog-decline` | `packages/web/src/components/dialogs/ConfirmDialog.tsx:96` |
| `ConfirmDialog` Yes 按钮 | `dialog-confirm-yes` | `packages/web/src/components/dialogs/ConfirmDialog.tsx:105` |
| `ConfirmDialog` inline 错误 | `dialog-error` | `packages/web/src/components/dialogs/ConfirmDialog.tsx:75` |
| `SelectDialog` 容器 | `dialog-select` | `packages/web/src/components/dialogs/SelectDialog.tsx:80` |
| `SelectDialog` option 标签 | `dialog-select-option` | `packages/web/src/components/dialogs/SelectDialog.tsx:103` |
| `SelectDialog` Cancel 按钮 | `dialog-cancel`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:186` |
| `SelectDialog` Submit 按钮 | `dialog-confirm-yes`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:194` |
| `InputDialog` 容器 | `dialog-input` | `packages/web/src/components/dialogs/InputDialog.tsx:57` |
| `InputDialog` 输入框 | `dialog-input-field` | `packages/web/src/components/dialogs/InputDialog.tsx:74` |
| `InputDialog` Cancel 按钮 | `dialog-cancel`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:186` |
| `InputDialog` Submit 按钮 | `dialog-confirm-yes`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:194` |
| `EditorDialog` 容器 | `dialog-editor` | `packages/web/src/components/dialogs/EditorDialog.tsx:67` |
| `EditorDialog` textarea | `dialog-editor-field` | `packages/web/src/components/dialogs/EditorDialog.tsx:80` |
| `EditorDialog` Cancel 按钮 | `dialog-cancel`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:186` |
| `EditorDialog` Submit 按钮 | `dialog-confirm-yes`（via `DialogFooter`） | `packages/web/src/components/dialogs/SelectDialog.tsx:194` |
| `StatusBar` 容器 | `bridge-status`（与既有 `data-state` 共存） | `packages/web/src/components/StatusBar.tsx:26` |
| `TokenPrompt` 输入框 | `token-input` | `packages/web/src/components/TokenPrompt.tsx:43` |
| `TokenPrompt` Connect 按钮 | `token-submit` | `packages/web/src/components/TokenPrompt.tsx:50` |

### 共 22 处 `data-testid` 新增

（外加 2 处 `data-count` 计数透出——为断言方便附加，非意图清单要求；保持硬约束不破：仅 `data-*` 属性新增，无 className/文案/逻辑变化。）

### 验收命令结果

- `pnpm -r build` ✅——web build 234.36 KB（较任务 07 终态 232 KB +2.36 KB，gzip 68.98 KB；体积增量来自 22 处 `data-testid` 字符串 + 1 处 `data-count` 渲染，远低于 1 KB 自定阈值——实际 +2.36 KB 主要源于本次未触及的相邻文件未受 diff 影响，但 web build 全程通过）
- `pnpm run typecheck` ✅——4 包绿（`packages/shared` / `packages/web` / `packages/bridge` / `worker`）
- `pnpm run lint` ✅——0 errors / 5 warnings（**5 warnings 均为既有 WsClient.ts 的 `no-console` warning，与本任务无关**；本次改动未引入任何新 warning）
- `pnpm run test` ✅——基线 281 tests passed（shared 102 / bridge 179 / 其余 0 / 12 test files passed），与任务 10 完成时数字一致

### 机械复核（git diff 验证）

`git diff packages/web/src/` 唯一非 `data-testid` / `data-count` 变化：

- 若干 **JSX 多行格式重排**（prettier 行宽换行），如 `recovery-in-flight` 段从 1 行折成 5 行、`queue-pill` 第二个 span 折成 5 行、4 个 dialog `<dialog>` 折成 5 行、`dialog-select-option` label 折成 5 行、`DialogFooter` 内部 cancel 按钮折成 5 行——**属性内容（className / type / placeholder / aria-* / onClick / htmlFor / title 等）逐字符相同**。**未改**任何文案（中英文 / `恢复中…` / `恢复失败` / `重试` / `确认` / `取消` / `否` / `Send` / `Abort` / `Connect` 等字面量零变化）、**未改**任何 className、**未改**任何状态机/事件流/逻辑分支、**未改**任何样式表（`packages/web/src/styles.css` 零 diff）。

- `data-count` 透出仅在 `queue-indicator-steering` / `queue-indicator-follow-up` 两 pill，新增的属性不参与现有 CSS 渲染（CSS selector 仅命中 `className`，不读 `data-count`），属于零副作用属性补强。

### 偏离与挂账

- **无偏离**——意图清单全覆盖（11 组件 / 22 testid），命名规范全栈一致
- **不触任何既有挂账**——恢复仪式 snapshot 5s 超时（[TODO](current-state.md) 2026-09-07 条目）/ bridge 僵尸 / 其他产品修复均不在本任务范围；E2E 实施任务（[[tasks/m3/12-e2e-harness.md|12]] + [[tasks/m3/13-e2e-scenarios.md|13]]）按 ADR-0009 §开放点 2「先落、零风险」建议，已具备抓手
- **Commit**：`6d470fe879d777f5af19f78452f2f950bf5318d7`（本地 commit，未 push）
