# M5 UIUX 优化轮（web 渲染结构化 + markdown 渲染 + textarea 输入 + thinking/tool 始终默认折叠 + 持久侧边栏 + token localStorage + Tailwind v4 + 移动端适配）

> 状态：**第一块已定稿并实施收官**（2026-09-11 用户裁定 D1-D7，3/3 任务 done，5 commits 待 push + 验收期 1 gap 修复（toolResult 归并进 toolCall pill，commits `1fa3b82` + `d9c4409`）→ 单测基线 **790**）；**第二块已定稿并实施收官**（2026-09-11 用户裁定 D8-D13，2026-09-12 实施完成 5/5 任务 done，10 个 web commit + 用户并行 ADR-0013 bridge 修复 → 单测基线 **977** / 全仓 **1502**），**待用户 push + 新形态全量手测验收**（侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程）。任务拆至 [[tasks/m5/04-tailwind-v4-intro.md|04]] / [[tasks/m5/05-token-storage.md|05]] / [[tasks/m5/06-app-shell-sidebar.md|06]] / [[tasks/m5/07-mobile-drawer.md|07]] / [[tasks/m5/08-e2e-and-validation.md|08]]。协议基线：[[architecture/protocol/README.md|隧道协议 v3]]（2026-09-08 锁版）；本 PRD **零协议改动 / 零 worker 改动 / 零 shared 改动 / 零 bridge 改动**——纯 packages/web + docs 增量（用户并行的 ADR-0013 bridge 重连状态机修复不在本 PRD 范围，独立热修复）。
>
> **范围说明**：本 PRD 覆盖两块短板——**第一块**（消息渲染 + 输入 + 折叠）已 2026-09-11 实施收官（5 commits 待 push + 1 gap 修复）；**第二块**（持久侧边栏 G5 + token 弹窗 + localStorage G6 + 移动端 G7 + Tailwind v4 G8 + 质量门 G9）2026-09-12 实施收官，任务拆分 04-08 全 done。**第二块实施结果摘要 + D8-D13 核对 + 已接受取舍 + M+ 挂账**详见 [[#修订注记2026-09-12-第二块收官|§修订注记（2026-09-12 第二块收官）]]。

## 背景

M1–M4 收官（34/34 done，2026-09-08 M4 关单 + 2026-09-10 验收期 4 gap 修复闭环）。协议 v3 锁版、多 session 闭环、8 spec e2e 全绿。Web 端体验成为主要短板。

**第一块：消息渲染与输入**（本轮实施）。三大摩擦点：

1. **消息纯文本渲染**——`extractText` 拍平 content array，代码块 / 列表 / 链接 / 表格等结构全丢；assistant 回复中含 markdown 段落时用户看到的是"一坨换行 + `**加粗**`"。
2. **输入框单行 `<input>` 不支持换行**——多行粘贴 / 长 prompt 编辑体验差。
3. **thinking 与正文合并纯文本 / toolCall 段显式 skip 不展示**——用户无法区分推理 / 工具 / 结论，thinking 段淹没在正文流里。

**第二块：导航与适配**（2026-09-11 用户裁定立项 D8-D13，任务拆至 04-08）。第一块收官后剩余四块短板：

1. **ChoicePage 独立路由页，无持久导航**——多会话切换 / work_dir 切换需全屏往返（左侧 sidebar 缺失，每跳一次都是全屏渲染切换）。
2. **token 暴露在 URL hash**——历史记录 / 分享链接 / 服务器日志可见；M3 时代为图简单放在 hash（避免 cookie / 服务器可观察），现在 localStorage 是更合适的位置。
3. **零响应式断点，移动端不可用**——`styles.css` 全程零 `@media`、零 viewport meta；手机打开 = 桌面缩放。
4. **样式层无 utilities 体系**——1280 行手写 CSS 散落各组件，UI 迭代成本高（每改一处都要动 styles.css + className 双跳）。

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

### 第二块（2026-09-11 立项 D8-D13，2026-09-12 实施收官）

- **G5** 持久侧边栏：单页双栏。左侧 sidebar（顶部品牌位 `<h1>RemotePi</h1>` + 横排 tabs：`Sessions` / `WorkDirs`，**默认 Sessions**；底部 bridge 状态 + 设置按钮）；Sessions tab 列当前 work_dir 的 sessions（新建按钮在此、单击即切 → `selectSessionHash` / `newSessionHash` 写 hash、当前 session 高亮）；WorkDirs tab 列目录（当前高亮；DirectoryBrowser 改造成 modal 由此 tab 打开）。右侧对话区 ChatView 不动，顶部 status bar 展示**本 session 状态**（phase badge + queue pills + session 名；`session === 'new'` 显「**新会话**」；bridge 状态从 status bar 移至 sidebar 底部 BridgeStatusBar compact）。
- **G6** Token 弹窗 + localStorage：覆盖式 modal + backdrop 高斯模糊；**无 token 默认打开不可关闭**（无 Esc / 无遮罩点击 / 无 X 按钮；提交 = `tokenStorage.write(value)` + `window.location.reload()`）；已有 token 从设置按钮打开可关闭（Esc / 遮罩 / X 三路关闭；提交 = `tokenStorage.write(value)` + `client.connect(newToken)` 走既有 teardown+swap+openSocket 语义承接自动重连）。token 仅存 localStorage（**key `remotepi.token`**）；**hash 模型整体删除 token 维度（彻底删除，不做任何向后兼容 / 迁移收编——D9 用户明确裁定）**，旧书签 `#<token>` 形态直接失效（UI 提示重新粘贴）。
- **G7** 手机响应式：**<768px 断点**（matchMedia `(max-width: 767px)`）；sidebar 收起为抽屉 + 汉堡按钮（`sidebar-toggle`）；抽屉展开锁主区滚动（`document.body.style.overflow = 'hidden'`）+ 焦点陷阱（`useFocusTrap`，自实现）；手机端 modal 全屏 sheet（`position: fixed; inset: 0` + 圆角移除）；z-index 栈：`toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)`。
- **G8** Tailwind v4 引入：**preflight 全开（D11 用户修订裁定，否决 planner 初稿的 reference/关 preflight 方案）+ 存量 CSS 包入 `@layer components`**（层叠顺序：preflight(base) < 存量(components) < utilities——渐进迁移标准结构，新组件 utilities 可覆盖遗留全局规则）；`@tailwindcss/vite` 插件 + `@import "tailwindcss"` + `@theme` 块（**13 存量 CSS var 全映射** + 新增 `--sidebar-width: 280px`）；暗色模式保留（`@media (prefers-color-scheme: dark)` 13 变量变体不动）；**双轨渐进**（新组件 Tailwind only，存量 1280 行触碰处顺手迁，不强制全量重写——M+ 候选）。
- **G9** 质量门：
  - 单测基线 **790 不回归 + 新增 ≥25**（web 单测 **≥815** 全绿）；
  - 集成 32 零回归；
  - e2e **9 spec × 2** 连跑全绿（8 既有 + 1 新增 09-mobile-drawer 375×667 viewport）；
  - build **首屏 entry 增量 ≤ +30 KB**（基线 253.44 KB → ≤ 283.44 KB）+ **Tailwind utilities CSS 增量 ≤ +30 KB**（基线 16.33 KB → ≤ 46.33 KB）；
  - typecheck / lint / build 全绿；
  - **testid 锚点零增零删**（保留原命名换位置；新组件新 testid 不计入本约束）。

## 非目标

- **不做语法高亮**（D7 defer；M+ 候选）。
- **不接通顶层 `tool_execution_*` 事件存储**（本轮工具展示只用 message content 内 `toolCall` block + 流式 `toolcall_*` delta 分段，见 D3）。
- **不做输入草稿持久化**（D5；M+ 候选）。
- **不加协议 type，不破协议 v3 锁版**（web 侧零协议改动）。
- **worker / bridge / shared 零改动**（纯 packages/web + docs 增量）。
- **不动 e2e 依赖的 testid / className 锚点**——`input-field` / `input-send` / `input-abort` / `message-row` / `message-draft` / `message-body` / `message-role-{role}` / `message-list` 等全部保留，确保 e2e 8 spec 零修改通过。

### 第二块非目标（2026-09-11 立项时确认）

- **不引入 Radix / Headless**（焦点陷阱 / modal / 抽屉自实现——`useFocusTrap` / `useFocusOnClose` / `useBodyScrollLock` 等均为自实现 hook；触发条件挂账：复杂交互组件或 a11y 缺陷时配合 Tailwind 走 shadcn 路线）。
- **不做 token 加密 / 过期 / 自动刷新**——localStorage 明文存（web 侧本就明文走 WSS URL query，token 安全性等价）；过期 / 自动刷新挂账 M+。
- **不做向后兼容 / 迁移**——**不写 `migrateLegacyHashToken`**、**不保留 deprecated 字段读取**、**不提示「即将失效」软过渡**；hash 模型彻底删除 token 维度（D9 用户明确裁定：旧书签 `#<token>` 直接失效，UI 提示重新粘贴新 token）。
- **不强制全量迁移存量 CSS**——1280 行 styles.css 不重写；只触碰处顺手迁（migrate-by-touch）；全量迁移挂账 M+。
- **worker / bridge / shared / 协议零改动**——纯 packages/web + docs 增量（沿用第一块承诺）。
- **M4 雷区零字节 diff**——`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher 五处代码块不动；本任务只动 App.tsx `readAuth` 拼装 + 分支 JSX，不下移 gateMapRef 到 AppShell / Sidebar。
- **第二块不做**：多端实时同步 / session 搜索 / 文件预览 / 导出 / PWA / i18n。

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

## 方案（第二块）

### §1 布局：AppShell（Sidebar + Main）

```
AppShell.tsx（新建）
├─ Sidebar.tsx（新建）
│   ├─ 品牌位 <h1>RemotePi</h1>
│   ├─ 横排 tabs [Sessions] [WorkDirs]（默认 Sessions）
│   ├─ Sessions tab：sessions 列表 + 新建按钮
│   ├─ WorkDirs tab：work_dirs 列表 + 浏览添加按钮（弹 DirectoryBrowser modal）
│   └─ BridgeStatusBar（compact）+ 设置按钮（settings-button）
└─ Main
    ├─ SessionStatusBar（phase badge + queue pills + session 名）
    └─ ChatView / ChoiceLevel1Panel / ChoiceLevel2Panel / RecoveryView
```

- **ChoicePage 拆解**：`ChoiceLevel1Panel`（WorkDirs 槽位 + 浏览按钮）/ `ChoiceLevel2Panel`（Sessions 槽位 + 新建按钮 + 更换目录）——保留 testid，移除自渲染列表（list 渲染职责移至 Sidebar）。
- **hash 仍是唯一路由真相源**——sidebar 是视图层，交互 = 写 hash 触发 `hashchange`；侧边栏不引入独立 session 状态，一切从 `WsClient` bucket 读（沿用 M4 任务 08 SessionBucket 模式）。
- **gateMapRef / handleRefill 仍在 App 层创建**（不下移）——M4 验收期 4th gap 修复路径要求 App 级闭包稳定，详见 [[tasks/m4/08-web-multi-session-store.md#验收期-4th-gap2026-09-09-落档|08 验收期 4th gap]]。
- **ChoicePage 收口为 Panel**——保留 testid、移除自渲染列表；list 渲染走 Sidebar。

### §2 token 架构：localStorage + TokenModal + hash 模型收缩

```
ws/tokenStorage.ts（新建）
├─ const KEY = 'remotepi.token'
├─ read(): string | null      // lazy 访问，StrictMode 安全
├─ write(token: string): void
└─ clear(): void
   （try/catch SecurityError → swallow null）

components/TokenModal.tsx（新建）
├─ props: { mode: 'required' | 'closable', onSubmit?, onClose? }
├─ required 模式：无 Esc / 无遮罩 / 无 X，提交 = write + reload
├─ closable 模式：三路关闭，提交 = write + onSubmit(newToken) 回调
└─ testid：token-input / token-submit（沿用）+ token-modal / token-modal-backdrop / token-modal-close（新增）
```

- **App `readAuth()`** = `{ token: tokenStorage.read(), workDir/session: readAuthFromHash(hash) }`；token 从 localStorage 读，workDir/session 从 hash 读。
- **`connect(newToken)` 既有语义**（teardown + swap + openSocket）承接自动重连——closable 模式提交 = App 层 `tokenStorage.write(newToken) + client.connect(newToken)`。
- **无 token 初始化提交** = `tokenStorage.write(value) + window.location.reload()`（硬刷新触发 App 重新 readAuth → token!==null → App 走正常 recovery 流程）。
- **WsClient 零行为改动**——既有 `connect` / `disconnect` / 重连退避路径不变；仅补 `connect(A) → connect(B)` 钉桩单测（≥3 条：handshake payload 用 B / 旧 socket close / 重连退避用最新 token）。
- **hash.ts 改造**：
  - `AuthFromHash` 接口**删除 `token: string | null` 字段**（彻底删除，不做任何向后兼容 / 迁移收编——D9 用户明确裁定）；
  - `readAuthFromHash` 删除 token 维度解析；
  - `encodeHash` 删除 token 参数；
  - `decideView` 决策表改为 work_dir × session 二维（行：workDir=null+session=null → choiceLevel1 / workDir+session=null → choiceLevel2 / workDir+session → recovery；**tokenPrompt 分支由 App 层 `auth.token === null` 触发**——hash.ts 不再判定 token）；
  - 导航 helpers（`exitSessionHash` / `changeWorkDirHash` / `newSessionHash` / `selectSessionHash` / `selectWorkDirHash`）签名**删除 token 参数**；
  - **退化形态 `session-without-workdir` 告警保留且与 token 无关**（W3 既有告警不变，只是不再提及 token 维度）。

### §3 Tailwind v4：`@tailwindcss/vite` + `@import "tailwindcss"` + `@theme`

```
styles.css（改造）
├─ @import "tailwindcss";                // preflight + utilities 注入
├─ @theme {                              // 13 存量 var 全映射 + --sidebar-width
│   ├─ --color-bg: var(--bg);
│   ├─ --color-surface: var(--surface);
│   └─ ...（13 个变量）
│   └─ --sidebar-width: 280px;
├─ @media (prefers-color-scheme: dark) { ... }   // 暗色变体保留
└─ @layer components {                    // 存量 1280 行整体包入
    /* 既有 .app-shell / .message-row / .input-bar-field ... */
}
```

- **preflight 全开**（D11 用户修订裁定，否决 planner 初稿的 reference/关 preflight 方案）——不在 `@import "tailwindcss"` 后追加 `corePlugins: { preflight: false }` 类的关停选项。
- **存量 1280 行 CSS（`@theme` 块之外）整体包入 `@layer components`**——层叠顺序：`preflight(base) < 存量(components) < utilities`（渐进迁移标准结构，新组件 utilities 可覆盖遗留全局规则）。
- **`@theme` 块** 映射 13 存量 var + 新增 `--sidebar-width: 280px`。
- **暗色 `@media` 变体保留**——不引入 `dark:` 类策略（M+ 候选）。
- **双轨渐进**——新组件 Tailwind only，存量 1280 行触碰处顺手迁（不强制全量重写）；全量迁移挂账 M+。
- **已接受的过渡期视觉差异**：依赖 UA 默认样式的元素（如 `h1` 字号 / `button` 默认 padding / `input` outline / `ul/ol` list bullet 等）会被 preflight 重置——任务 04–08 全程本地不部署，**视觉修缮在收尾任务统一处理或在触碰组件时顺手用 utility 固化**。

### §4 响应式：768px 单断点 + 自实现焦点陷阱 / 抽屉 / modal 全屏化

- **断点**：`window.matchMedia('(max-width: 767px)')` 单断点（`<768px` 判 mobile）；`useIsMobile` hook 封装 + listener 注册 / cleanup（StrictMode 安全）。
- **抽屉**：`Sidebar` 移动端 `position: fixed` + `translate-x` 过渡（收起 `translate-x(-100%)` / 展开 `translate-x(0)`）+ backdrop（`backdrop-filter: blur(4px)`）+ body 滚动锁（`document.body.style.overflow = 'hidden'`）+ `hashchange` 自动收起。
- **焦点陷阱**：`useFocusTrap` hook（自实现，无 Radix / Headless 依赖）—— `Tab` / `Shift+Tab` 在容器内 focusable 元素循环 + 单 focusable 元素不崩 + 关闭归还焦点。
- **modal 全屏 sheet**：`<768px` 时 `TokenModal` / `DirectoryBrowser` 改 `position: fixed; inset: 0` + 圆角移除。
- **z-index 栈**：`toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)`。

## 验收标准（第二块）

- [x] AppShell 双栏布局：`Sidebar`（品牌位 + tabs + 列表区 + BridgeStatusBar + 设置按钮）+ `Main`（SessionStatusBar + ChatView / ChoiceLevel{1,2}Panel / RecoveryView）；侧边栏一切状态从 WsClient bucket 读，**不引入独立 session 状态**
- [x] Sidebar 横排 tabs 默认 `Sessions`；点 session 行触发 `selectSessionHash` 写 hash；点 WorkDirs tab 浏览添加按钮弹 DirectoryBrowser modal
- [x] SessionStatusBar 展示本 session 状态（phase badge 五态 + queue pills + session 名；`session === 'new'` 显「**新会话**」）；bridge 状态移至 sidebar 底部 BridgeStatusBar compact
- [x] TokenModal required 模式不可关闭（无 Esc / 遮罩 / X）；提交 = `write + reload`；closable 模式三路关闭；提交 = `write + connect`
- [x] token 仅存 localStorage（key `remotepi.token`）；hash 模型**整体删除 token 维度**（彻底删除，无向后兼容 / 迁移收编）；旧书签 `#<token>` 形态直接失效，UI 提示重新粘贴
- [x] `AuthFromHash` 删 token 字段 / `decideView` 二维决策表（work_dir × session）/ 导航 helpers 删 token 参数 / `tokenPrompt` 分支由 App 层 `token===null` 触发
- [x] `<768px` 断点 + 汉堡按钮 + 抽屉 + 背景模糊 backdrop + body 滚动锁 + 焦点陷阱（自实现）
- [x] `<768px` TokenModal / DirectoryBrowser 全屏 sheet
- [x] Tailwind v4 引入：`@tailwindcss/vite` 插件 + `@import "tailwindcss"` + `@theme` 13+1 vars + 暗色 `@media` 保留 + 存量 1280 行整体包入 `@layer components` + **preflight 全开**
- [x] 单测 **≥815 全绿**（基线 790 不回归 + 任务 04-07 新增 ≥25）——实测 **web 977 / 全仓 1502**（远超 ≥815 阈值）
- [x] 集成 32 零回归
- [x] e2e **9 spec × 2 连跑全绿**（8 既有 + 1 新增 09-mobile-drawer 375×667 viewport）——实测 19.2s/19.1s
- [x] typecheck 4 包绿 / lint 0 error / `pnpm -r build` 4 包绿
- [x] **build 体积落档**：首屏 entry 增量 ≤ **+30 KB**（基线 253.44 KB → ≤ 283.44 KB）——实测 +13.54 KB；Tailwind utilities CSS 增量 ≤ **+30 KB**（基线 16.33 KB → ≤ 46.33 KB）——实测 +16.34 KB（**双预算达标**）
- [x] **testid 锚点零增零删**核对（grep `data-testid="..."` 与既有清单一致；新组件新 testid 不计入本约束）
- [x] **雷区零字节 diff**：`App.tsx` 只动 `readAuth` 拼装 + 分支 JSX；`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / `gateMapRef` 既有结构零改动（grep 实证）
- [x] 协议 / worker / bridge / shared 零改动（git diff 实证）——**注**：用户并行 ADR-0013 是 bridge 包独立热修复，不属本 PRD 范围
- [ ] 沿用 M2 / M3 / M4 交付约定：所有任务（04-08）本地 commit 不 push，08 验收后由用户手动 `git push origin main` 触发 Actions CD——**保持未勾**：待用户 push 后做新形态全量手测验收（侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程），详见 [[#§10-用户手测清单口径|§10 用户手测清单口径]]。

## 第二块任务拆分

| # | 标题 | 依赖 |
|---|------|------|
| [[tasks/m5/04-tailwind-v4-intro.md\|04]] | Tailwind v4 引入（preflight 全开 + `@layer components` 包裹存量 CSS） | — |
| [[tasks/m5/05-token-storage.md\|05]] | tokenStorage + TokenModal + hash 模型收缩（彻底删除 token 维度） | — |
| [[tasks/m5/06-app-shell-sidebar.md\|06]] | AppShell 双栏 + Sidebar + SessionStatusBar + DirectoryBrowser modal 化 + ChoicePage 收口 | 04 / 05 |
| [[tasks/m5/07-mobile-drawer.md\|07]] | 手机适配：抽屉 + 汉堡 + 焦点陷阱 + 滚动锁 + modal 全屏化 | 04 / 05 / 06 |
| [[tasks/m5/08-e2e-and-validation.md\|08]] | e2e 改写（localStorage seeding）+ 移动端新 spec + 全量验证 + 文档收尾 | 04 / 05 / 06 / 07 |

**依赖链**：
- **04** 独立（CSS 基础设施）；
- **05** 独立（token 模型 + UI）；
- **04** 与 **05** **相互独立、可并行**（CSS 与 token 模型正交）；
- **06 → 04 / 05**（AppShell / Sidebar 等新组件用 Tailwind only 写；TokenModal 组件存在后才能装配）；
- **07 → 04 / 05 / 06**（移动端样式用 Tailwind；接 sidebar-toggle 占位 + TokenModal / DirectoryBrowser 改样式 + 焦点行为）；
- **08 → 04 / 05 / 06 / 07**（E2E × 2 连跑 + 全量验证 + 文档收尾）。

**实施期串行执行**：`04 → 05 → 06 → 07 → 08`（避免 styles.css + App.tsx 冲突；04 / 05 逻辑独立但写盘顺序沿用先底层后上层）。

总计 5 个任务（区间 2-5 内，与 M4 任务 06/07/08 子任务规模可比）。

## 第二块交付约定

沿用 [[prds/m2-tunnel.md#交付约定|M2 / M3 / M4 交付约定]] + [[#交付约定|第一块交付约定]]：所有任务（04-08）只在本地 commit，不 push。08 落地后，用户本地验证（lint / typecheck / test / build + e2e 9 spec × 2 全绿 + 三端联调手测通过）→ 用户手动 `git push origin main` → Actions 首跑 CD（沿用 M4 deploy.yml）。

## 第二块用户操作清单

- **新增配置项**：无（token 迁移 localStorage，旧书签 token 直接失效需用户重新粘贴）。
- **验证**：访问 `https://remote-pi.sankabox.com/`（无 hash）→ 首次弹 TokenModal required → 粘贴 token → reload → 进入 sidebar + 工作区选择；多会话切换走 sidebar 不再跳转；手机端（<768px）汉堡 + 抽屉交互正常。
- **联调手测**：在 PR / current-state 区确认 `pnpm run lint && pnpm run typecheck && pnpm -r build && pnpm test` + `pnpm test:e2e` 全绿；build 体积 ≤ +30 KB（双预算独立测量）记录入 [[current-state.md|current-state]]。

## 第二块风险与实现时核实

- **preflight 视觉差异**（D11 关键边界）：preflight 全开后 UA 默认样式被 reset（`h1` 字号 / `button` 默认 padding / `input` outline / `ul/ol` list bullet 等）——实施期记录差异清单；任务 04–08 全程本地不部署，**视觉修缮在收尾任务统一处理或在触碰组件时顺手用 utility 固化**。
- **token localStorage + 隐私模式**（D9 边界）：浏览器隐私模式 / 第三方 iframe 禁用 localStorage → SecurityError → `tokenStorage` swallow 为 null → App 走 TokenModal required → 用户重新粘贴；**这是退化但合理的兜底**（与"无 localStorage"语义等价）。**06 任务 W1 修复**：`write` 返回 boolean + App 层捕获 `storageError` 内联提示，避免 `write + reload` 死循环。
- **`connect(A) → connect(B)` 行为**（D10 边界）：既有 `connect(token)` 语义为 teardown + swap + openSocket + 重连退避归零；本轮 WsClient 零行为改动，新增钉桩单测覆盖 `connect(A) → connect(B)` 后 handshake payload 用 B / 旧 socket close / 重连退避用最新 token 三条边界。
- **`useFocusTrap` 单 focusable 边界**：单 focusable 元素时不无限循环（`Tab` 停留原焦点）；实施期单测钉桩（含 TokenModal required 模式——input 是唯一 focusable）。
- **抽屉 + body 滚动锁 + 焦点陷阱**（D12 边界）：三件套缺一不可——抽屉展开时锁 body 滚动 + 焦点锁在抽屉内 + backdrop 点击关闭；实施期 unit + e2e 双层验证。**W1 焦点陷阱互斥**（08 任务）：开 modal 强制收抽屉（inert 机制）+ effect 前移 `useFocusTrap`。
- **Tailwind v4 + 存量 CSS 共存期**（D11 边界）：层叠顺序 `preflight(base) < 存量(components) < utilities`——新组件 Tailwind utilities 可覆盖遗留全局规则；存量不动保持视觉一致；触碰处顺手迁。**编排者修正**：`@theme` 块 var() 引用映射（保护既有暗色机制）。
- **z-index 栈**：toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)——抽屉展开时 sidebar 在 dialog-host 之上；TokenModal required 在所有 modal 之上（最高优先级）。
- **旧书签 `#<token>` 直接失效 UI 提示**：App 启动读 hash 拿不到 token → `token===null` → TokenModal required 打开 + 顶部 banner 提示「旧书签 token 已失效，请粘贴新 token」；不静默吞错。
- **protocol v3 零改动承诺**：token 在 WSS URL query 带（既有 M3/M4 路径，与 localStorage 是 web 侧两层缓存关系）；本轮 wire 协议不变；与协议破锁无关。
- **M4 雷区零字节 diff 守护**：`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher 五处代码块不动；06 任务明确不下移 gateMapRef 到 AppShell。

## 第二块相关

[[tasks/m5/04-tailwind-v4-intro.md|04]] / [[tasks/m5/05-token-storage.md|05]] / [[tasks/m5/06-app-shell-sidebar.md|06]] / [[tasks/m5/07-mobile-drawer.md|07]] / [[tasks/m5/08-e2e-and-validation.md|08]] / [[tasks/m4/07-web-choice-page.md|tasks/m4/07 hash.ts 三字段基线]] / [[tasks/m4/08-web-multi-session-store.md|tasks/m4/08 SessionBucket + 雷区代码基线]] / [[architecture/protocol/README.md|协议 v3]] / [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]（e2e 套路）/ [[architecture/decisions/0012-challenge-based-duplicate-bridge-takeover.md|ADR-0012]]（bridge 接管）/ [[architecture/decisions/0013-bridge-reconnect-undici-close-missing-defense.md|ADR-0013]]（用户并行 bridge 重连修复）。

## 决策记录（2026-09-11 用户裁定，D1-D13 全部定稿）

### 第一块 D1-D7（2026-09-11 用户裁定，第一块实施收官）

1. **D1 库选型**：react-markdown@^9 + remark-gfm@^4 + rehype-sanitize@^6；体积预算 **350 KB**（基线 254.40 KB，预估 ~320 KB）。备选 `marked + DOMPurify` 未采纳（失去 React 树优势 + 手写挂载复杂度）。Sanitize 必启——三类攻击向量单测覆盖（`<script>` / `onerror` / `javascript:` URI）。
2. **D2 流式策略**：C2 方案——流式纯文本打字机（不分段、不渲染 markdown），`message_end` 后一次性切 markdown，跳变 ≤100ms。备选流式实时 markdown 未采纳（e2e 单调性断言 + 性能 + 打字机风险三重顾虑）。
3. **D3 折叠实现**：**路线 B**（用户选定）——WsClient `streamingDraft` 分段存储，thinking / tool 流式中即折叠。备选 A（仅终态渲染层分段、流式不折叠——但流式混乱）与 B'（影子累加器——复杂度溢出）未采纳。
4. **D4 工具 pill**：折叠态 = `🔧 + <name>`；展开态 = 参数 JSON + **完整结果**（用户裁定：不截断）；result 缺失显示 `pending…` 提示。
5. **D5 textarea**：`Enter = send` / `Shift+Enter = newline` / 自动增高 `max-height: 200px` / 本轮**不做草稿持久化**（M+ 候选）/ **IME `isComposing` 守卫**。
6. **D6 用户消息纯文本**（含 toolResult）：仅 assistant 走 markdown；user / toolResult 保持 `extractText` 拍平路径不变。
7. **D7 语法高亮**：defer（M+ 候选）；Shiki / Prism 都增加 30-80KB 体积，本轮预算紧张放后。

### 第二块 D8-D13（2026-09-11 用户裁定，第二块定稿 + 任务 04-08 立项；2026-09-12 实施收官）

8. **D8 侧边栏形态**：单页双栏。左侧 sidebar（顶部品牌位 `<h1>RemotePi</h1>` 移入 sidebar 顶部 + 横排 tabs `[Sessions] [WorkDirs]` 默认 Sessions + 底部 BridgeStatusBar compact + 设置按钮）；Sessions tab 列当前 work_dir 的 sessions（新建按钮在此、单击即切 → 写 hash、当前 session 高亮）；WorkDirs tab 列目录（当前高亮；DirectoryBrowser 改造成 modal 由此 tab 打开）。右侧对话区 ChatView 不动，顶部 status bar 展示**本 session 状态**（phase badge + queue pills + session 名），bridge 状态移至 sidebar 底部。**hash 仍是唯一路由真相源**——sidebar 是视图层，交互 = 写 hash 触发 `hashchange`；侧边栏不引入独立 session 状态，一切从 `WsClient` bucket 读。**gateMapRef / handleRefill 仍在 App 层创建**（不下移）——M4 验收期 4th gap 修复路径要求 App 级闭包稳定。备选「侧边栏弹窗式 / 底部 tabbar」未采纳（与 D9 持久化诉求不符；tabbar 形态 M+ 候选）。
9. **D9 token 迁 localStorage + 彻底删除向后兼容**（用户明确裁定，无迁移、无 deprecated、无软过渡提示）：token 仅存 `localStorage`（key `remotepi.token`）；hash 模型整体删除 token 维度（`AuthFromHash` 删 `token` 字段 / `readAuthFromHash` 删 token 维度 / `encodeHash` 删 token 参数 / `decideView` 二维决策表 / 导航 helpers 删 token 参数）——`tokenPrompt` 分支由 App 层 `auth.token === null` 触发。旧书签 `#<token>` 形态直接失效，UI 提示重新粘贴。**不写 `migrateLegacyHashToken`**、**不保留 deprecated 字段读取**——彻底删除。备选「token 仍留 hash（接受 URL 暴露）+ 软过渡提示」未采纳（用户明确要彻底删除）。
10. **D10 TokenModal 两模式**：**required 模式**（首次无 token 默认打开）——**不可关闭**：无 Esc 键关闭 / 无遮罩点击关闭 / 无 X 按钮；提交 = `tokenStorage.write(value) + window.location.reload()`（硬刷新触发 App 重新 readAuth → token!==null → App 走正常 recovery 流程）。**closable 模式**（已有 token 从设置按钮打开）——三路关闭：Esc 键 + 遮罩点击 + X 按钮；提交 = `tokenStorage.write(value) + onSubmit(value)` 回调（App 透传 `client.connect(newToken)` 走既有 teardown+swap+openSocket 语义承接自动重连）。testid：沿用 `token-input` / `token-submit`，新增 `token-modal` / `token-modal-backdrop` / `token-modal-close`；autofocus input。备选「单一 modal + always closable + 启动期 `localStorage.getItem` 轮询」未采纳（轮询架构违反既有 resolver 一次回调范式）。
11. **D11 Tailwind v4 引入**（**用户修订：preflight 全开**，否决 planner 初稿的 reference/关 preflight 方案）：`pnpm --filter @remotepi/web add -D tailwindcss@^4 @tailwindcss/vite@^4` + `vite.config.ts` 加 `@tailwindcss/vite` 插件；`styles.css` 顶部 `@import "tailwindcss"` + `@theme` 块（13 存量 var 全映射 + 新增 `--sidebar-width: 280px`）+ `@media (prefers-color-scheme: dark)` 暗色变体保留；**存量 1280 行 CSS（`@theme` 块之外）整体包入 `@layer components { ... }`**（层叠顺序：`preflight(base) < 存量(components) < utilities`——渐进迁移标准结构，新组件 utilities 可覆盖遗留全局规则）；**preflight 全开**（用户裁定，无关停选项）。**双轨渐进**（新组件 Tailwind only，存量 1280 行触碰处顺手迁，不强制全量重写——M+ 候选）。**已接受的过渡期视觉差异**：依赖 UA 默认样式的元素（`h1` 字号 / `button` 默认 padding / `input` outline / `ul/ol` list bullet 等）会被 preflight 重置——任务 04–08 全程本地不部署，视觉修缮在收尾任务统一处理或在触碰组件时顺手用 utility 固化。**编排者修正**：`@theme` 块 13 变量采用 `var()` 引用映射（非按 planner 初稿字面值映射）——保护 `:root` 与暗色块的 13 变量真值源不被 `@theme` 引入字面值副本破坏。备选「planner 初稿 reference/关 preflight」未采纳（用户修订：preflight 是 v4 默认 reset，关掉即失去 utilities 体系优势）。
12. **D12 响应式与细节**：**768px 单断点**（`window.matchMedia('(max-width: 767px)')` → `<768px` 判 mobile）；sidebar 280px；抽屉 `translate-x` + backdrop（`backdrop-filter: blur(4px)`）+ body 滚动锁 + `useFocusTrap`（自实现，无 Radix / Headless 依赖）；`<768px` TokenModal / DirectoryBrowser 全屏 sheet（`position: fixed; inset: 0` + 圆角移除）；z-index 栈 `toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)`。备选「引入 Radix / Headless」未采纳（自实现挂账触发条件：复杂交互组件或 a11y 缺陷时配合 Tailwind 走 shadcn 路线）。
13. **D13 交互细节默认**：`work-dir-remove` 沿用无确认步骤（直接调 `work_dir_remove` 出站命令，与 M4 任务 07 既有行为一致）；`session-row` 信息密度全保留（status 徽章 / first_message 摘要 / time 三字段，与 M4 ChoicePage level2 既有渲染对齐）；e2e 新增 09 spec 移动端（375×667 viewport）；token 变更自动重连（`client.connect(newToken)` 走既有 teardown+swap+openSocket 语义）；hashchange 自动收起抽屉（监听 hash 变化 → 抽屉收起 + 焦点归还）。

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

## §修订注记（2026-09-12 第二块收官）

### 实施结果摘要

- **任务完成**：**5/5 done**（2026-09-12 实施收官），任务拆至 [[tasks/m5/04-tailwind-v4-intro.md|04]] / [[tasks/m5/05-token-storage.md|05]] / [[tasks/m5/06-app-shell-sidebar.md|06]] / [[tasks/m5/07-mobile-drawer.md|07]] / [[tasks/m5/08-e2e-and-validation.md|08]]；**待用户 push origin/main + 线上新形态全量手测验收**（侧边栏双 tab / token 设置弹窗 / 手机抽屉 / 移动全流程）。
- **10 笔本地 web commit 未 push**（领先 origin/main）：
  - `ec5b8e3` feat(web): M5 任务04 —— Tailwind v4 引入（preflight 全开 + @layer components 双轨地基）
  - `efe265f` feat(web): M5 任务05 —— token 迁移 localStorage + TokenModal + hash 模型收缩（不做向后兼容）
  - `14897e1` feat(web): M5 任务06 —— AppShell 双栏 + 持久 Sidebar + SessionStatusBar + DirectoryBrowser modal 化
  - `cc27d02` fix(web): M5 任务06 review 修复 —— testid 去重 + activeTab 同步 + 双 connect 消除 + 状态条去重
  - `d6ed7be` chore(web): M5 任务06 卫生收尾 —— 注释字面去重 + 遗留 phase/queue 死 CSS 清理
  - `a6fd9ef` feat(web): M5 任务07 —— 移动端适配（抽屉 + 汉堡 + 焦点陷阱 + 滚动锁 + modal 全屏化）
  - `b6a6564` fix(web): M5 任务07 —— 汉堡按钮覆盖全部移动端视图（修复 level1/2 无法打开侧边栏）
  - `be2d894` feat(web): M5 任务08 —— 移动端 e2e spec 09 + 焦点陷阱互斥 + 全量验证
  - `d290be6` chore(web): M5 任务08 polish —— spec 09 断言强化 + 测试计数对账 + 注释校准
- **用户并行提交（不在本 PRD 范围）**：`e391916` + `c02083c`——bridge 重连状态机对 undici close 缺发的防御（ADR-0013，bridge 372→378 测试 +6，详见 [[architecture/decisions/0013-bridge-reconnect-undici-close-missing-defense.md|ADR-0013]]）。这是用户在 M5 第二块实施期间的**独立热修复**，不属本 PRD 第二块 04-08 任务任一；但与第二块 push 动作合并触发——push 后同批生效。
- **零协议改动 / 零 worker 改动 / 零 shared 改动 / 零 bridge 改动承诺兑现**（本 PRD 范围）；PRD §非目标「worker / bridge / shared / 协议零改动」承诺完全兑现（**注**：用户并行 ADR-0013 是 bridge 包独立热修复，不属本 PRD 范围）。
- **关键数字（2026-09-12 终验，d290be6 后）**：

| 指标 | 实测 | 预算/基线 | 状态 |
|------|------|-----------|------|
| 单测（web） | **977**（42 文件全绿） | 790 基线 + ≥25 新增（预估 ≥815） | ✅ |
| 单测（bridge） | **378**（含用户 ADR-0013 +6） | — | ✅ |
| 单测（shared） | **136** | — | ✅ |
| 单测（worker） | **11** | — | ✅ |
| **单测（全仓合计）** | **1502** | — | ✅ |
| 集成 | **32/32** 零回归 | 32 零回归 | ✅ |
| **e2e** | **9 spec × 2 连跑全绿**（19.2s / 19.1s） | 8+1 spec × 2 全绿 | ✅ |
| web 首屏 entry | **266.98 KB raw / 77.87 KB gzip** | M4 基线 253.44 + ≤ +30 KB | ✅ +13.54 KB |
| web CSS | **32.67 KB / 6.92 gzip** | M4 基线 16.33 + ≤ +30 KB | ✅ +16.34 KB |
| markdown 懒 chunk | **170.57 KB** 不变 | — | ✅ |
| AssistantMessageBody 懒 chunk | **2.78 KB** | — | ✅ |
| typecheck | **4 包绿** | 4 包绿 | ✅ |
| lint | **0 error / 5 pre-existing warnings** | 0 error | ✅ |
| build | **4 包绿** | 4 包绿 | ✅ |

**双预算独立测量均达标**：entry +13.54 KB（vs 预算 ≤+30 KB）/ CSS +16.34 KB（vs 预算 ≤+30 KB）。

### D8-D13 实施期核对（无遗漏 / 无新增）

**6 条决策全部落地实施，未遗漏未新增**——见上文「决策记录」节：

- **D8 侧边栏形态**——AppShell / Sidebar / SessionStatusBar / BridgeStatusBar / ChoiceLevel1Panel / ChoiceLevel2Panel 全部落地；hash 仍是唯一路由真相源；gateMapRef / handleRefill 在 App 层不下移（06 任务守卫验证）。
- **D9 token 迁 localStorage + 彻底删除向后兼容**——hash 模型整体删除 token 维度；无 migrateLegacyHashToken / 无 deprecated 字段读取 / 无软过渡提示；旧书签 `#<token>` 直接失效 UI 提示重新粘贴（用户裁定严格落地）。
- **D10 TokenModal 两模式**——required（不可关）+ closable（三路关闭）；autofocus input；testid 全集（token-modal / token-modal-backdrop / token-modal-close + 沿用 token-input / token-submit）。
- **D11 Tailwind v4 preflight 全开**（用户修订裁定落地）——@theme 块 13 变量 **var() 引用映射**（**编排者修正**：非按 planner 初稿字面值映射，保护既有暗色机制）；存量 1280 行 byte-perfect 包入 `@layer components`；7 项视觉差异在 06 任务视图重组中消化。
- **D12 响应式与细节**——768px 单断点（`useIsMobile` hook）+ 抽屉 + 汉堡 + 焦点陷阱（`useFocusTrap` 自实现）+ 滚动锁 + modal 全屏 sheet；z-index 栈 `toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)` 落地；hamburger gap worker 自曝后 MobileTopBar 按 view 分派修复。
- **D13 交互细节默认**——`work-dir-remove` 无确认 / session-row 三字段信息密度保留 / e2e 新增 09 spec 375×667 / token 变更自动重连（client.connect 既有 teardown+swap+openSocket）/ hashchange 自动收起抽屉；W1 焦点陷阱互斥（inert 机制）落地。

### 已接受取舍 / M+ 挂账

#### 显式取舍记录

1. **hook effect wiring 层零单测覆盖**（任务 07）——`useIsMobile` / `useFocusTrap` 的纯函数逻辑（matchMedia 状态机 / focusable 元素查询 / Tab 循环）以纯函数形式可单测；**effect wiring 层**（mount-once listener 注册 / Tab keydown event / 焦点归还）**未引 jsdom**——**显式取舍**：单测覆盖纯函数逻辑，effect wiring 层由 08 任务 e2e 真 DOM 兜底。**ADR-0009 精神的延续**。M+ 候选：若 a11y 缺陷出现或 wiring 复杂化，配合 Tailwind 走 shadcn 路线或引 @testing-library/react-hooks。
2. **存量 1280 行 CSS 未全量迁 Tailwind**（任务 04 双轨渐进）——触碰处顺手迁（migrate-by-touch），不强制全量重写。M+ 候选全量迁移。
3. **`@theme` 块 var() 引用映射**（任务 04 编排者修正）——planner 初稿字面值映射会引入双真相源破坏暗色适配；编排者改 `var(--bg)` 引用形式保护 13 变量真值源。
4. **测试数字笔误**（任务 08 `be2d894`）——commit message 写「`967→978(+11)`」是**笔误**——实际 `963→978(+15)`（两错对消终值正确）。polish `d290be6` 落地后**终值 977**（删 1 条同义反复测试 -1），无差异仅中间过程笔误。详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]。

