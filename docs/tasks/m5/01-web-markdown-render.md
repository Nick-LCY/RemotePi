---
prd: prds/m5-uiux.md
status: done
---
# 任务：web 渲染层结构化 + markdown 渲染 + thinking/tool 可折叠（含流式分段存储）

## 目标
按 [[prds/m5-uiux.md|M5 PRD §1 / §2 / §3 + 验收标准 + D1 / D3 / D6]] 落地 M5 第一块核心：

1. **WsClient.ts 流式分段存储**（D3 路线 B）——`streamingDraft` 从 `{ text: string }` 改为 `{ segments: Array<{type:'thinking'|'text'|'tool'; text: string; ...tool 字段}> }`；`handlePiEvent` `message_update` 分支分流累积（text_delta / thinking_delta / **新增 toolcall_start / delta / end 捕获**）；`migratePendingBucket` 五字段判据中 streamingDraft 判空逻辑适配新结构（segments 非空判据）；不变量（单调累积 / `_draftHasDelta` / message_end / snapshot / segments 数组重建 useCallback memoization）全部钉桩；雷区代码（WsClient 流式管线 / stem-refilled / useWsState / gateMap / decideView）除上述 draft 分段与 toolcall 捕获外**零改动**，全部现有单测适配后必须全绿。
2. **ChatView MessageList 流式按 segments 渲染**——thinking 段折叠 `<details>`（内容仍在 DOM，`textContent` 单调增长兼容 e2e 01 spec §6 流式连续性断言）/ text 段纯文本 `<br>`（**不打字机变更**——M4 已落地 4th gap 修复的纯文本路径直接复用）/ tool 段折叠 pill。
3. **新建 `AssistantMessageBody.tsx`**（终态 markdown + 分段折叠 + sanitize + 自定义 a/code/pre）——终态 assistant 消息按 content 形态分支：string 旧纯文本路径；array 分段渲染（text 段 `ReactMarkdown` + `remark-gfm` + `rehype-sanitize`；thinking 段 `<details>` 默认折叠；toolCall 段 pill + `<details>` 默认折叠，展开 = 参数 JSON + **完整结果**——D4 不截断；未知段纯文本 fallback）。
4. **`styles.css` 新增 markdown / 折叠 / pill 样式**（`.markdown-code` / `.markdown-table` / `.message-thinking-details` / `.message-tool-pill` / `.message-tool-details`）+ `--code-bg` 变量。
5. **依赖三件套**（D1）：`packages/web/package.json` 增 `react-markdown@^9` + `remark-gfm@^4` + `rehype-sanitize@^6`。
6. **用户消息与 toolResult 保持纯文本路径不变**（D6）——仅 assistant 走 markdown。

