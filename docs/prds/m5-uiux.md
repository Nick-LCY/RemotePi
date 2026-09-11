# M5 UIUX 优化轮（web 渲染结构化 + markdown 渲染 + textarea 输入 + thinking/tool 始终默认折叠）

> 状态：**已定稿（2026-09-11 用户裁定）**——D1-D7 全部定稿，详见文末「决策记录」。协议基线：[[architecture/protocol/README.md|隧道协议 v3]]（2026-09-08 锁版）；本 PRD **零协议改动 / 零 worker 改动 / 零 shared 改动 / 零 bridge 改动**——纯 packages/web + docs 增量。
>
> **范围说明**：本 PRD 覆盖两块短板中的**第一块**（消息渲染 + 输入 + 折叠）；第二块（侧边栏持久化 + 响应式）由 G5 / G6 标记，**不在本轮任务拆分**，另立批次（roadmap §6 待决问题回收）。所有"第二块"仅在方案段做方向性描述，不展开任务级细节。

## 背景

M1–M4 收官（34/34 done，2026-09-08 M4 关单 + 2026-09-10 验收期 4 gap 修复闭环）。协议 v3 锁版、多 session 闭环、8 spec e2e 全绿。Web 端体验成为主要短板。

**第一块：消息渲染与输入**（本轮实施）。三大摩擦点：

1. **消息纯文本渲染**——`extractText` 拍平 content array，代码块 / 列表 / 链接 / 表格等结构全丢；assistant 回复中含 markdown 段落时用户看到的是"一坨换行 + `**加粗**`"。
2. **输入框单行 `<input>` 不支持换行**——多行粘贴 / 长 prompt 编辑体验差。
3. **thinking 与正文合并纯文本 / toolCall 段显式 skip 不展示**——用户无法区分推理 / 工具 / 结论，thinking 段淹没在正文流里。

**第二块：导航与适配**（PRD 覆盖、另立批次）。两块短板：

- ChoicePage 是独立路由页，**无持久侧边栏**——用户在多会话间切换 / 切换 work_dir 需多一次跳转 + 全屏刷新视图。
- `styles.css` **零 `@media` 断点、无移动适配**——手机 / 平板打开体验差。

## 目标

### 第一块（本轮任务拆分）

- **G1** assistant 消息 markdown 渲染（GFM：代码块 / 表格 / 列表 / 链接 / 自动链接）；**流式期间保持纯文本打字机**，`message_end` 后一次性切换为 markdown（跳变 ≤100ms）。
- **G2** InputBar 升级 textarea：`Enter = 发送` / `Shift+Enter = 换行` / 自动增高 `max-height: 200px` / IME 组合期不误发（`event.nativeEvent.isComposing` 守卫）。
- **G3** thinking 与 toolCall **始终默认折叠**（含流式进行中）：thinking 段 → `<details>` 默认折叠；toolCall 段 → pill + `<details>` 默认折叠（展开 = 参数 JSON + 完整结果不截断）。
- **G4** 质量门：
  - 单测基线不回归且新增 ≥30 条（web 单测 ≥734 全绿）；
  - 集成 32 零回归；
  - e2e 8 spec × 2 连跑全绿；
  - build 体积 ≤ **350 KB**（基线 254.40 KB，预估 ~320 KB——D1 体积预算）；
  - typecheck / lint / build 全绿。

### 第二块（PRD 覆盖、另立批次，不展开）

- **G5** ChoicePage 拆 Sidebar 持久化（工作区 + 会话选择）+ hash 三字段模型保留。
- **G6** 手机响应式：`@media` 断点 + 抽屉式侧边栏 + viewport 检查。

## 非目标

- **不做语法高亮**（D7 defer；M+ 候选）。
- **不接通顶层 `tool_execution_*` 事件存储**（本轮工具展示只用 message content 内 `toolCall` block + 流式 `toolcall_*` delta 分段，见 D3）。
- **不做输入草稿持久化**（D5；M+ 候选）。
- **不加协议 type，不破协议 v3 锁版**（web 侧零协议改动）。
- **worker / bridge / shared 零改动**（纯 packages/web + docs 增量）。
- **不动 e2e 依赖的 testid / className 锚点**——`input-field` / `input-send` / `input-abort` / `message-row` / `message-draft` / `message-body` / `message-role-{role}` / `message-list` 等全部保留，确保 e2e 8 spec 零修改通过。
- **第二块**（侧边栏 + 响应式）不在本轮任务拆分（roadmap §6 待决问题回收）。