#### M+ 挂账候选（push 后手测期发现可触发）

1. **Tailwind scanner 发射 22 条未消费 core utility**（~1-1.5 KB）——scanner 默认扫全 `*.{ts,tsx,html}` 触发若干未被引用的 core utility；可走 `@source not` 排除或 `@source inline` 限定扫描范围。M+ 精简候选。
2. **DirectoryBrowser 桌面端无 backdrop**（任务 06）——M4 既有行为保留；M+ 可加 backdrop 与 TokenModal closable 一致。
3. **滚动锁无引用计数服务**（任务 07）——抽屉 / modal 共用 body 滚动锁但无引用计数；单开单关场景下够用，复杂叠加场景未实测。M+ 候选：引入 `useBodyScrollLock` hook + 引用计数。
4. **HamburgerIcon SVG 双处重复**（任务 06/07）——Sidebar 与 MobileTopBar 各定义一份；M+ 候选抽取到 `components/icons/`。
5. **ChoiceLevel2Panel onNewSession 保留未用 prop**（任务 06）——视图重组后 Sidebar 直接接管新建按钮，Panel 的 onNewSession prop 保留兼容但未传值；M+ 候选彻底删除或补充职责（无障碍 / 空态 CTA 等）。
6. **preflight 视觉差异 7 项**已在任务 06 视图重组中消化——若 push 后手测发现遗漏视觉回归，按本修订注记 §已接受的过渡期视觉差异清单逐项核对（[[tasks/m5/04-tailwind-v4-intro.md#完成情况2026-09-12|任务 04 完成情况]]）。

### 用户手测验收（保持未勾）

按 [[#§10-用户手测清单口径|§10 用户手测清单口径]] 风格——**清单保留但不勾选**，验收由用户执行。新形态全量手测要点（涵盖第二块新增能力）：

| # | 用例 | 验收点 | 实施期覆盖 |
|---|------|--------|-----------|
| 1 | **持久侧边栏双 tab** | 桌面（≥768px）打开页面，session/work_dir 切换走 sidebar tab；双 tab 切换 active 高亮正确 | sidebar.test.tsx 钉桩 + e2e 04/05/06 桌面路径 |
| 2 | **token 设置弹窗** | 已有 token 从 sidebar 底部设置按钮打开 → 三路关闭（Esc / 遮罩 / X）；提交 = 立即重连 | token-modal.test.tsx 钉桩 + e2e 08 spec 路径 |
| 3 | **手机抽屉（<768px）** | 移动端打开页面 → 汉堡按钮可见（level1/2/chat/recovery 全视图覆盖——hamburger gap 修复后）→ 点击展开抽屉 + body 滚动锁 + backdrop 模糊 | spec 09 12 test 覆盖（含 inert + 焦点陷阱 + Tab 逃逸防护 + 焦点归还） |
| 4 | **移动端全流程** | 手机端：汉堡 → 抽屉 → token modal（如未设）→ 提交 → level1 → 选择 work_dir → level2 → 新建会话 → chat → 流式 → 折叠 → 关闭抽屉 | spec 09 全流程 test 覆盖 |
| 5 | **required TokenModal 不可关** | 首次访问无 token → TokenModal 弹出 → Esc / 遮罩点击 / X **均无效** → 提交 = reload 后进入正常 recovery | token-modal.test.tsx 钉桩 + spec 09 不可关 test |
| 6 | **旧书签 token 直接失效** | 访问 `#<token>` 形态（hash 含 token）→ App 读 hash 拿不到 token → TokenModal required 打开 + 顶部「旧书签 token 已失效，请粘贴新 token」提示 | D9 实施期钉桩 + UI 文案落地 |
| 7 | **preflight 视觉无回归** | 桌面 / 移动端逐项核验 [[tasks/m5/04-tailwind-v4-intro.md#完成情况2026-09-12|任务 04 视觉差异清单]] 7 项无遗漏回归 | e2e 不含视觉样式断言；需手测 |
| 8 | **隐私模式 write 失败提示** | 浏览器隐私模式（localStorage 不可用）→ 输入 token 提交 → 顶部「localStorage 不可用，请改用隐私模式外浏览器」内联提示（W1 修复） | 06 任务落地钉桩 |

**结论**：**8 条手测清单**——涵盖第二块新增能力（持久侧边栏 + token localStorage + 移动端 + Tailwind + 质量门）+ 第一块 8 条 markdown/textarea/折叠清单（见 [[#§10-用户手测清单口径2026-09-11-第一块收官|§10 用户手测清单口径（2026-09-11 第一块收官）]]）= **M5 总计 16 条手测清单**——实施期单测 + 集成 + e2e 三层覆盖等价（详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]）。**§10 全清单未勾选**——验收由用户执行，push 后访问 `https://remote-pi.sankabox.com/`（无 hash，首次弹 TokenModal required → 粘贴 token → reload → 进入 sidebar）→ 逐条验收。

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