## 完成标准
- [x] `packages/web/package.json` 增 `react-markdown@^9` + `remark-gfm@^4` + `rehype-sanitize@^6`；`pnpm install` 绿
- [x] `packages/web/src/ws/WsClient.ts`：`streamingDraft` 改 `{ segments: Array<...> }` 结构；`handlePiEvent` `message_update` 分支分流累积（text_delta / thinking_delta / **新增 toolcall_start / delta / end**）；`migratePendingBucket` 五字段判据中 streamingDraft 判空逻辑适配新结构（segments 非空判据）
- [x] 既有 WsClient 流式管线 / stem-refilled / useWsState / gateMap / decideView **除上述 draft 分段与 toolcall 捕获外零字节 diff**；既有 WsClient 单测适配新结构、判据不变全部通过
- [x] `packages/web/src/components/ChatView.tsx`：`MessageList` 流式按 segments 渲染（thinking 折叠 details / text 纯文本 / tool 折叠 pill）；终态 assistant 消息挂载 `AssistantMessageBody`
- [x] **新建 `packages/web/src/components/AssistantMessageBody.tsx`**：按 content 形态分支（string → 旧路径；array → 分段渲染；未知段纯文本 fallback）；自定义 `a` (target=_blank rel=noreferrer) / `code` / `pre` (配 --code-bg)
- [x] `packages/web/src/styles.css`：新增 `.markdown-code` / `.markdown-table` / `.message-thinking-details` / `.message-tool-pill` / `.message-tool-details` 样式 + `--code-bg` 变量；既有 `.input-bar-field` / `.message-row` / `.message-body` 等 testid 锚点不动
- [x] **新建 `packages/web/src/hooks/useAutoResizeTextarea.ts`** 由 [[tasks/m5/02-web-input-textarea.md|02-web-input-textarea]] 落地；本任务不冲突
- [x] **新增 `assistant-message-body.test.tsx` ≥25 条**（含 sanitize 三类攻击向量 ×3、thinking / toolCall 折叠、string / 未知段 / null fallback）；**web-state-bucket 既有 44 条适配新结构、判据不变全部通过**
- [x] 既有 web **185 条不回归**
- [x] **testid 锚点不动**：grep `input-field|input-send|input-abort|message-row|message-draft|message-body|message-role|message-list` 全文件命中锚点 0 增 0 删
- [x] `pnpm --filter @remotepi/web build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿
- [x] web build **≤ 350 KB**（D1 预算，记录入 [[current-state.md|current-state]]）

## 依赖
- 无（web 单端改动；worker / bridge / shared 零改动）

## 参考
- [[prds/m5-uiux.md|M5 PRD §1 / §2 / §3 / 验收标准 / D1 / D3 / D4 / D6 / D7]]
- [[tasks/m4/08-web-multi-session-store.md|tasks/m4/08]] SessionBucket + `migratePendingBucket` 五字段判据基线
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] e2e 01 spec §6 流式连续性断言基线
- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] e2e 套路 + testid 抓手

## 完成情况（2026-09-11）

任务完成，**2 笔本地 commit 未 push**（沿用 M2 / M3 / M4 交付约定，本任务入档后与 02 / 03 同列，**M5 第一块全部 5 笔代码 commit 在 03 验收后由用户 push** 触发 Actions CD；详见 [[current-state.md#活跃需求|活跃需求]] M5 行）。

### Commit 链

- **`926ae9c`** feat(web): M5 任务01 —— markdown 渲染 + 流式分段存储 + thinking/tool 折叠（落地包三件套 + WsClient segments 分段结构 + toolcall_start/delta/end 捕获 + ChatView 三段渲染 + AssistantMessageBody 新建 + styles.css 配套 + 28 条 assistant-message-body.test.tsx + web-state-bucket §8.x 17 条新覆盖）。
- **`1d08230`** fix(web): 任务01 review 修复（Round1 → Round2 共 5 项）——C1 `appendToolArgs` 原位变更不触发重渲染，修为 `slice()` 新引用 + 单 emit；W1 markdown chunk 真懒加载（`React.lazy` + `ChatView` mount 预热带 + `manualChunks` 切包 + `modulePreload` 剔除）；W2 orphan 双 emit（`appendToolArgs` 单 emit）；W3 判空语义对齐（`streamingDraftIsEmpty` 按段内容判空，**tool.name 不计入**）；S3/S5 措辞校准。

### 实施要点

- **WsClient `streamingDraft` 改 `{ segments: Array<{ type:'thinking'|'text'|'tool'; text: string; toolCallId?: string; toolName?: string; toolArgs?: string; toolResult?: string }> }`**；`handlePiEvent` `message_update` 分支按 `text_delta` / `thinking_delta` / 新增 `toolcall_start` / `toolcall_delta` / `toolcall_end` 分流累积；`migratePendingBucket` 五字段判据改 `streamingDraftIsEmpty(pending.streamingDraft) && ...`（按段内容判空，详见下文「设计注记」）。
- **不变量全部钉桩**：单调累积（`setStreamingDraft` 仅追加，§8.2 钉桩）/ `_draftHasDelta` 语义不变（`toolcall_end` 不 arm，§8.12 钉桩）/ `message_end` 清 draft（§8.13）/ snapshot 清 draft（§8.14）/ 判空与 M3 等价（§8.16）。**既有 44 条 WsClient 单测全部通过**（web-state-bucket.test.ts §8 段共 17 条 + §7 段既有 5 条 stem 迁移 + 既有用例判据不变）。
- **ChatView 流式按 segments 渲染**——thinking 段 `<details>` 默认折叠（`textContent` 单调增长兼容 e2e 01 spec §6）/ text 段纯文本 `<br>`（M4 已落地 4th gap 修复路径直接复用）/ tool 段 `<details>` 默认折叠 pill。**终态 assistant 消息挂载 `AssistantMessageBody`**（见下）。
- **`AssistantMessageBody`** 新建——`react-markdown@^9` + `remark-gfm@^4` + `rehype-sanitize@^6` 三件套（D1）；按 content 形态分支：`string` → 旧纯文本 `<br>` 拼接（**零变更**，M3 路径复用）；`array` → 分段渲染（text 段走 markdown；thinking 段 `<details>` 默认折叠；toolCall 段 pill + `<details>` 默认折叠，展开 = 参数 JSON + **完整结果**——D4 不截断，result 缺失显示 `pending…` 提示）；未知段纯文本 fallback（不丢内容）；`null` / `undefined` 空容器（不崩）。自定义 `a`（外链 `http(s)` 加 `target="_blank" rel="noreferrer"`，**`mailto:` 例外**——S3）/ `code` / `pre`（`.markdown-code` 配 `--code-bg` 变量）。
- **`styles.css`** 新增 `.markdown-code` / `.markdown-table` / `.message-thinking-details` / `.message-tool-pill` / `.message-tool-details` 样式 + `--code-bg` 变量；`.input-bar-field` / `.message-row` / `.message-body` 等既有 testid 锚点零改动。
- **雷区代码零改动**：WsClient 流式管线（除上述 draft 分段 + toolcall 捕获）/ stem-refilled watcher / useWsState（useCallback memoization）/ gateMap / App.decideView **除上述声明外零字节 diff**——既有用例零修改通过。
- **`testid` 锚点零改动**：grep `data-testid="input-field|input-send|input-abort"` / `class="message-row|message-draft|message-body|message-list"` 命中 0 增 0 删。

### Review 轮次

- **Round1**（reviewer 8 项：1C / 3W / 4S）：
  - **C1（critical，修改）**：`appendToolArgs` 原位变更 bucket 引用不触发 React 重渲染（既有用例 `web-state-bucket.test.ts §8.x` 反向断言触发**但** React 端 `Object.is` 同引用检测不更新）→ 修 `args` 累积改 `bucket.streamingDraft = { segments: [...prev] }` 重建引用 + 单 emit 双兼容既有 WebState memoization 与 React 重渲染检测。
  - **W1（warning，修改）**：markdown chunk 真懒加载——`react-markdown+remark-gfm+rehype-sanitize` 三件套全 graph + 体积 ~65KB → 走 `React.lazy` + `manualChunks` 切包 + `ChatView` mount 预热带 + `modulePreload` 剔除首屏。
  - **W2（warning，修改）**：orphan `toolcall_delta`（无 prior `toolcall_start`）原版双 emit 重复 args → 单 emit。
  - **W3（warning，修改）**：`migratePendingBucket` 判空语义对齐——原版按段类型 `segments.length === 0` 判空但 `toolcall_start` 已到/delta 未到的极端时序会让有内容的 tool 段漏判 → 改为 `streamingDraftIsEmpty` 按段内容判空（详见下文「设计注记」）。
  - **S3/S5（suggestion，修改）**：措辞校准。
- **Round2**（reviewer 5 项全过 + 收尾钉桩）：e2e 02 spec `History verification` 补 `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染（Suspense 竞态等待）；`web-state-bucket.test.ts §8.17` orphan toolcall_delta 引用契约钉桩（`Object.is` 不等 + 单调累积双重断言）。

