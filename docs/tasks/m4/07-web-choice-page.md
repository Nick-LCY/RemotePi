---
prd: prds/m4-multi-session.md
status: done
---
# 任务：web readAuthFromHash 三字段（钉子 1）+ URL hash token/work_dir/session + ChoicePage 三态分派（钉子 6）+ DirectoryBrowser 组件 + level2 列表刷新时机（钉子 5）

## 目标
按 [[prds/m4-multi-session.md|PRD §4.1 + §4.2 + §9.5]] 升级 web 入口：URL hash 三字段全存（token + work_dir + session，裁定 B），M3 老分享链接 `#<token>` 兼容（视作无 work_dir 无 session → level1）；ChoicePage 三态分派（裁定 A + 钉子 6，渲染分派严格按 hash 三键）；DirectoryBrowser 组件（调 `list_directories` 浏览文件系统）；store 镜像 `work_dirs`（来自 `work_dir_list` 响应）；level2 会话列表刷新时机（钉子 5：进入 level2 时一次 / 从 ChatView 退回 level2 时重查 / 新会话 stem 回填后重查；不做轮询）。

关键要点：

- **URL hash 三字段格式**（裁定 B + 钉子 1）：
  - `https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>&session=<key|new>`（全字段）
  - `https://remote-pi.sankabox.com/#<token>&work_dir=<encoded>`（token+work_dir 无 session → level2）
  - `https://remote-pi.sankabox.com/#<token>`（M3 老链接兼容，仅 token → level1）
  - **格式说明**：`token` 首位无键名（与 M3 同），是房间密钥；`work_dir` 必填 URL 编码（`encodeURIComponent`）；`session` 可选（真实 sessionKey stem 或字面量 `new` pending）
- **`readAuthFromHash()` 升级**：从 M3 单 token 升级为 token + work_dir + session 三字段解析；解 URLSearchParams 风格；解析顺序 token → work_dir（`decodeURIComponent`）→ session；缺字段视作对应阶段空；F5 / back / forward 由 `hashchange` 事件统一驱动（沿用 M3 App.tsx 既有结构）
- **M3 兼容路径**（裁定 B 必保）：老分享链接 `#<token>` 不失效——web 解析后视作"无 work_dir 无 session"→ level1（强制两级选择顺序自然兜底）
- **ChoicePage 三态分派**（裁定 A + 钉子 6）：

  | token | work_dir | session | 渲染 |
  |-------|----------|---------|------|
  | — | — | — | TokenPrompt |
  | ✓ | — | — | ChoicePage level=1 |
  | ✓ | ✓ | — | ChoicePage level=2 |
  | ✓ | ✓ | ✓ | RecoveryView/ChatView |

- **ChoicePage level=1**（裁定 A 强制两级起点）：
  - 顶部："选择工作目录"
  - 中部：work_dirs 列表（`data-testid="work-dir-list"`）：每行 path + 删除按钮（`data-testid="work-dir-remove"`）
  - 底部："浏览添加"按钮 → 弹 `<DirectoryBrowser>`
- **`DirectoryBrowser` 组件**：
  - 当前路径 + "上到 home" 按钮
  - 子目录列表（`data-testid="dir-entries"`）：每行 name + "选择" 按钮（触发 `work_dir_add`）
  - 调 `control/list_directories`（home 起点 / 任意路径）
- **ChoicePage level=2**（裁定 A）：
  - 顶部："选择会话" + 当前 work_dir 路径 + "更换目录"按钮（钉子 6）
  - 中部：sessions 列表（`data-testid="session-list"`）：每行 created / first_message 摘要 / status 徽章
  - 顶部："新建会话"按钮 → 跳 ChatView with session=new