## 方案（第一块）

### §1 markdown 渲染（react-markdown 三件套 + sanitize）

```
packages/web/package.json  — react-markdown@^9 + remark-gfm@^4 + rehype-sanitize@^6
```

**为何三件套（D1）**：react-markdown + remark-gfm + rehype-sanitize 提供声明式 GFM 渲染 + 强 sanitize 防护；备选 `marked + DOMPurify` 需要手写挂载 + 失去 React 树优势，未采纳。

**sanitize 必启（D1）**——防三类攻击向量单测覆盖：
- `<script>alert(1)</script>`（标签直插）；
- `<img src=x onerror=alert(1)>`（事件处理器）；
- `[click](javascript:alert(1))`（`javascript:` URI 协议）。

### §2 新建 `AssistantMessageBody` 组件（终态 markdown + 分段折叠）

终态 assistant 消息按 content 形态分支：
- `string` → 旧纯文本路径（`<br>` 拼接，零变更）；
- `array` → 分段渲染：
  - **text 段** → `ReactMarkdown` + `remark-gfm` + `rehype-sanitize`；
  - **thinking 段** → `<details>` **默认折叠**（`<summary>思考过程</summary>` + 内容仍入 DOM，`textContent` 单调增长兼容 e2e 01 spec §6 流式连续性断言）；
  - **toolCall 段** → pill（折叠态 = `🔧 <name>`）+ `<details>` **默认折叠**（展开态 = 参数 JSON + **完整结果**，D4 用户裁定不截断）；result 缺失显示 `pending…` 提示；
  - **未知段** → 纯文本 fallback（`extractText` 同路径），不丢内容。

**自定义 components**（react-markdown `components` prop）：
- `a`：加 `target="_blank" rel="noreferrer"`（外链安全）；
- `code` / `pre`：配 `--code-bg` 变量（styles.css 新增 `.markdown-code` 配色，与深色主题一致）。

**用户消息与 toolResult 保持纯文本路径不变**（D6）——仅 assistant 走 markdown。

### §3 D3 路线 B 分段流式存储（PRD 关键决策）

**WsClient.ts `streamingDraft` 结构改造**：

```ts
// 旧：单一字段
{ text: string }

// 新：分段结构
{ segments: Array<{ type: 'thinking'|'text'|'tool'; text: string;
                    // tool 段额外字段
                    toolCallId?: string;
                    toolName?: string;
                    toolArgs?: string;
                    toolResult?: string; }> }
```

**`handlePiEvent` `message_update` 分支分流累积**：
- `text_delta` → 累积 text 段（追加到最后 text 段 / 新建 text 段）；
- `thinking_delta` → 累积 thinking 段（追加到最后 thinking 段 / 新建 thinking 段）；
- **新增 `toolcall_start` / `toolcall_delta` / `toolcall_end` 捕获** → tool 段（含 `name` / `args` 累积；`toolcall_end` 触发 result 关联占位）。

**不变量钉桩**（review 重点）：
- 单调累积（`setStreamingDraft` 仅追加不截断）；
- `_draftHasDelta` 防重语义不变（M3 任务 06 + M4 任务 08 的 `SessionBucket._draftHasDelta` 守护）；
- `message_end` → `upsertMessage + clearStreamingDraft` 不变；
- snapshot 路由 `setStreamingDraft(null)` 不变；
- **`migratePendingBucket` 五字段判据中 `streamingDraft` 判空逻辑适配新结构**（判 `segments.length === 0` 而非原 `text === ''`），其他四字段（messages / queue / sessionPhase / blockedOn）判据不变（M4 任务 08 已落地）。

**MessageList 流式渲染改按 segments**：
- thinking 段 → 折叠 `<details>`（内容仍在 DOM，`textContent` 单调增长，**e2e 01 spec §6 流式连续性断言保持兼容**——`details` 内文本计入 `textContent`）；
- text 段 → 纯文本 `<br>`（**不打字机变更**——M4 已落地 4th gap 修复的纯文本路径直接复用）；
- tool 段 → 折叠 pill。

**雷区代码（WsClient 流式管线 / stem-refilled / useWsState / gateMap / decideView）除上述 draft 分段与 toolcall 捕获外零改动**，全部现有单测适配后必须全绿。

### §4 textarea 升级（D5）

```html
<input type="text">  →  <textarea rows={1}>
```

