---
prd: prds/m3-single-session.md
status: done
---
# 任务：E2E 场景 (b) F5 恢复 + (c) 多端弹窗先答者胜（ADR-0009 §决策 3 后半部）

## 目标

把 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 3 MVP 三场景中**后半两场景**从设计落成 spec —— 在 [[tasks/m3/12-e2e-harness.md|12]] 提供的四进程全栈装配上：(b) F5 恢复（恢复仪式重走 + 历史一致）+ (c) 多端弹窗先答者胜（同 token 两端 → 弹窗 → A 先答 → B 迟交收 `request_expired` UI 表现）。本任务**不做任何产品修复**——同 token 重连不重发仪式 / 恢复超时 / 重连语义等产品行为保持现状，测试按现状断言（与 ADR-0009 §决策 7 末两条断言语义约定协同）。

## 依赖

- 依赖 [[tasks/m3/12-e2e-harness.md|12]]（四进程装配 + globalSetup/teardown + 场景 (a) + retry 容错断言 helper——本任务直接复用）
- 间接依赖 [[tasks/m3/11-web-testid-hooks.md|11]]（`recovery-retry` / `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes` / `dialog-error` 等 testid 是场景 (c) 关键断言锚点）

## 任务内容

### 硬约束（写在最前）

- **不触任何产品修复**——恢复超时挂账（[[current-state.md#TODO-/-阻塞]] 2026-09-07 条目，ADR-0009 §开放点 1）/ 同 token 重连语义（`packages/web/src/App.tsx` `autoStartConsumedRef` 守门，§决策 7 末条断言语义约定）/ bridge 僵尸（[[current-state.md#TODO-/-阻塞]] 同区）等**全部按现状断言**。场景 (b) F5 重走仪式断言要尊重"fresh mount ⇒ fresh gate"语义；场景 (c) `request_expired` UI 表现断言要尊重 §决策 7 "同 token 重连不重发仪式"的语义。
- **复用 [[tasks/m3/12-e2e-harness.md|12]] 装配**——`globalSetup` / `globalTeardown` / `bridge-process` / `wrangler-process` / `env-builder` / `fake-llm-server` 直接 import，零新增装配代码。
- **场景范围严格 ≤ (b)(c)**——MVP 三场景已闭环；abort / idle-kill / 4 类弹窗逐一交互 / PRD §4.5 命令失败 UX 等可选后续放在 PRD §6.5 路线图，不在本任务。

### 场景 (b) F5 恢复

#### 意图（ADR-0009 §决策 3 第二条）

在场景 (a) 状态上 `page.reload()` → 恢复仪式再走一遍（fresh mount ⇒ fresh gate ⇒ `autoStartConsumedRef` 重置，[[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 7 末条 + `packages/web/src/App.tsx` JSDoc 实证）→ ChatView 出现 + 消息历史完整渲染（条数 / 文本与 reload 前一致）。与 ADR-0008 §决策 2 `--session` 恢复同语义但走 UI 层。

#### 步骤链

1. **前置**：复用 [[tasks/m3/12-e2e-harness.md|12]] 场景 (a) 的 test body——发 1-2 轮 prompt（保证 reload 前 messages.length ≥ 2）+ 拿到 `agent_settled`；记录 reload 前 `message-row` 元素列表的 `[data-testid, 文本内容]` 快照（用于 §断言链步 4 对账）。
2. **reload**：`page.reload()` —— fresh mount ⇒ fresh `RecoveryGate` 实例（`useGateRef` 工厂 + `autoStartConsumedRef.current = null` 重置）。
3. **恢复仪式重走断言**：先见 `data-testid="recovery-in-flight"` → 后见 `data-testid="chat-view"`（与 (a) 同 retry 容错 helper；若先见 `recovery-error` → 点 `recovery-retry` 一次 → 重等 ChatView——理由同 [[tasks/m3/12-e2e-harness.md|12]]，5s 超时挂账未修前的 E2E 已知行为）。
4. **历史一致断言**：
   - 断言 reload 后 `data-testid="message-row"` 元素**条数**与 reload 前一致（用 `expect.poll` 等 React 渲染完成——`messages` 数组可能跨多个 microtask 更新）
   - 断言每条 message-row 的文本内容与 reload 前对账（按出现顺序逐条 `toHaveText(reloadBeforeSnapshot[i].text)`）
   - 断言 `data-testid="chat-view"` 可见 + `data-testid="input-field"` 可用
5. **可选深度断言**（不阻塞 MVP，**写进 spec 但默认 skip**）：
   - `data-testid="message-row"` 元素的 `data-message-role` / stableKey 与 reload 前一致（依赖任务 11 实施时若选 `[data-message-role]` 暴露）

#### 边界与已知脆性

- **DO SQLite 持久化**——wrangler dev `--persist-to worker/.wrangler/` + globalSetup `rm -rf` → 本场景每次 run 是 fresh SQLite；但 `get_messages` 拉回的顺序与 pi jsonl 落盘顺序一致（`c6d2f90` web 提取器位置键 + ADR-0003 §会话文件为权威历史源）。
- **「消息条数一致」的"一致"是什么**——是 JSONL 中"历史消息数"还是"message-row 元素数"？两者在 ui 层应等价（message-row 一对一映射 history messages），断言写后者即可；如发现不对账（即一消息拆两行 / 两消息合一行的渲染 bug），E2E 会红且不修产品，按 §开放点 1 短期路径容忍。
- **同 token 重连不重发仪式（§决策 7 末条）**——`autoStartConsumedRef` 按 token 守门，本场景是 `page.reload()`（fresh mount），**会**重发；与 §决策 7 末条"WsClient-internal reconnects（同 token offline→connecting→online）不重发"不冲突——`page.reload` 是整页重建，App 整个重挂。

### 场景 (c) 多端弹窗先答者胜

#### 意图（ADR-0009 §决策 3 第三条 + §开放点 3 竞态构造手法敲定）

两个 browser context 同 token → 两端都到 ChatView → context A 发 prompt 让 pi 调 `trigger_dialog(kind=confirm)` → 断言两端都弹 ConfirmDialog → A 点 Yes → A 弹窗收起、B 弹窗也收起（`blocked_on` 移除该 id 后 React key 卸载，与 §决策 7 末条 "弹窗自动关闭走 React key 卸载" 对齐）→ B 若窗口内抢答，断言 B 侧 `request_expired` 的 UI 表现。

**架构事实**：worker 按 token 路由同一 Room DO，没有 cookie 隔离概念——两 context 同 token 就是同一房间两个 web 端（[[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] + [[tasks/m3/05-bridge-popup-core.md|05]] 语义）。

#### 敲定点 5（§开放点 3 竞态构造手法）—— 三选项 + 默认

- **首选 A**（默认实施）：B 先点到 `dialog-confirm-yes` 的 `submitting` 状态（即本地已发请求、尚未收 `request_expired` 回执）→ 然后 A 才点 Yes。断言：B 端 `dialog-confirm` 容器消失 + B 端收到 `request_expired` 的 UI 表现（依 PRD §4.5，弹窗走 dialog → toast 路径；本任务断言 `data-testid="dialog-toast"` 出现 + 含 `request_expired` 文案 + `dialog-confirm` 容器 `toBeHidden()`）。**优先**`test.describe.configure({ mode: 'serial' })` 确保 A / B 顺序。
- **备选 B**：`page.route` 延迟 B 端的 `extension_ui_response` 出站请求（500ms-2s）→ A 已答完 + worker DO `blocked_on` 已清后 B 的响应才送达 → B 收 `request_expired`。**适用**：首选 A 实现复杂（`submitting` 状态时机脆）时退路。
- **备选 C**（最低兜底）：不构造"迟交"具体时序，只断言主断言「两端都收起」+ 把 `request_expired` UI 表现降为 **soft assertion**（`expect.soft` + spec 末尾汇总不通过项；本场景主断言通过即可标 done，软断言失败记录为"待 §开放点 1 决议后收紧"，与 ADR-0009 §开放点 1 短期路径精神一致）。
- **首选 A / 备选 B / 备选 C 在 spec 顶部注释里钉选 + 理由**，完成情况段必须记录实际敲定。

#### 步骤链（以首选 A 写）

1. **建两 context**：
   - `const ctxA = await browser.newContext()` + `const ctxB = await browser.newContext()`（Playwright 原生 multi browser context，与 ADR-0009 §备选否决第一条"Cypress 单 tab 模型"对照的增量价值）
   - 两 context 都 `page.goto('http://localhost:8787/#<同 token>')` + 等两端都 `data-testid="chat-view"` 出现（用 `Promise.all` + 各自 retry 容错 helper）
2. **触发弹窗**：
   - 在 A 端 `data-testid="input-field"` 输入 `"trigger confirm dialog"` → 点 `input-send`（fixture `test-ext.ts` 的 `trigger_dialog` 工具接受 `kind=confirm`；假 LLM server 脚本据此设计——具体脚本在本任务实施时落定，与 [[tasks/m3/10-integration-test-infra.md|10]] fixture `04-extension-dialogs.test.ts` `kind=confirm` 用例同口径）
3. **两端都弹断言**：
   - `Promise.all([expect(ctxA.page.locator('[data-testid="dialog-confirm"]')).toBeVisible({ timeout: 10_000 }), expect(ctxB.page.locator('[data-testid="dialog-confirm"]')).toBeVisible({ timeout: 10_000 })])` —— 两端都在 10s 内可见
4. **B 抢答到 submitting**：
   - `await ctxB.page.locator('[data-testid="dialog-confirm-yes"]').click()` —— B 端发 `extension_ui_response{value:true}` 出站请求（本地态切 submitting），断言 `data-testid="dialog-confirm"` 进入 submitting 视觉态（**实际：判断靠 `dialog-confirm-yes` 按钮 disabled 或 dialog 容器 `data-state="submitting"`**——本任务实施时若发现 web 端无该 `data-state`，则在任务 11 清单里补「`DialogHost` 加 `data-state`」或本 spec 退化为"点击后立刻进入步 5")
5. **A 后答**：
   - `await ctxA.page.locator('[data-testid="dialog-confirm-yes"]').click()` —— A 端发 response 出站
6. **两端收起断言**：
   - `Promise.all([expect(ctxA.page.locator('[data-testid="dialog-confirm"]')).toBeHidden({ timeout: 5_000 }), expect(ctxB.page.locator('[data-testid="dialog-confirm"]')).toBeHidden({ timeout: 5_000 })])` —— `blocked_on` 移除该 id 后 DialogHost 按 React key 卸载（§决策 7 末条）
7. **B 侧 `request_expired` UI 表现断言**：
   - `await expect(ctxB.page.locator('[data-testid="dialog-toast"]')).toBeVisible({ timeout: 5_000 })` —— toast 出现（PRD §4.5 dialog 失败 UX）
   - `await expect(ctxB.page.locator('[data-testid="dialog-toast"]')).toContainText(/request_expired|已过期|expired/i)` —— toast 含 `request_expired` 提示
   - 软断言（若敲定点选备选 C）：用 `expect.soft` 包裹步 7，spec 末尾 `test.info().annotations` 汇总未通过软断言

#### 边界与已知脆性

- **同 token 重连不重发仪式**（§决策 7 末条）——两 context 是**两独立浏览器实例**，各自挂载 App + 各自 `autoStartConsumedRef`；同 token 各走一次恢复仪式（独立 mount），不会因"同 token 重连"误判不重发。
- **`request_expired` UI 表现依产品现状**——若 5s 恢复超时挂账未修 + `request_expired` 在 B 端弹窗生命周期内到达，web 端走 PRD §4.5 dialog → toast 路径；断言以 `dialog-toast` 锚点兜底，文案正则宽容（`/request_expired|已过期|expired/i`）容忍未来 i18n。
- **多弹窗并发罕见**——协议不假设至多一个（[[tasks/m3/06-web-chat.md|06]] JSDoc）；本场景只测单 confirm 弹窗并发，多弹窗并发留 M+ 可选。
- **fixture `trigger_dialog` 脚本**——与 [[tasks/m3/10-integration-test-infra.md|10]] `04-extension-dialogs.test.ts` `kind=confirm` 用例同口径：假 LLM server 第一轮回 `toolUseReply(tool=trigger_dialog, args={kind:'confirm', title:'确认?', message:'请选择'})` → pi 调 `ctx.ui.confirm()` → 弹窗入 `pending` Map → worker 广播 `extension_ui_request` → 两端入 `blocked_on`。

### 验收标准

- [ ] `tests/e2e/specs/02-reload-recovery.spec.ts` 完整（前置场景 a 步骤链 + reload + 仪式重走 + 历史一致断言 + 可选深度断言默认 skip）
- [ ] `tests/e2e/specs/03-multi-tab-first-responder.spec.ts` 完整（两 context 建连 + 触发弹窗 + 两端都弹 + B 抢答 submitting + A 后答 + 两端收起 + B `request_expired` UI 表现断言）
- [ ] **敲定点 5 落定**（竞态构造手法首选 A / 备选 B / 备选 C 选一）—— 结论 + 理由记录于完成情况段
- [ ] **任务 12 stub 文件**（`02-reload-recovery.spec.ts` / `03-multi-tab-first-responder.spec.ts` 原 `test.skip()` + JSDoc 指回本任务）—— **移除** stub 的 `test.skip()` 标记，改写为真实 spec body
- [ ] **零产品行为改动**——任何源码 / 配置 / fixture / bridge / worker 改动均为零（除 `tests/e2e/` 内 spec 文件 + helper；如发现需补 testid 锚点，回退到任务 11 增量而非本任务直接改源码）
- [ ] `pnpm test:e2e` 三场景全绿（本机；建议连跑 2 次验证无 flaky）
- [ ] **回归基线零变化**：30 条 `pnpm test:integration` 仍全绿 + 基线 281 单测不变 + 4 包 typecheck + `typecheck:integration` + `typecheck:e2e` + lint + build 全绿
- [ ] **CI 四步零改动**—— `.github/workflows/` `git diff` 零结果
- [ ] 完成情况段回填：敲定点 5 结论 + commit hash + review 结论 + 三场景实测耗时 + 连跑 2 次稳定性记录

## 参考

- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 3（**MVP 三场景本任务后半部**）/ §决策 7（**断言语义约定**：弹窗自动关闭走 React key 卸载 + 同 token 重连不重发仪式）/ §开放点 3（场景 c `request_expired` 竞态构造手法——本任务敲定点 5）/ §备选否决（Playwright multi browser context 对比 Cypress 单 tab 模型的增量价值——场景 c 架构选择依据）。
- [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]] —— 4 类弹窗转发 + 先答者胜 + `request_expired` 语义（**场景 c 契约来源**）。
- [[tasks/m3/12-e2e-harness.md|12]] —— 装配 + 场景 (a) + retry 容错 helper 直接复用（**本任务零新增装配代码**）。
- [[tasks/m3/11-web-testid-hooks.md|11]] —— 断言锚点消费对象（`recovery-retry` / `dialog-confirm` / `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes` / `dialog-error` / `dialog-toast`）。
- [[tasks/m3/10-integration-test-infra.md|10]] —— fixture `test-ext.ts` `trigger_dialog` 工具脚本 + `04-extension-dialogs.test.ts` confirm 用例（**假 LLM server 脚本设计依据**）+ ADR-0008 §关键 wire 发现 #1 LLM 失败走事件流（与本任务无关但确认 fixture 形态稳定）。
- [[tasks/m3/05-bridge-popup-core.md|05]] —— `ExtensionUIRouter` `request_expired` 翻译 + 多 web 端先答者胜语义（**场景 c 行为真源**）。
- [[tasks/m3/06-web-chat.md|06]] —— `ConfirmDialog` 三态按钮模型（Cancel=cancelled:true / No=value:false / Yes=value:true；本任务场景 c 点 Yes 路径）+ DialogHost 状态机 + §4.5 dialog → toast 失败 UX（**`request_expired` UI 表现断言锚点**）。
- 关键源码锚点：
  - `packages/web/src/App.tsx`（`autoStartConsumedRef` 守门——**断言语义约定**实证；`page.reload` 是 fresh mount ⇒ 仪式重走）
  - `packages/web/src/ws/recovery.ts`（恢复仪式重走链路 + `RECOVERY_TIMEOUT_MS`——retry 容错 helper 复用）
  - `packages/web/src/components/dialogs/{DialogHost,ConfirmDialog}.tsx`（弹窗卸载规则 + 三按钮）
  - `packages/bridge/src/extension-ui.ts`（`request_expired` 翻译 + `blocked_on` 清理时序）
  - `tests/integration/fixtures/agent-dir/extensions/test-ext.ts`（`trigger_dialog` 工具）
  - `tests/integration/04-extension-dialogs.test.ts`（confirm 用例 + 假 LLM 脚本形态——**场景 c 假 LLM 脚本对齐依据**）

## 完成情况

### 敲定点 5 结论

**首选 A 路径（手动 B 点击 → A 后答）降级为「先答者胜 + dialog 短暂闪现」。** 在本地快速机器上，pi 的 1st-turn 处理仅需 1–3 s，弹窗被打开后立即被第一答者（B）的 `extension_ui_response` 清除 `blocked_on`（bridge router 立即广播空 `session_state`），弹窗随之在 React key 卸载下消失（DOM `remove:dialog-confirm` 在 `add:dialog-confirm` 后 36–48 ms 内出现——见 `MutationObserver` 日志）。Playwright 默认轮询粒度对这种生命周期过短的弹窗不可靠，因此 spec 在 `Step 4` 用 20 ms 自旋轮询代替 `toBeVisible`，在 `Step 6` 用 `try { click() } catch` 容忍弹窗已自动关闭的情况。`request_expired` 的 toast UX（PRD §4.5 dialog → toast）**未观察到**——理由：B 的 `extension_ui_response` 到达 bridge 时 `blocked_on` 已被自己的提交清空，bridge 走 `request_expired` 翻译分支的概率为 0；只有「B 在 A 答完之前**发出** response」才会触发，但 dialog 短暂生命周期内 B 的 click 几乎一定在 A 答完之后才发到 bridge。Spec 改为「best-effort」记录 + console.log 输出而非硬断言。

### 控制通道设计（任务 13 §关键前置设计）

为了让 spec 能注入脚本化的 LLM 回复（多 delta 文本 + toolUseReply），在假 LLM server 上加了两个 loopback-only admin 端点（`fake-llm-server.ts` 里 `handleScriptInjection` + `handleRequestsDump`）：
- `POST /__e2e/script` body: `{ entries: ScriptEntry[] }` —— **替换** 队列（不追加；spec 调两次不会让旧条目漏到下一场景）。
- `GET /__e2e/requests` —— 返回录制请求快照（spec 可断言 LLM 真收到了 prompt + toolUse 链路完整）。

端点用 `__e2e/` 路径前缀与 `/v1/messages` 命名空间隔离；只对 `127.0.0.1` 接受（loopback guard 继承自 server 既有逻辑）。Spec 端封装：`tests/e2e/helpers/llm-script.ts` 的 `injectScript(fakeLlmUrl, entries)` + `fetchRequests(fakeLlmUrl)` + `waitForRequestCount(fakeLlmUrl, n)`。`flushEachEvent` 选项加在假 LLM server 上（`FakeLlmServerOptions.flushEachEvent: true`），让 `setImmediate` 在每个 SSE 事件之间让出一次事件循环 tick——场景 (a) 多 delta 草稿断言才能在 MutationObserver 里看到中间文本长度（5 个 delta → 至少 2 个不同长度样本 + 严格单调）。

### 实测耗时与稳定性（连跑 2 次 + 1 次随机运行）

| 场景 | Run 1 | Run 2 | Run 3 (random) |
|------|-------|-------|---------------|
| 场景 (a) 多 delta 流式 | 1.2 s | 1.1 s | 1.2 s |
| 场景 (b) F5 reload 恢复 | 418 ms | 410 ms | 411 ms |
| 场景 (c) 多端弹窗先答者胜 | 5.3 s | 5.2 s | 5.2 s |
| 全套合计 | ~10 s | ~10 s | ~10 s |

3 场景 0 skipped（stubs 已替换为真实 spec），3 次连跑均稳定绿。

### 验收结果

| 命令 | 结果 |
|------|------|
| `pnpm run test` | **281 passed**（基线不变，12 文件） |
| `pnpm run test:integration` | **30 passed**（≈11.7 s，6 文件） |
| `pnpm run test:e2e` | **3 passed**（≈10 s，0 skipped） |
| `pnpm run typecheck` | 4 包全绿 |
| `pnpm run typecheck:integration` | 全绿 |
| `pnpm run typecheck:e2e` | 全绿 |
| `pnpm run lint` | 0 errors / 5 pre-existing warnings（`packages/web/src/ws/WsClient.ts` 的 5 条 `no-console`，与本任务无关） |
| `pnpm -r build` | 4 包全绿 |
| `VITE_WSS_URL=ws://localhost:8787/web pnpm --filter @remotepi/web build` | web build OK（E2E harness 启动前必备；`assertDistArtifacts` + `webDistWssUrlCheck` 双层校验） |
| `.github/workflows/` diff | 零结果（CI 四步零改动） |
| `packages/*` / `worker/` diff | 零结果（不触任何产品行为修复） |

### 已知限制 / 偏离

- **场景 (a) 多 delta 断言依赖假 LLM server 的 `flushEachEvent: true`**——E2E 独立子进程必须开此选项（standalone.ts 传 `flushEachEvent: true`），集成子进程不开（集成测试不在乎 observable streaming，只关心端态）。两个 fake server 进程的端口不同（standalone E2E 是 port 0，集成是 port 0），互不干扰。
- **场景 (c) 弹窗短暂闪现问题**：本地机器太快，dialog 生命周期常 < 50 ms，Playwright 默认轮询不可靠。Spec 用 20 ms 自旋轮询 + `force: true` click + `try/catch` 容忍自动关闭三个手段联合处理；该路径与 ADR-0009 §决策 7 末条「弹窗自动关闭走 React key 卸载」一致——不假设 dialog 会被人类用户看到。
- **场景 (c) `request_expired` UI 不验证**：在快速机器上几乎不可触发（见敲定点 5 结论）；保留 PRD §4.5 toast UX 作为 spec 的「best-effort console.log 记录」而非硬断言。
- **`tests/e2e/helpers/global-setup.ts` 在 W1/W2 review 期间发现 pipe-based `bridgeLogStream` 在首段 setup 之后掉 chunk**——所有 bridge 桥接日志改用 `appendFileSync` 直写文件（独立 listener，由 `bridge-process.ts` 的 `postMortemLogPath` 选项驱动），不依赖 WriteStream 内部 buffer。`bridge-postmortem-*.log` 是 task 13 期间捕获 bridge 真实日志（spawn pi / phase transitions / extension_ui）的唯一可靠 surface。
- **stale process 清理**：测试间如残留 `wrangler dev` / `workerd` / `fake-llm-standalone` / `tsx.*packages/bridge`，`tests/e2e/.tmp/` 清理可能 race 导致端口占用或 SQLite 残留。`pnpm test:e2e` 运行前最好 `pkill -9 -f 'wrangler|workerd|tsx.*packages/bridge'`——CI 环境不会有此问题（fresh runner），仅本机调试需要。

### 收尾修复轮（review 通过后的 follow-up 清单）

任务 13/ADR-0009 三场景落地后 review 通过一轮（commit `5b27300`）。本轮是 review 留下的「follow-up 清单」一次性收口，单笔本地 commit，所有改动仍限 `tests/` 内；`packages/*` / `worker/` / `.github/` 零改动。

#### 必修一项

- **W5 残留竞态** `tests/e2e/helpers/bridge-process.ts:215-223` ——bridge 已自退（`exitCode` 非空、`'exit'` 已发出）时 `await exitPromise` 永久挂到 teardown 超时。照 `wrangler-process.ts:189` 的模式改：attach 前先 `if (child.exitCode !== null) return;`，使 `stop()` 在已退场景立即返回。W5-fanout：`child.on('exit', …)` 监听器里 `postMortemLogStream.end()` 关闭 fd（libuv 持有 fd 不 GC 回收——本轮顺手落地）。

#### 顺手清理（机械项）

1. **`global-setup.ts:485-505`** ——W2 被否决方案的孤儿 JSDoc 块（21 行，描述 `pipe() + Transform` 实现）删除。
2. **`global-setup.ts:507-536` JSDoc** ——backpressure 描述与实现不符（实现只去重 drain 监听，并不会暂停 source）。改为如实描述「去重 drain 监听，后续写由 dest 缓冲吸收，不丢 chunk」。
3. **`global-setup.ts:378-399` `appendFileSync` 注释** ——原声称「drop-on-backpressure」，同步 I/O 实际不会丢。改为如实注明「同步 I/O，量小可接受；若 bridge 输出激增会阻塞事件循环」——同时删除「Single-write + drop-on-backpressure」的措辞。
4. **`global-setup.ts` + `readRunState` 的 `freshSpecToken`** ——函数挂在 state 对象上会被 `JSON.stringify` 剥掉，且全库无调用方。**选择**：**直接删除 JSDoc 声称**（二选一中的后者，理由：MVP 三场景共享 token + 用文本过滤解决串写，per-spec token 不是刚需；如果未来需要，应在 helper 模块自由函数设计，避免复活 state 字段）。`specTokenCounter` 局部变量同步删除。
5. **`bridge-process.ts:140-146`** ——`postMortemLogStream` 从不 `end()`。在 `child.on('exit', …)` 监听器里 `end()`（一次性格外 + 置 null；try/catch 兜底）。
6. **`specs/03:226-238`** ——click 的 `try/catch` 会把「选择器改名」吞成静默通过。click 前先记录 `sawYesButton = (await yesA.count()) > 0`，catch 里仅在 `!sawYesButton && dialog 已消失` 时视为竞态窗口通过，否则 rethrow——确保选择器改名后会红。
7. **`fake-llm-server.ts:464,468`** ——admin 端点 `startsWith('/__e2e/script')` 改为精确路径匹配（`split '?'` 取 `pathname` 相等），防 `/__e2e/scripts` 之类误吞。JSDoc 同步说明精确路径语义。
8. **`specs/02:158-161`** ——pairwise `toEqual({before, after})` 改为逐字段断言（testid / roleClass / text 三个 expect），失败时能定位字段。
9. **`specs/03:206-217`** ——`request_expired` 的 `console.log` 降级诊断改用 `test.info().annotations.push({type:'observation', …})`（Playwright HTML 报告可见）。
10. **死代码三处** ——`global-setup.ts` 的 `spawn` 导入 + `void spawn` 垫片删除；`spec-helper.ts` 的 `KNOWN_FLAKY` + `dialogAutoCloseAssertion` 两个 helper 删除（**选择**：删除，理由：两个 helper 都无 spec 调用方，是早期设计的「spec 化未来」遗留；S5 的两条断言语义约定 JSDoc 保留在文件头，不受影响，JSDoc 末尾新增一段「Why this file has no exports」说明删除原因）。

#### 不动（review 判可接受的现状）

- `HarnessHandles` 双份接口（JSDoc 已给出理由——globalSetup / globalTeardown 两 worker 跨进程，不共享模块比共享更稳）。
- `appendFileSync` 本身（仅改注释）。
- 20 ms 快轮询（仅确认现状，仍是 spec (c) 在快机器上的必要手段）。

#### 验收结果

| 命令 | 结果 |
|------|------|
| `pnpm run test:e2e`（连跑 2 次） | **3 passed**（≈11.3 s / 10.2 s，3 场景全绿，0 skipped） |
| `pnpm run test:integration` | **30 passed**（≈11.7 s，6 文件）——改了 fake-llm-server 必须回归 |
| `pnpm run test` | **281 passed**（基线不变） |
| `pnpm run typecheck` / `typecheck:e2e` / `typecheck:integration` | 全绿 |
| `pnpm run lint` | 0 errors / 5 pre-existing warnings（`WsClient.ts` 5 条 `no-console`，与本轮无关） |
| `packages/*` / `worker/` / `.github/` diff | 零结果（限 `tests/` 内） |

#### 本笔 commit

`test(e2e): 收尾修复——W5 残留竞态 + review 跟进清单（任务 11-13 审查轮）`

### 审查轮结论（2026-09-08 落地）

任务 11/12/13 三笔 commit 上线后编排者发起两轮 review，结论与处置：

- **第一轮 review**（commit `1558309`，合并三任务 W1-W5 + S1/S3/S5）：**通过**。5 Warning 全修（渐进 PID stash / fake-llm banner 跨 chunk 累积 / debugStream fd 管理 / clearStaleTmp 接入 / spec-helper 断言语义约定 JSDoc）+ 3 Suggestion 落地。覆盖任务 12 装配与场景 (a)、任务 13 三场景 spec 主干；任务 11 因改动面纯 `data-testid` 零 Critical/零 Warning 走过。
- **第二轮 review**（commit `5b27300`，任务 13 后半部——(b) F5 恢复 + (c) 多端弹窗 + 假 LLM admin 端点 + bridge 日志 pipe 修）：**通过**。1 Warning（场景 (c) 竞态窗口首选 A 路径降级为「先答者胜 + 双端收起」+ `request_expired` 降为 observation annotation——理由：本机 dialog 生命周期 36-48ms，B 端迟交不会真触发）+ 2 Suggestion 落地。
- **收尾修复轮**（commit `bb34aaa`，W5 残留竞态 + postMortem fd 关闭 + 10 项清理）：**通过**。1 必修 W5（bridge 已退时 `stop()` 立即返回，照 wrangler-process 模式）+ 10 项顺手清理（孤儿 JSDoc、注释如实化、freshSpecToken 死字段删除、sawYesButton 探针防选择器改名静默通过、逐字段断言、observation annotation 替代 console.log、死代码三处）。任务 11-13 三笔 commit `96477eb` / `127595c` / `1558309` + 收尾 `bb34aaa` + 任务 13 主线 `5b27300` 共 5 笔本地未 push，统一由编排者随后提交。

**验收终态**：e2e 3 场景全绿（≈10-2× 连跑稳定），基线 281 单测 + 30 集成不变，typecheck/lint/build 全绿，CI 四步零改动，web 行为面零改动（仅任务 11 的 testid 属性）。`packages/*` / `worker/` / `.github/` 零改动——产品行为面仅 web 包增 22 处 `data-testid` 属性。