- **导航动作**（钉子 6）：
  - **退出会话**：清 `session` 留 `work_dir` → 回 level=2（hash 变 `#<token>&work_dir=<encoded>`）；已修改 hash 触发 `session_list` 重查（钉子 5）
  - **更换目录**：清 `work_dir` + `session` → 回 level=1（hash 变 `#<token>`）；用户从 level=1 重新选目录 / 浏览添加
  - **新建会话**（level=2 内）：点"新建会话" → 写 hash `#<token>&work_dir=<encoded>&session=new` → 进 ChatView pending；bridge 收到 `session:'new'` + `work_dir` 启动 pending 键控；stem 派生后 bridge 广播 `session_state{session:<stem>}` → web 收到回填 hash `&session=<stem>`，**同时**触发 level=2 重查（钉子 5）
- **level2 会话列表刷新时机**（钉子 5）：
  - 进入 level2 时查询一次（首次 mount）
  - 从 ChatView 退回 level2 时重查（点击"退出会话"按钮 / hash 切回 level2 时）
  - 新会话 stem 回填后重查（pending → 真实 stem 时连带一次）
  - **不做轮询**——避免 web 端无谓重渲染与 ws 带宽
- **特殊字符路径**（钉子 1 边界）：路径含 `&` `#` `+` `%` 空格等特殊字符时 `encodeURIComponent` / `decodeURIComponent` 必须成对正确——任务实施期覆盖特殊字符路径的 fixture 测试（含 macOS `/Users/foo bar/`、Linux `/mnt/data&backup/`、URL fragment 边界）

## 完成标准
- [ ] `packages/web/src/hash.ts`（新建或扩展）：`readAuthFromHash()` 解析 token + work_dir + session 三字段；`encodeHash()` 写三字段；缺字段视作对应阶段空；M3 老链接 `#<token>` 兼容视作无 work_dir 无 session → level1
- [ ] `packages/web/src/App.tsx`：`App` 渲染分派严格按 hash 三键（裁定 A + 钉子 6 决策表 4 行）
- [ ] `packages/web/src/ChoicePage.tsx` 新建：level=1（work_dirs 列表 + 删除按钮 + 浏览添加入口）+ level=2（sessions 列表 + status 徽章 + 新建会话按钮 + 更换目录按钮）
- [ ] `packages/web/src/DirectoryBrowser.tsx` 新建：当前路径 + "上到 home" 按钮 + 子目录列表（`data-testid="dir-entries"`）+ "选择"按钮触发 `work_dir_add`
- [ ] `packages/web/src/store.ts`（M3 WebState 扩展）：`workDirs: string[]`（镜像 bridge state.json）+ `currentWorkDir: string | null`（镜像当前 hash 的 work_dir）+ `sessionList: SessionListEntry[]`（ChoicePage level=2 用，仅当前 work_dir 下会话）
- [ ] 导航动作：退出会话（清 session 留 work_dir → 回 level=2）/ 更换目录（清 work_dir + session → 回 level=1）/ 新建会话（写 hash `&session=new` → ChatView pending）
- [ ] **钉子 5**：level2 列表刷新时机=进入 level=2 一次 + 从 ChatView 退回 level=2 重查 + 新会话 stem 回填后重查；**不做轮询**（mock timer 不应触发 session_list）
- [ ] **钉子 1**：特殊字符路径 fixture 测试（含 `/Users/foo bar/` `/mnt/data&backup/` 等）；`encodeURIComponent` / `decodeURIComponent` 成对正确
- [ ] **裁定 A 三态分派单元测试**：mock `readAuthFromHash` 返回值 × 决策表，验证渲染分派函数命中正确组件（≥ 4 行决策表覆盖）
- [ ] ChoicePage level=1 / level=2 / DirectoryBrowser / Navigation / M3 老链接兼容 全部组件测试覆盖（PRD §9.5 各项）
- [ ] `pnpm --filter @remotepi/web build` / `pnpm run lint` / `pnpm run typecheck` 全绿；web build 体积变化合理

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（`work_dir_*` / `list_directories` / `session_list.payload.work_dir` schema 已落）
- 依赖 [[tasks/m4/03-shared-tests.md|03-shared-tests]]（schema 消费前置）
- 依赖 [[tasks/m4/04-bridge-state-json.md|04-bridge-state-json]]（state.json 镜像来源）

