---
prd: prds/m5-uiux.md
status: done
---
# 任务：AppShell 双栏 + Sidebar + SessionStatusBar + DirectoryBrowser modal 化 + ChoicePage 收口

## 目标
按 [[prds/m5-uiux.md|M5 PRD §第二块 G5 + D8 / 方案 §1]] 落地持久侧边栏：

1. **新建 `packages/web/src/components/AppShell.tsx`**——双栏布局容器：左侧 `<Sidebar>` + 右侧 `<Main>{children}</Main>`；移动端 `<aside>` + backdrop + 抽屉状态（07 任务在此 seam 接入）；侧边栏不引入独立 session 状态，**一切从 WsClient bucket 读**（沿用 M4 任务 08 SessionBucket 模式）。
2. **新建 `packages/web/src/components/Sidebar.tsx`**：
   - **顶部品牌位**：`<h1>RemotePi</h1>`（沿用既有品牌文案 / 字体，移入 sidebar 顶部）；
   - **横排 tabs**（默认 **Sessions** tab）：`[Sessions] [WorkDirs]` 两枚按钮切换（active tab 高亮）；
   - **Sessions tab 内容**：当前 `work_dir` 的 sessions 列表（新建按钮在此，单击即切 → `selectSessionHash` / `newSessionHash` 写 hash，当前 session 高亮）；
   - **WorkDirs tab 内容**：work_dirs 列表（当前高亮）+ 「浏览添加」按钮（**DirectoryBrowser 由此 tab 打开为 modal**，见 4）；
   - **底部 `BridgeStatusBar`**（compact 版）+ **设置按钮**（`settings-button` testid，触发 TokenModal closable）；
   - 沿用既有 work-dir-remove / session-list / work-dir-list 等 testid 锚点。