### 关键数字

- **单测**：基线 704 → **765**（+61：assistant-message-body 28 / input-bar-keydown 9 / use-auto-resize-textarea 7 / 既有用例分段结构适配与新增 ~17），30 文件全绿。web 包 185 → **246**（+61：44 既有适配判据不变 + 17 新覆盖 §8.x segments 累积 + toolcall 路径 + orphan 单 emit 引用契约 + 28 assistant-message-body 终态 markdown + sanitize 攻击向量 + 折叠 + fallback）。
- **集成**：32/32 零回归（bridge wire 层零改动）。
- **e2e**：8 spec × 2 连跑全绿（两轮各 14.5s，无 flaky 无重跑）；01 spec §6 流式 `textContent` 单调性 + 02 spec `History verification`（新增 `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染）重点回归通过。
- **typecheck**：4 包绿（shared / bridge / worker / web）。
- **lint**：0 error / 5 pre-existing warnings（WsClient.ts no-console）。
- **build**：4 包绿，**web 250.76 KB raw / 73.37 KB gzip**（较 M4 基线 254.40 KB -3.64 KB，懒加载 markdown 170.57 KB raw / 52.47 KB gzip + AssistantMessageBody 2.47 KB —— 首屏不加载，详见 [[prds/m5-uiux.md#修订注记2026-09-11-第一块收官|PRD §修订注记]] D1 预算口径解释）。

### 设计注记（实施期发现 / 备查）

1. **`streamingDraftIsEmpty` 判空语义**（PRD §3 字面未细化）：实施期按段**内容**判空（任意段 `text || args || name` 非空即非空），而非按段**类型**。**trade-off**：toolcall_start 已到/delta 未到的极端时序下，pill 名 `tool.name` 不计入内容，导致该 pill **会**在迁移时被丢失（不渲染）。**触发概率极低**——要求 `toolcall_start` 与 `migratePendingBucket`（session_state 到达）在 ~ms 级时序重叠且中间无任何 toolcall_delta；当前 web UI 单端观察未触发，登记备查（M+ 候选：把 `tool.name` 也计入「内容」或把迁移窗口收紧到 `message_end` 之后）。
2. **markdown chunk 懒加载 vs 首屏预热**：原 chat-view mount 时立即 `import('react-markdown')` → 首屏 cold 路径 markdown chunk 未就绪导致终态消息首次渲染闪空 → 修 `ChatView` mount 预热带（`import('react-markdown')` fire-and-forget） + e2e 02 spec `waitForAssistantBodiesRendered` 等待 markdown chunk 渲染完成再断言。**e2e 02 spec 实测由「轮询 `.message-body` textContent 对账」改为「等待 markdown chunk 渲染 + textContent 对账」**——加挂等待助手不等同于失败重试（沿用 ADR-0009 §开放点 1 哲学）。

### 偏离 PRD 正文细节（PRD 修订注记同步落档）

- **D1 体积预算口径解释**（PRD §1 字面按 build 总产出，本轮按**首屏 entry** 口径达标）——详见 [[prds/m5-uiux.md#修订注记2026-09-11-第一块收官|PRD §修订注记（2026-09-11）]]。
- **新自定义组件 `inputBarKeydown.ts`**（`packages/web/src/components/inputBarKeydown.ts`）——任务 02 实施期抽离的纯函数 `decideKeyDownAction` 落点（PRD §4 字面未细化文件名；与 01 零冲突）；任务 02 完成情况含详情。