- **新建 `useAutoResizeTextarea` hook**（`packages/web/src/hooks/useAutoResizeTextarea.ts`）：`useLayoutEffect` + `scrollHeight` 计算 → `max-height: 200px` / `overflow-y: auto`。
- **`onKeyDown`**：
  - `Enter` 无 `Shift` 且 **非 IME 组合中（`event.nativeEvent.isComposing` 守卫）** → submit；
  - `Shift+Enter` 原生换行；
  - IME 组合期 `Enter` 走原生行为（候选上屏），不触发 submit。
- **`styles.css .input-bar-field` 适配**：`resize: none` / `min-height` / `max-height: 200px` / `overflow-y: auto` / `align-items` 调整（textarea 对齐）。
- **testid `input-field` 保留**——e2e 03 spec 的 `page.fill('input-field')` 对 textarea 兼容（Playwright `.fill()` 同时支持 input / textarea）。
- `placeholders` / `disabled` / `commandError`（5s）/ `settledHint` 行为**全部不变**。

### §5 第二块方向性描述（不展开任务）

- ChoicePage 拆 Sidebar 持久化 + hash 三字段模型保留 + Sidebar 收纳工作区 / 会话两栏；
- `@media` 断点（mobile ≤768px / tablet ≤1024px / desktop >1024px）+ 抽屉式侧边栏 + viewport 检查。

## 验收标准（第一块）