3. **新建 `packages/web/src/components/SessionStatusBar.tsx`**——右侧 ChatView 顶部 status bar，展示**本 session 状态**：phase badge（`running` / `idle` / `spawning` / `exited` / `unknown`）+ queue pills（待发消息条数）+ session 名（`session === 'new'` 显「**新会话**」，与 M4 既有 `'new'` 渲染对齐）；**bridge 状态移至 sidebar 底部**（BridgeStatusBar compact），SessionStatusBar 不再展示 bridge 状态。汉堡按钮**占位留给 07**（`sidebar-toggle` testid，props 透传 + 默认 hidden，07 任务在媒体查询 <768px 时显示）。
4. **`DirectoryBrowser` modal 化**——`packages/web/src/components/DirectoryBrowser.tsx` 加 `open: boolean` prop；props 兼容（保留全部既有 testid + 行为）；Sidebar WorkDirs tab「浏览添加」按钮控制 `open`；移动端 <768px 全屏 sheet（07 任务处理）。
5. **`ChoicePage.tsx` 收口为 Panel**——拆 `ChoiceLevel1Panel`（WorkDirs 列表 + 浏览按钮）/ `ChoiceLevel2Panel`（Sessions 列表 + 新建按钮 + 更换目录）；**保留所有 testid**（work-dir-list / work-dir-remove / session-list / new-session-button 等）；**移除自渲染列表**（list 渲染职责移至 Sidebar）；Panel 只负责承接 Sidebar 槽位 + 顶部状态提示 + 无列表时的空态 CTA。
6. **拆 `StatusBar` → `BridgeStatusBar`**——`packages/web/src/components/StatusBar.tsx` 拆出 `BridgeStatusBar`（sidebar 底部 compact 版：bridge online/offline/connecting 三态 badge，**删除「此 URL 含访问令牌」文案**——05 任务一并清理）。
7. **`App.tsx` 装配 AppShell**——`<AppShell>{renderDecideView(auth)}</AppShell>`；`gateMapRef` / `handleRefill` / `useRecoveryGateMap` **仍在 App 层创建**（不下移——M4 验收期 4th gap 修复路径要求 App 级闭包稳定，详见 [[tasks/m4/08-web-multi-session-store.md#验收期-4th-gap2026-09-09-落档|08 验收期 4th gap]]），props 透传到 `RecoveryView` / `ChatView`。
8. **新组件统一 Tailwind only**（@theme token utilities）——AppShell / Sidebar / SessionStatusBar / ChoiceLevel1Panel / ChoiceLevel2Panel 不引入 module.css；既有 `StatusBar.tsx` / `DirectoryBrowser.tsx` / `ChoicePage.tsx` 保留 module.css（触碰处顺手迁——M+ 候选强制迁移）。
9. **`styles.css` 触碰处顺手迁**——`.app-shell` 规则改 grid/flex 双栏（`grid-template-columns: var(--sidebar-width) 1fr`）。

## 测试义务
- [ ] **`app-shell.test.tsx` ≥5 条**：
  - 无 token → TokenModal 优先渲染（覆盖 AppShell 内容区）；
  - token + 无 workdir → WorkDirs tab + ChoiceLevel1Panel；
  - token + workdir → Sessions tab + ChoiceLevel2Panel + 右区 ChatView；
  - 设置按钮点击 → TokenModal closable 打开；
  - Sidebar tabs 切换（Sessions ↔ WorkDirs）渲染正确。
- [ ] **`sidebar.test.tsx` ≥5 条**：
  - 默认 tab = Sessions（mount 时 active tab 高亮）；
  - 切换 tab 渲染对应内容；
  - 点 session 行 → 触发 hash 写（mock `selectSessionHash` 调用，断言参数）；
  - 设置按钮回调（触发 onSettingsClick，App 层弹 TokenModal）；
  - bridge 三态 badge（online/offline/connecting 三种 props 各自渲染正确）。
- [ ] **`session-status-bar.test.tsx` ≥3 条**：
  - phase badge 五态各自渲染（`running` / `idle` / `spawning` / `exited` / `unknown`）；
  - session === 'new' 显「**新会话**」（与 M4 既有 `'new'` 渲染对齐）；
  - queue pills 显示当前 queue 长度（0 → 不显示 / ≥1 → 显示数字 pill）。

## 完成标准
- [x] 全量单测（**基线 790 + 新增 ≥13**）/ 集成 32 / e2e 8 spec × 2 全绿
- [x] typecheck / lint / build 全绿
- [x] testid **零增零删**核对（grep `data-testid="..."` 与既有清单一致；新组件新 testid 不计入本约束）
- [x] **雷区零字节 diff**：grep `useRecoveryGateMap|handleRefill|gateMapRef` 仅存在于 App.tsx（不下移到 AppShell / Sidebar / 任何子组件）
- [x] build 首屏 entry 增量 ≤ **+30 KB**（基线 253.44 KB → ≤ 283.44 KB raw；G9 质量门）；记录入完成情况
- [x] 此任务后 e2e 导航流程可能需微调——choice-page 分支结构变化（侧边栏接入后 token-only URL 形态消失，08 任务统一改造 e2e token 来源为 localStorage seeding）；06 任务若 e2e spec 红灯如实记录修复方式（spec 调整到「设 token → level1/level2 走 AppShell」流）
- [x] commit 不 push（沿用 M2 / M3 / M4 交付约定）

## 依赖
- 依赖 [[tasks/m5/04-tailwind-v4-intro.md|04-tailwind-v4-intro]]（Tailwind 已引入；AppShell / Sidebar 等新组件用 Tailwind only 写）
- 依赖 [[tasks/m5/05-token-storage.md|05-token-storage]]（TokenModal 已就绪；AppShell 装配依赖 TokenModal 组件存在）
- 07 依赖本任务（移动端抽屉状态接入 sidebar-toggle / sidebar-backdrop 锚点）

## 参考
- [[prds/m5-uiux.md|M5 PRD §第二块 G5 / 方案 §1 / D8]]
- [[tasks/m5/01-web-markdown-render.md|01-web-markdown-render]] testid 锚点基线
- [[tasks/m4/07-web-choice-page.md|07-web-choice-page]] ChoicePage level1/level2 分派基线
- [[tasks/m4/08-web-multi-session-store.md|08-web-multi-session-store]] SessionBucket + 雷区代码清单 + handleRefill 闭包稳定性约束

## 完成情况（2026-09-12）

任务完成，3 笔代码 commit 在本任务验收后由用户 push（沿用 M2 / M3 / M4 交付约定）。

### Commit 链

- `14897e1` feat(web): M5 任务06 —— AppShell 双栏 + 持久 Sidebar + SessionStatusBar + DirectoryBrowser modal 化
- `cc27d02` fix(web): M5 任务06 review 修复 —— testid 去重 + activeTab 同步 + 双 connect 消除 + 状态条去重
- `d6ed7be` chore(web): M5 任务06 卫生收尾 —— 注释字面去重 + 遗留 phase/queue 死 CSS 清理

### Review 轮次与裁决

本任务 2 轮 review：

- **Round1**：0C / 3W / 4S。W1（write boolean + storageError 内联提示）落地 + W2（closable setAuth 同步）落地 + W3（testid 零增零删核对）落地（详见 [[#review-抓出的关键-bug|review 抓出的关键 bug]]）。
- **Round2**：全部落地，3 处重复 testid 修复 + activeTab 同步修复 + 双 connect 消除 + 状态条去重——全部在 commit `cc27d02` 闭环。
- **卫生收尾 `d6ed7be`**：注释字面去重 + 删遗留 `phase` / `queue` 死 CSS 78 行（视图重组后已无消费者）。

### 关键数字（终验 2026-09-12，与 d290be6 终版一致）

- **单测**：基线 790 → **888**（+98；任务 06 后实测单测新增已超 ≥13 阈值，归并到终版 977 中）。
- **集成**：32/32 零回归。
- **e2e**：8 spec × 2 全绿。
- **typecheck**：4 包绿。
- **lint**：0 error / 5 pre-existing warnings。
- **build**：4 包绿；**web 首屏 entry** 实测详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]（266.98 KB raw / 77.87 KB gzip；增量 +13.54 KB **远低于预算上限 +30 KB**）。

### 实施要点

- **新建 `AppShell.tsx`**（Tailwind only）——双栏 grid 布局：`grid-template-columns: var(--sidebar-width) 1fr`；移动端 `<aside>` + backdrop 留 07 任务 seam。
- **新建 `Sidebar.tsx`**（Tailwind only）——顶部品牌位 `<h1>RemotePi</h1>` + 横排 tabs（默认 Sessions）+ Sessions/WorkDirs 双 tab 渲染 + 底部 `BridgeStatusBar` compact + 设置按钮。
- **新建 `SessionStatusBar.tsx`**——右侧 ChatView 顶部 status bar：phase badge 五态 + queue pills + session 名（`session === 'new'` 显「**新会话**」）；汉堡按钮 `sidebar-toggle` testid 占位（07 任务启用）。
- **`DirectoryBrowser` modal 化**——加 `open: boolean` prop + props 兼容；既有 testid 全保留。
- **`ChoicePage.tsx` 收口为 Panel**——拆 `ChoiceLevel1Panel` / `ChoiceLevel2Panel`；保留所有 testid + 移除自渲染列表。
- **`StatusBar` → `BridgeStatusBar` 拆出**——sidebar 底部 compact 版；删除「此 URL 含访问令牌」文案（05 任务一并清理）。
- **`App.tsx` 装配 AppShell**——`<AppShell>{renderDecideView(auth)}</AppShell>`；`gateMapRef` / `handleRefill` / `useRecoveryGateMap` 仍在 App 层创建（不下移），props 透传 `RecoveryView` / `ChatView`。

### Review 抓出的关键 bug

`strict-mode` 隐患（cc27d02 修复）+ UX bug + 时序竞争——3 处重复 testid + 1 处 activeTab 脱钩 + 1 处双 connect：

1. **3 处重复 testid**（`session-new` / `work-dir-empty` / `choice-page-remove-error`）——StrictMode 双挂载下 React 抛 "Encountered two children with the same key" 警告（潜在崩溃隐患）；
2. **activeTab 脱钩 UX bug**——URL hash 变化时 Sidebar active tab 不跟随（如切换到新 session 应保持 Sessions tab 不应跳 WorkDirs）；
3. **双 connect**——mount-once 守卫缺失导致 TokenModal closable 提交后旧 socket 未及时 close 引发双 socket 竞争。

全部在 `cc27d02` 闭环。

### W1 / W2 遗留落地

- **W1（write boolean + storageError 内联提示）**——05 任务 review 移交：`tokenStorage.write` 返回 `boolean`（成功 / SecurityError 失败），App 层捕获 `storageError` 后在 TokenModal 顶部内联提示「localStorage 不可用，请改用隐私模式外浏览器」——避免 `write + reload` 死循环（05 任务 reviewer 抓出的 W1 遗留）。
- **W2（closable setAuth 同步）**——TokenModal closable 模式提交后立即同步 App 层 `auth.token`（而非依赖 `client.connect` 副作用异步），避免 setState 期间 stale closure。

### 雷区零 diff 实证

- `grep useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView packages/web/src/` 仍仅命中 App.tsx；
- `App.tsx` 仅动 `readAuth` 拼装 + 分支 JSX + AppShell 装配（gateMapRef / handleRefill / RecoveryView effect 既有结构零改动）；
- `packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空；
- wire 协议零改动（v3 锁版承诺守住）。

### 卫生收尾（d6ed7be）

- 注释字面去重——多处 `// xxx (unused)` / `// phase badge` 等已无意义的注释清理；
- 删遗留 `phase` / `queue` 死 CSS 78 行——视图重组后这些 class 已无消费者，styles.css 字节瘦身。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 3 笔代码 commit（`14897e1` + `cc27d02` + `d6ed7be`）由用户手动 `git push origin main` 触发 Actions CD。
- **M5 第二块收官标记**：本任务 done + 任务 04 / 05 / 07 / 08 done → M5 第二块全部 5 个任务 done。