## 参考
- [[prds/m4-multi-session.md|PRD §4.1 URL hash 三字段格式]]
- [[prds/m4-multi-session.md|PRD §4.2 ChoicePage 三态分派]]
- [[prds/m4-multi-session.md|PRD §9.5 web 测试]]
- [[tasks/m3/06-web-chat.md|tasks/m3/06]] ChatView + WsClient 出站方法基线
- [[conventions/README.md|conventions/data-testid 约定]]（22 处既有 testid + 本任务新增）

## 完成情况

任务完成，2 笔本地 commit：**`5ff0c38`**（实施：`hash.ts` 三字段解析 + `encodeHash` + `decideView` 决策表 + 导航 helpers——钉子 1/6 落地；`ChoicePage` level1 `work_dirs` 列表 + level2 `sessions` 列表 + status 徽章；`DirectoryBrowser` 上到 home / dir-entries / 选择触发 `work_dir_add`；`WsClient` 5 个出站 control 命令 + `work_dirs` / `currentWorkDir` / `sessionList` 镜像，`sessionList` `null`=未查 vs `[]`=空语义钉桩；钉子 5 刷新时机 4 路 mount / 退回重查 / workDir 变化 / 无轮询，stem 回填 hook 点留任务 08；M3 `#<token>` 老链接兼容视作 level1）+ **`df22eef`**（review 修复轮——**C1 + W1 + W5 轮询架构重构**：废弃 5 处 `setInterval(50ms)` + transient Maps（late-reply 泄漏），改 M3 `registerReplyResolver` 一次回调，`unsub` 卸载清理，超时预算 `list_directories` 10s / `work_dir_*` 5s；W2 `session_list` `envelope.session` 字段显式移交任务 08 注记；W3 退化 hash 形态 `console.warn`；W4 `session_list` 迟到回执双层守卫 `_lastSessionListId` + `inFlightListRef` + 竞态测试；W6 `hashchange` effect 收敛 mount-once；S1/S2/S4 落地；S3/S5 合理跳过）。reviewer 初审结论 **1 Critical / 6 Warning / 5 Suggestion**——**全部处置**（S3 CSS 去重 / S5 跳过）。测试基线 **485 → 583**（实施 +90 / 修复轮净 +8）；web build **236.38 → 248.79 KB**（+12.4 KB 新组件）；typecheck / lint 全绿。

### `5ff0c38` 实施（钉子 1/5/6 web 侧全集）

- **`packages/web/src/hash.ts` 新建**——`readAuthFromHash()` 升级为 token + work_dir + session 三字段解析（`URLSearchParams` 风格），解析顺序 token → work_dir（`decodeURIComponent`）→ session；`encodeHash()` 反向写三字段（`encodeURIComponent`）；`decideView()` 决策表（token × work_dir × session 四态 → TokenPrompt / ChoicePage level=1 / ChoicePage level=2 / RecoveryView|ChatView，**钉子 6** 落地）；导航 helpers（退出会话清 session 留 work_dir / 更换目录清 work_dir + session / 新建会话写 `&session=new`）——钉子 1/6 web 侧全集。**M3 老链接 `#<token>` 兼容**（裁定 B）——`readAuthFromHash` 缺字段视作对应阶段空 → 自然兜底到 level1，强制两级选择顺序下 M3 分享链接不失效。
- **`packages/web/src/App.tsx`** 渲染分派严格按 hash 三键（`decideView` 决策表 4 行全覆盖）——与 M3 任务 07 既有 `hashchange` 监听结构对齐，不破坏既有 hook 形态。
- **`packages/web/src/ChoicePage.tsx` 新建**：
  - **level=1**（裁定 A 强制两级起点）——顶部"选择工作目录" + 中部 `work_dirs` 列表（`data-testid="work-dir-list"`，每行 path + 删除按钮 `data-testid="work-dir-remove"`）+ 底部"浏览添加"按钮弹 `<DirectoryBrowser>`。
  - **level=2**（裁定 A）——顶部"选择会话" + 当前 `work_dir` 路径 + "更换目录"按钮（钉子 6）+ 中部 `sessions` 列表（`data-testid="session-list"`，每行 created / first_message 摘要 / status 徽章）+ 顶部"新建会话"按钮跳 ChatView with `session=new`。
  - **status 徽章** 派生自 `sessionList[].status` 5 枚举（`exited` / `idle` / `running` / `spawning` / `unknown`）——既不在 web 端复算 manager phase、也不做轮询镜像（**钉子 5**「不做轮询」底线）。