- [x] assistant 消息 markdown GFM 渲染正确（含代码块 / 表格 / 列表 / 链接 / 自动链接）；
- [x] **sanitize 三类攻击向量单测覆盖**（`<script>` / `onerror` / `javascript:` URI）——assistant-message-body §2 共 5 条（`<script>` / `<img onerror>` / `[javascript:](...)` / `<a href="data:…">` / `<iframe>`+`<style>`），三类字面要求超额覆盖；
- [x] 流式打字机不丢，**e2e 01 spec §6 单调性全绿**（`details` 内文本计入 `textContent`）—— 详见 [[tasks/m5/03-e2e-and-validation.md#重点回归|任务 03 重点回归]]；
- [x] textarea 四行为：Enter=send / Shift+Enter=newline / 自动增高 max 200px / IME `isComposing` 守卫——含 Safari keyCode 229 防御（review Round1 W4 落地，详见 [[tasks/m5/02-web-input-textarea.md|任务 02]]）；
- [x] thinking / toolCall 终态 + 流式均**默认折叠**——终态 `AssistantMessageBody` `<details>` 默认折叠；流式 `ChatView` `StreamingDraftBody` 同 `<details>` 默认折叠；
- [x] **单测 ≥734 全绿**（基线 704 + 新增 ≥30）——实测 **765**（+61，含 assistant-message-body 28 / input-bar-keydown 9 / use-auto-resize-textarea 7 / 既有用例分段结构适配与新增 ~17；30 文件全绿）；
- [x] 集成 32 零回归；
- [x] e2e 8 spec × 2 连跑全绿（两轮各 14.5s，无 flaky 无重跑）；
- [x] typecheck / lint / build 全绿（lint 0 error / 5 pre-existing warnings WsClient.ts no-console）；
- [x] **build ≤ 350 KB 并记录**到 [[current-state.md|current-state]]——**首屏 entry 250.76 KB raw / 73.37 KB gzip**（较 M4 基线 254.40 KB -3.64 KB）达标，详见下文「§修订注记（2026-09-11 第一块收官）」D1 预算口径解释；
- [x] 雷区除 D3 声明的分段改动外零字节 diff——既有用例零修改通过；
- [ ] **testid 锚点 grep 一致**——已 grep `data-testid="input-field|input-send|input-abort"` / `class="message-row|message-draft|message-body|message-list"` 全命中 0 增 0 删；**用户线上手测验收**保持未勾——待用户 push + 手测 markdown 渲染 / textarea 换行 / thinking-tool 折叠（详见 [[#§10-用户手测清单口径2026-09-11-第一块收官|§10 用户手测清单口径]]）。

## 任务拆分

| # | 标题 | 依赖 |
|---|------|------|
| [[tasks/m5/01-web-markdown-render.md\|01]] | web 渲染层结构化 + markdown 渲染 + thinking/tool 可折叠（含流式分段存储） | — |
| [[tasks/m5/02-web-input-textarea.md\|02]] | InputBar textarea 升级（换行 + 自动增高 + IME 守卫） | — |
| [[tasks/m5/03-e2e-and-validation.md\|03]] | E2E × 2 + 全量验证 + 文档收尾 | 01 / 02 |

**依赖链**：
- **01** 独立（流式分段存储 + 渲染层结构化 + markdown）；
- **02** 独立（InputBar textarea 升级，与 01 零代码交集）；
- 01 与 02 **相互独立、串行执行**（避免 styles.css 冲突）—— 实施期先 01 后 02 顺序写盘；
- **03 → 01 / 02**（E2E × 2 连跑 + 全量验证 + 文档收尾）。

总计 3 个任务（区间 2-4 内，与 M4 任务 06/07/08 子任务规模可比）。

## 交付约定

沿用 [[prds/m2-tunnel.md#交付约定|M2 / M3 / M4 交付约定]]：所有任务（01-03）只在本地 commit，不 push。03 落地后，用户本地验证（lint / typecheck / test / build + e2e 8 spec × 2 全绿 + 三端联调手测通过）→ 用户手动 `git push origin main` → Actions 首跑 CD（沿用 M4 deploy.yml）。

## 用户操作清单

- **无新增配置**——本轮 web 侧零协议改动，桥 / worker / 配置零变更。
- **验证**：访问 `https://remote-pi.sankabox.com/#<token>` → 任一会话 → assistant 回复含 markdown / 代码块 / 列表可见样式；thinking 段默认折叠（点击展开）；toolCall 段以 `🔧 <name>` pill 默认折叠（点击展开 = 参数 JSON + 完整结果）；输入框 Enter 发送 / Shift+Enter 换行 / 长 prompt 自动增高 / 中文拼音组合期 Enter 不误发。
- **联调手测**：在 PR / 当前-state 区确认 `pnpm run lint && pnpm run typecheck && pnpm -r build && pnpm test` + `pnpm test:e2e` 全绿；build 体积 ≤ 350 KB 记录入 [[current-state.md|current-state]]。

## 风险与实现时核实

- **`<details>` 内 `textContent` 单调性兼容**（D3 关键边界）：e2e 01 spec §6 流式连续性断言走 `message-draft` 的 `textContent`——`<details>` 内文本计入 `textContent`（`details` 默认折叠仍计入子节点 `textContent`，**不**因 `open` 属性变化而重置）；实施期单元 + e2e 双层验证。
- **分段累积的 React 渲染性能**（D3 边界）：message_update 频率高（每帧 1-3 次 delta），分段累积意味着每次 `setStreamingDraft` 重建 segments 数组 + 触发 React 重渲染——`useWsState` 的 useCallback memoization（M4 任务 08 修复）+ 段内文本拼字符串（不切片）控制 O(n) 增长；如有性能问题挂账 M+。
- **`toolcall_start` / `toolcall_delta` / `toolcall_end` 协议事件对齐**（D3 关键边界）：本轮**不破协议**（协议 v3 零改动），toolcall 事件为 pi 原生 wire 已在 message content 内的 `toolCall` block 流式 delta——WsClient 解析 message content 的 type 字段分流；实施期核对真 pi wire 输出对齐。
- **`migratePendingBucket` 五字段判据适配**（M4 任务 08 沿用）：判 `segments.length === 0` 而非原 `text === ''`；既有用例的 stub fixtures 需更新字段名（不改判据语义）。
- **textarea `autosize` 与 max-height 200px 边界**（D5）：超长内容触发滚动条而非无界增高——实施期实跑 200 行 prompt fixture 验证。
- **IME `isComposing` 守卫跨浏览器**（D5 边界）：Chromium / Firefox / Safari `event.isComposing` 实现差异——主流桌面浏览器一致，实施期单测覆盖 chromium（Playwright default）。
- **`rehype-sanitize` schema 默认值**（D1 风险）：react-markdown 9.x + rehype-sanitize 6.x 默认 schema 允许 `href` / `target` / `rel`——验证 `target="_blank"` 在默认 schema 内通过；否则扩展 schema。
- **build 体积 ≤350 KB**（D1 风险）：react-markdown + remark-gfm + rehype-sanitize 预估 +65 KB（gzip 前）；若超预算可走两条减重路径：① 切 `react-markdown/lib/react-markdown.min.js` + 取消 ESM tree-shaking fallback；② 改 `marked + DOMPurify`（D1 备选已否，本轮不再回退）。
- **testid 锚点不动**（硬约束）：`input-field` 保留 textarea 元素（Playwright `.fill()` 兼容）；其余锚点全 grep 一致。
- **第二块（G5 / G6）不展开任务**：ChoicePage 拆 Sidebar + `@media` 适配在 M5 收官后另立批次，roadmap §6 待决问题回收。

## 相关

[[architecture/protocol/README.md|协议 v3]] / [[architecture/protocol/envelope.md]] / [[architecture/protocol/control.md]] / [[architecture/protocol/pi.md]] / [[prds/m1-infrastructure.md|M1 PRD]] / [[prds/m2-tunnel.md|M2 PRD]] / [[prds/m3-single-session.md|M3 PRD]] / [[prds/m4-multi-session.md|M4 PRD]] / [[roadmap.md|路线图]] / [[current-state.md]] / [[tasks/README.md|tasks/README]] / [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]（e2e 套路）/ [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]]（集成套路）

## 决策记录（2026-09-11 用户裁定，全部定稿）

1. **D1 库选型**：react-markdown@^9 + remark-gfm@^4 + rehype-sanitize@^6；体积预算 **350 KB**（基线 254.40 KB，预估 ~320 KB）。备选 `marked + DOMPurify` 未采纳（失去 React 树优势 + 手写挂载复杂度）。Sanitize 必启——三类攻击向量单测覆盖（`<script>` / `onerror` / `javascript:` URI）。
2. **D2 流式策略**：C2 方案——流式纯文本打字机（不分段、不渲染 markdown），`message_end` 后一次性切 markdown，跳变 ≤100ms。备选流式实时 markdown 未采纳（e2e 单调性断言 + 性能 + 打字机风险三重顾虑）。
3. **D3 折叠实现**：**路线 B**（用户选定）——WsClient `streamingDraft` 分段存储，thinking / tool 流式中即折叠。备选 A（仅终态渲染层分段、流式不折叠——但流式混乱）与 B'（影子累加器——复杂度溢出）未采纳。
4. **D4 工具 pill**：折叠态 = `🔧 + <name>`；展开态 = 参数 JSON + **完整结果**（用户裁定：不截断）；result 缺失显示 `pending…` 提示。
5. **D5 textarea**：`Enter = send` / `Shift+Enter = newline` / 自动增高 `max-height: 200px` / 本轮**不做草稿持久化**（M+ 候选）/ **IME `isComposing` 守卫**。
6. **D6 用户消息纯文本**（含 toolResult）：仅 assistant 走 markdown；user / toolResult 保持 `extractText` 拍平路径不变。
7. **D7 语法高亮**：defer（M+ 候选）；Shiki / Prism 都增加 30-80KB 体积，本轮预算紧张放后。

## 修订注记（2026-09-11 第一块收官）

### 实施结果摘要

- **任务完成**：3/3 done（[[tasks/m5/01-web-markdown-render.md|01]] / [[tasks/m5/02-web-input-textarea.md|02]] / [[tasks/m5/03-e2e-and-validation.md|03]]），2026-09-11 实施收官，**待用户手动 push origin/main + 线上手测验收**（详见 [[#§10-用户手测清单口径2026-09-11-第一块收官|§10]]）。
- **5 笔本地代码 commit 未 push**（领先 origin/main 6 commits，含早期 docs commit `84c13b3`）：
  - `926ae9c` feat(web): M5 任务01 —— markdown 渲染 + 流式分段存储 + thinking/tool 折叠
  - `1d08230` fix(web): 任务01 review 修复 —— tool args 新引用契约 + markdown chunk 真懒加载 + 判空语义对齐
  - `b1041e8` test(web): 任务01 验证轮收尾 —— e2e 懒加载竞态等待 + orphan 引用契约钉桩
  - `f28295f` feat(web): M5 任务02 —— InputBar textarea 升级（换行 + 自动增高 + IME 守卫）
  - `0594767` fix(web): 任务02 review 收尾 —— 测例去重 + Safari 229 防御 + 契约措辞校准
- **零协议改动 / 零 worker 改动 / 零 shared 改动 / 零 bridge 改动**——纯 packages/web + docs 增量；PRD §非目标「worker / bridge / shared 零改动」承诺完全兑现。
- **关键数字（2026-09-11 终验）**：单测 **704 → 765**（+61，30 文件全绿）/ 集成 **32/32 零回归** / e2e **8 spec × 2 连跑全绿**（两轮各 14.5s，无 flaky 无重跑）/ typecheck **4 包绿** / lint **0 error / 5 pre-existing warnings** / `pnpm -r build` 4 包绿。详见 [[tasks/m5/03-e2e-and-validation.md#关键数字终验2026-09-11|任务 03 关键数字]]。

### D1 体积预算口径解释

PRD §1 字面口径为「build ≤ 350 KB」未细化按总产出 / 首屏 entry / 懒 chunk 触发量三种口径。本轮落地采用**首屏 entry 口径**作为预算达标判据——理由：现代 SPA 体积预算业界通行做法（首屏代码即阻塞渲染的代码，懒加载 chunk 不阻塞首屏 LCP / FCP），350 KB 预算意图是「首屏加载不卡顿」而非「全部代码不超标」。具体数字：

- **首屏 entry**：250.76 KB raw / **73.37 KB gzip**（较 M4 基线 254.40 KB **-3.64 KB**）——**达标**（≤ 350 KB）。
- **懒加载 chunk**（首屏不加载，首次终态 assistant 渲染前后台预热）：
  - `markdown` chunk：170.57 KB raw / 52.47 KB gzip——`react-markdown@^9` + `remark-gfm@^4` + `rehype-sanitize@^6` 三件套全 graph，`manualChunks` 切包 + `React.lazy` + `ChatView` mount 预热带 + `modulePreload` 剔除。
  - `AssistantMessageBody` chunk：2.47 KB。
- **css**：16.33 KB。
- **懒 chunk 全触发总量**：440.52 KB raw / 130.54 KB gzip——gzip 增量约 50 KB，与 PRD 预估 ~320 KB（含 markdown 三件套 +65 KB）口径基本一致。

**偏离与注记**：本轮实施把 markdown 三件套全 graph 走 `React.lazy` 切包 + 预热带（review Round1 W1 落地）——而非 PRD §1 字面隐含的「全部进 entry」假设。如用户要求严格按「build 总产出 ≤ 350 KB」口径，需进一步走 `marked + DOMPurify` 备选（D1 已否）或对 markdown 三件套做精细 tree-shaking（M+ 候选）；当前首屏 73.37 KB gzip 体感良好，登记备查。

### 已接受的视觉微移

- **InputBar 单行态 Send/Abort 按钮较原 `<input>` `center` 对齐下移 2-4px**——textarea `align-items: flex-end` 让单行态按钮与原 `<input>` `align-items: center` 对齐产生 2-4px 微移。**取舍**：多行态 `flex-end` 与 textarea 多行底沿对齐（更整齐）；单行态 `center` 与 `<input>` 居中对齐（按钮水平居中）。**已接受**为多行态对齐收益——M+ 候选：CSS `:has(textarea:placeholder-shown)` 切换 `align-items` 走单行/多行两态。当前 2-4px 微移不影响可读性 / 可点击区域，登记备查，详见 [[tasks/m5/02-web-input-textarea.md#设计注记实施期发现--备查|任务 02 设计注记]]。

### 两条设计注记

1. **`streamingDraftIsEmpty` 判空边界**（D3 路线 B 实施期发现）——按段**内容**判空（任意段 `text || args || name` 非空即非空），而非按段**类型**。**trade-off**：toolcall_start 已到 / delta 未到的极端时序下，pill 名 `tool.name` 不计入内容，导致该 pill 在 `migratePendingBucket` 迁移时会丢失（不渲染）。**触发概率极低**——要求 `toolcall_start` 与 `migratePendingBucket`（`session_state` 到达）在 ~ms 级时序重叠且中间无任何 `toolcall_delta`；当前 web UI 单端观察未触发，登记备查（M+ 候选：把 `tool.name` 也计入「内容」或把迁移窗口收紧到 `message_end` 之后）。详见 [[tasks/m5/01-web-markdown-render.md#设计注记实施期发现--备查|任务 01 设计注记 1]]。
2. **markdown chunk 懒加载 vs 首屏预热**（D1 实施期发现）——原 `chat-view` mount 时立即 `import('react-markdown')` 走 `React.lazy` → 首屏 cold 路径 markdown chunk 未就绪导致终态消息首次渲染闪空 → 修 `ChatView` mount 预热带（`import('react-markdown')` fire-and-forget）+ e2e 02 spec `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染完成再断言。**e2e 02 spec 实测由「轮询 `.message-body` textContent 对账」改为「等待 markdown chunk 渲染 + textContent 对账」**——加挂等待助手不等同于失败重试（沿用 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §开放点 1 哲学）。详见 [[tasks/m5/01-web-markdown-render.md#设计注记实施期发现--备查|任务 01 设计注记 2]]。

### 决策记录 D1-D7 核对（无遗漏 / 无新增）

7 条决策全部落地实施，未遗漏未新增——见上文「决策记录」节。D1 / D3 / D4 / D5 / D6 / D7 实施期偏离详见本修订注记。

## §10 用户手测清单口径（2026-09-11 第一块收官）

> 沿用 [[prds/m4-multi-session.md#§10-用户手测清单口径|M4 PRD §10]] 风格——**清单保留但不勾选**，验收由用户执行。本节列出 M5 第一块实施后用户线上手测清单 8 条。

| # | 用例 | 验收点 | 实施期覆盖 |
|---|------|--------|-----------|
| 1 | **markdown 渲染** | 任一会话，assistant 回复含 markdown（代码块 / 表格 / 列表 / 链接 / 自动链接）——可见样式（`<pre><code>` 等宽 + 表格边框 + 列表符号 + 链接下划线 + 裸 URL 自动识别）；外链点击新窗口打开（`target="_blank" rel="noreferrer"`）；**sanitize 安全**：复制 `<script>alert(1)</script>` / `<img src=x onerror=alert(1)>` / `[click](javascript:alert(1))` 等攻击向量到 prompt，assistant 回显后**不**触发弹窗 / 不渲染标签 | e2e 01 spec §6 流式 + 02 spec History verification 覆盖 markdown chunk 渲染对账；assistant-message-body §1 GFM 渲染（9 条）+ §2 sanitize 攻击向量（5 条）覆盖 |
| 2 | **thinking 段默认折叠** | 任一会话，assistant 回复含 reasoning 段（`<details>` 默认折叠）；点击展开 = 看到完整推理文本，再次点击收起 | assistant-message-body §3.1 钉桩 + web e2e 实测 |
| 3 | **toolCall 段默认折叠（pill）** | 任一会话，assistant 调用工具（如 `read` / `bash`）——折叠态显示 `🔧 <name>` pill；点击展开 = 参数 JSON + **完整结果**（D4 不截断）；result 缺失显示 `pending…` 提示 | assistant-message-body §3.2 / §3.3 钉桩 + web e2e 实测 |
| 4 | **流式期间 thinking / tool 默认折叠** | 流式打字机期间，thinking / toolCall 段即折叠（不展开 = 不影响打字机滚动）；`textContent` 单调增长（流式连续性断言保持兼容） | 任务 01 ChatView `StreamingDraftBody` 钉桩 + e2e 01 spec §6 流式 `textContent` 单调性 重点回归 |
| 5 | **textarea Enter = 发送** | 输入框输入文字，按 Enter → 发送；点击 Send 按钮亦可 | input-bar-keydown §1.1 钉桩 + e2e 03 spec `page.fill('input-field')` + `input-send` click |
| 6 | **textarea Shift+Enter = 换行** | 输入框输入文字，按 Shift+Enter → 换行（不打字）；连续多行输入验证自动增高 | input-bar-keydown §2.1 钉桩 + styles.css `--input-max-height: 200px` + e2e 实测 |
| 7 | **textarea 自动增高 max 200px** | 长 prompt 输入（超 200px），textarea 触发滚动条而非无界增高；清空内容回单行 | use-auto-resize-textarea §1.1 / §1.4 / §1.5 钉桩 + e2e 实测 |
| 8 | **textarea IME `isComposing` 守卫** | 中文拼音输入法组合期按 Enter → 候选上屏（不打字，不发消息）；组合完成后再按 Enter 才发送；Safari 路径同（keyCode 229 防御）| input-bar-keydown §3.1 / §3.2 + Safari §3.2 钉桩 + e2e 实测 |

**结论**：**8 条手测清单**（覆盖 markdown 渲染 / 三类折叠 / textarea 四行为 + 流式连续性 / IME 守卫）——实施期单测 + 集成 + e2e 三层覆盖等价（详见 [[tasks/m5/03-e2e-and-validation.md#重点回归|任务 03 重点回归]]）。**§10 全清单未勾选**——验收由用户执行，push 后访问 `https://remote-pi.sankabox.com/#<token>` → 任一会话逐条验收。
