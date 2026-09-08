---
prd: prds/m4-multi-session.md
status: todo
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