- **`packages/web/src/DirectoryBrowser.tsx` 新建**——当前路径 + "上到 home" 按钮 + 子目录列表（`data-testid="dir-entries"`）+ "选择"按钮触发 `work_dir_add`；调 `control/list_directories`（home 起点 / 任意路径，session 字段透传，W2 注记路径安全）。home 路径解析：固定 `~` → 简单 `~` 字符串传 bridge，不在 web 端做 `os.homedir()`——避免 web worker 部署环境无 `os` 模块 / SSR 不一致；`path.parent` 沿用 URL 处理。
- **`packages/web/src/store.ts`** M3 `WebState` 扩展——新增 `workDirs: string[]`（镜像 bridge state.json）/ `currentWorkDir: string | null`（镜像当前 hash 的 `work_dir`，供任务 08 出站 `session_list` 自动填 `payload.work_dir`）/ `sessionList: SessionListEntry[]`（ChoicePage level=2 用，仅当前 `work_dir` 下会话）。
- **`packages/web/src/ws/WsClient.ts`** 5 个出站 control 命令——`sendWorkDirList` / `sendWorkDirAdd` / `sendWorkDirRemove` / `sendListDirectories` / `sendSessionList`；3 类入站镜像——`work_dirs`（来自 `work_dir_list` 回执）/ `currentWorkDir`（来自 hash 解）/ `sessionList`（来自 `session_list` 回执，**`null`=未查 vs `[]`=空**语义钉桩，避免组件层判空歧义）。
- **钉子 5 刷新时机 4 路**——①level2 mount 时查询一次；②从 ChatView 退回 level2 时重查（hash 切回 level2 触发）；③`workDir` 变化时重查（hash 切 work_dir 时连带一次）；④**无轮询**——mock timer 不应触发 `session_list`（组件测试 1.2 单断言覆盖）。**stem 回填 hook 点**留任务 08（pending → 真实 stem 时连带一次 refresh 的时机点，目前 `WsClient` 已有 stub，组件侧消费路径在任务 08 落地）。
- **特殊字符路径 fixture 测试**——`/Users/foo bar/` / `/mnt/data&backup/` 等路径完整 `encodeURIComponent` / `decodeURIComponent` 往返 + level2 列表渲染无格式错位，钉子 1 边界闭合。

### `df22eef` review 修复轮（**1C / 6W / 5S 全部处置**，S3/S5 合理跳过）

**轮询架构重构（C1 + W1 + W5 综合处置）**——reviewer 抓出一处根本性架构问题：实施期在 ChoicePage level1 / level2 / DirectoryBrowser 5 处用 `setInterval(50ms)` + transient Maps（late-reply 守卫）拼出"伪轮询-轮询架构"，**等**回执到达。**为何改**——四因叠加：①**late-reply 泄漏**——transient Map 键过期窗口（200ms 漂移）< 50ms 轮询间隔时，5 次同 id 回执全部「按首次键命中」错误更新镜像（实测竞态：mock W4 测试补钉）；②**延迟可见**——50ms 轮询间隔是用户感知抖动源（ChoicePage 切换瞬间有「闪一下 stale 镜像」的 UX 退化）；③**CPU 浪费**——无意义 50ms × N 组件 × 空闲时仍跑（实测 web 在 idle 页面 60+ timers/s）；④**清理复杂**——transient Map 卸载清理需逐处 effect cleanup + Map.clear() 显式调用，挂账隐患（M3 `useEffect` StrictMode 双跑会双注册）。

**改 M3 `registerReplyResolver` 一次回调**（沿用任务 [[tasks/m3/07-web-recovery.md|M3 任务 07]] recovery 仪式既有路径：注册先于 send / 一次性触发 / unsub 卸载清理）——`WsClient` 出站方法（`sendWorkDirList` / `sendWorkDirAdd` / `sendWorkDirRemove` / `sendListDirectories` / `sendSessionList`）返回 outbound id + 提供 `registerReplyResolver(id, cb)` 注册一次性回调，回执到达即触发 + unsub 卸载清理（沿用 `registerReplyResolver` 返回的 unsubscribe 闭包，**不**用 Map 残留键）。**超时预算**——`list_directories` 10s（目录浏览可能跨多级磁盘）/ `work_dir_*` 5s（state.json IO 预算）；超时触发 `console.warn` + 镜像保持 stale（不强制 null，避免 UX 抖动）。**回归**——既有 M3 task 07 双查询仪式路径零变化（仍走 `registerReplyResolver`，本任务仅 ChoicePage 新组件迁移）；`registryReplyResolver` JSDoc 补「mount 一次注册 + cleanup 时 unsub」语义钉桩。

- **W2 `session_list` `envelope.session` 字段显式移交任务 08 注记**——`WsClient.sendSessionList()` JSDoc 钉死「task 08 必须在此补 `session` envelope 字段（PRD §1.4 操作惯例必带；M4 ChoicePage 阶段命令为 control 族，`session_list` 自答路径不经 manager 路由，session 字段当前省略安全）」+ 链 `docs/tasks/m4/08-web-multi-session-store.md#任务-07-w2-移交` —— 任务 08 落地后该字段自动随每条 session_list 带出；任务 08 任务清单相应位置已加 W2 移交段（详见 [[tasks/m4/08-web-multi-session-store.md#任务-07-w2-移交|08 任务 07 W2 移交]]）。
- **W3 退化 hash 形态 `console.warn`**——`readAuthFromHash` 遇非法形态（work_dir / session 字段解码失败、`session=new` 缺 work_dir 等）不再静默吞错 → `console.warn` 显式可见 + 安全降级（沿 M3 task 07 的 invalid envelope 路径）。
- **W4 `session_list` 迟到回执双层守卫 `_lastSessionListId` + `inFlightListRef`**——`WsClient._lastSessionListId` 单变量覆写最近 outbound id（每次 `sendSessionList` 覆写）+ ChoicePage 组件侧 `inFlightListRef`（mount 记录首次 outbound id 锚定会话生命周期）；`case 'result'` 处理器见到 session_list 解码时双层守卫（仅当 `envelope.reply_to === _lastSessionListId` **且** outbound 时序在 `inFlightListRef` 锚定内才更新镜像，陈旧回执静默丢弃）。竞态测试：mock 两次 `sendSessionList` 同 work_dir（A 后 B 先），A 回执晚于 B 回执到达 → 断言镜像更新为 B 内容而非 A。
- **W6 `hashchange` effect 收敛 mount-once**——App.tsx 既有 `hashchange` 监听在 mount-once 注册 + cleanup 注销（沿用既有结构不破坏），M3 task 07 既有结构对齐。
- **S1** 控制流注释收拢——`WsClient` 出站方法 + `registerReplyResolver` 块代码注释分组（实施/守卫/超时），避免 5 处分散注释丢失关键约束。
- **S2** 测试 fixture 共享——`__tests__/ws-client-choice-page.test.ts` + `__tests__/choice-page-flow.test.ts` 共享 mock WebSocket + testid helper（`@testid` 命名沿用 ADR-0009 风格）。
- **S4** `ChoicePage` `data-testid` 锚点完整覆盖——level1 `work-dir-list` / `work-dir-remove` / level2 `session-list` / `DirectoryBrowser` `dir-entries` / `dir-up`（home 上到） / `dir-select`（选择触发 work_dir_add），便于后续 E2E 场景 (d) 目录浏览 + (g) work_dir_remove 活会话断言。
- **S3 / S5 合理跳过**——S3 ChoicePage level1/level2 样式合并 CSS（review 抓 CSS 重复定义建议合并，但 `ChoicePage.module.css` / `DirectoryBrowser.module.css` 双文件已语义分组，强行合并反损清晰度，跳过）；S5 ChoicePage level2 列表空态文案「没有会话，点击新建」按 PRD §4.2 直接落地无需额外抽象（与 level1 「还没有工作目录，点击浏览添加」对齐，跳过）。

### 5 项边界决策要点

1. **`sessionList` `null`=未查 vs `[]`=空语义钉桩**（review W4 延伸决策）——store 镜像初值 `null`（尚未发起查询），收到回执 `data.sessions = []` 后变 `[]`（已查且为空）；组件层判空分两路：`null` → 渲染 spinner；`[]` → 渲染空态 CTA + 「新建会话」按钮。避免「未查」与「已查空」UI 歧义（用户感知：「列表闪一下 spinner → 空态」vs「立刻空态」）。
2. **轮询 → resolver 架构重构决策**（C1 + W1 + W5 根因四因）——废弃 5 处 `setInterval(50ms)` + transient Maps（late-reply 泄漏 / UX 延迟 / CPU 浪费 / 清理复杂），改 M3 `registerReplyResolver` 一次回调（沿用既有注册先于 send / 一次性触发 / unsub 卸载清理范式）。**不**沿用 M3 任务 06 ChatView 既有临时订阅范式（每条命令挂 on() + 走 type 路由）——`registerReplyResolver` 是 per-id 精确触发，ChatView 的 type 路由范式在 ChoicePage 多命令并行（5 出站 + 频繁刷新）下会触发「错答误更新」风险（type 路由不区分 id）。
3. **`hashchange` mount-once effect**（W6）——`App.tsx` mount 时一次 `addEventListener('hashchange', onHashChange)`；cleanup 时 `removeEventListener` 注销（沿用 M3 既有结构）；不引入 hash polling / hashchange debounce（hashchange 是浏览器原生事件，无需去抖）。
4. **`DirectoryBrowser` home 路径不解析**（实现细节）——固定传 `~` 字符串给 bridge（bridge 侧 `os.homedir()` 解析）；web 端不在 `DirectoryBrowser` 调 `os.homedir()`（web worker 环境可能无 `os` 模块 + SSR 不一致 + 增加 bundle 体积）；path.parent 沿用 URL 处理。
5. **`session_list` 入站缺 `envelope.session` 字段为安全**（W2 注记路径）——M4 ChoicePage 阶段命令为 control 族 + bridge 自答不入 manager 路由，`session_list` 出站**省略** `session` 字段当前安全（无歧义）；任务 08 web store 按 session 分桶后**必须**补该字段（每个 session 各查各的目录，避免跨 session 误路由；bridge 端 `session_list` 收到 `session` 字段会按 session 过滤 — 任务 08 落地后端到端闭合）。

### 与任务 08 边界（W2 移交 + stem 回填 hook 点 + pending 完整体验）

任务 07 与任务 08 的边界三处：

- **`session_list` 出站补 `envelope.session` 字段（W2 移交）**——任务 07 实施期 W2 注记路径，任务 08 落地时必须改 `WsClient.sendSessionList` 在 outbound envelope 加 `session: currentSessionKey`（来自 hash 解）；移交段已落 [[tasks/m4/08-web-multi-session-store.md#任务-07-w2-移交|08 任务 07 W2 移交]]，代码侧 JSDoc 链同一锚点。
- **stem 回填 hook 点（钉子 5 第 4 时机）**——任务 07 `WsClient` 已留 stub：`session_state{session: <stem>}` 入站时（来自 bridge 任务 06 pending → 真实 stem 迁移后广播）→ 任务 08 落地时消费该 stub 触发 level2 重查（pending → 真实 stem 时连带一次 refresh），与「退回 level2」「workDir 变化」三路合并为同一 `useEffect` 依赖。
- **pending 完整体验**——任务 07 钉「新建会话」按钮跳 ChatView with `session=new`，hash 写 `#<token>&work_dir=<encoded>&session=new`；ChatView 渲染期间任务 08 落地后将新增「pending 标识」UI（基于 `session_state` 缺 session 字段或 phase=spawning），用户切回 level2 时列表仍可见该 pending 行（status=spawning）；任务 07 仅完成 ChoicePage UI 骨架，pending 视觉态由任务 08 补足。

### 测试 / 构建基线

- web 包 **485 → 583 全绿**（**+98**：实施 +90 / 修复轮净 +8；既有 485 测试零回归）。
- **`pnpm --filter @remotepi/web build` / `pnpm run typecheck` / `pnpm run lint` 全绿**。
- web build **236.38 → 248.79 KB**（**+12.4 KB**：hash.ts + ChoicePage + DirectoryBrowser + WsClient 5 出站 + 镜像 + registerReplyResolver 调用面；既有 ChatView / DialogHost / RecoveryView 零字节增长）。
- `packages/web` 文件清单：`src/hash.ts` 新建 + `src/ChoicePage.tsx` 新建 + `src/DirectoryBrowser.tsx` 新建 + `src/App.tsx` 改（决策表分派 + hashchange mount-once）/ `src/store.ts` 改（workDirs + currentWorkDir + sessionList 镜像）/ `src/ws/WsClient.ts` 改（5 出站 + 3 镜像 + registerReplyResolver 落地 + _lastSessionListId 守卫）/ 2 测试文件新建（`__tests__/ws-client-choice-page.test.ts` + `__tests__/choice-page-flow.test.ts`）+ `__tests__/recovery.test.ts` 微调（既有不变）。
- `packages/bridge` / `packages/worker` / `packages/shared` 零改动（任务 07 仅 web 侧；bridge 多 manager 复数化由任务 06 完成、`WsClient` 消费 session_list 是单端视角无需 bridge 配合）。

### 与 [[tasks/m4/06-bridge-session-layer.md|任务 06]] / [[tasks/m4/02-shared-protocol-v3.md|任务 02]] 对照

| 维度 | M4 任务 [[tasks/m4/02-shared-protocol-v3.md\|02]] | M4 任务 [[tasks/m4/06-bridge-session-layer.md\|06]] | M4 任务 07（本任务） |
|------|---------------------------------|---------------------------------|---------------------|
| 测试基线 | shared 308 不变 | 446 → **485 单测** / **32 集成** | 485 → **583 单测** |
| 新建核心文件 | `work-dirs.ts` / `session-list.ts` | `session-layer.ts` | `hash.ts` / `ChoicePage.tsx` / `DirectoryBrowser.tsx` |
| 关键 seam | envelope `session` 启用规则（schema 仍 optional）+ ADR-0010 | `BridgeSessionLayer` 多 manager Map + SPAWN_TIMEOUT_MS + pending 键控 + `M3_LEGACY_KEY` | `decideView` 决策表 + `readAuthFromHash` 三字段 + `registerReplyResolver` 一次回调范式（替代 M3 `setInterval` 轮询）+ session_list `null` vs `[]` 语义钉桩 |
| review 结论 | 0C / 4W / 7S（6 项落地 + 3 项递延任务 09）| **2C / 7W / 9S 全部处置**（C2 m3-legacy 文档化转任务 08 退役评估；S15/S17/S18 三项合理跳过）| **1C / 6W / 5S 全部处置**（C1 + W1 + W5 轮询架构重构——setInterval + transient Maps → registerReplyResolver 一次回调；S3/S5 合理跳过）|
| 教训承接 | M3 `1c86aca` worker 转发链教训 | M3 `get_messages.reply_to` 翻译层教训 + **真 pi 探针铁律** | M3 task 07 双查询仪式 `registerReplyResolver` 范式（迁移至 ChoicePage 多命令并行场景）+ M3 task 06 ChatView type 路由范式（per-id 精确触发替代 type 路由）|