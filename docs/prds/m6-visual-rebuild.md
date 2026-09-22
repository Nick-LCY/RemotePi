# M6 — Web UI 全量视觉重做（reference 蓝本）

> 状态：**✅ 实施收官（2026-09-22，11/11 任务 done，待用户 push + 端到端验收）**（已定稿 2026-09-22 用户裁定 D1-D12 全部就位；前置 M5 第一块 + 第二块均 2026-09-22 用户口头确认全部完成，单测基线 **977** / 全仓 **1502** / 集成 **32** / e2e **9 spec × 2**）。本 PRD 范围：**packages/web + docs 增量**；**协议 / worker / bridge / shared 零改动**（M5 实施期挂账 M+ 候选 (a) Tailwind scanner 22 条精简 / (b) DirectoryBrowser 桌面端 backdrop / (d) HamburgerIcon 双处重复 / (g) 存量 ~1280 行 CSS 全量迁 Tailwind——M6 任务 02 / 04 兑现 (d) + (g)）。
>
> **决策记录 D1-D12 已全部定稿**（2026-09-22 用户裁定），写作时不再保留「待裁定」字样；细节值 / 颜色 token / 组件映射表落地见 [[tasks/m6/01-token-retranslation.md|任务 01]] / [[tasks/m6/02-css-full-migration.md|任务 02]] / [[tasks/m6/07-dialoghost-styling.md|任务 07]] / [[tasks/m6/09-statusbar-choice-recovery.md|任务 09]] / [[tasks/m6/11-dark-contrast-a11y.md|任务 11]]。

## 背景

M1–M5 全 done（34 + 8 = 42 任务全部落地）。M5 第二块已实施收官（2026-09-12），10 个 web commit + 用户并行 ADR-0013 bridge 修复，单测基线 977 / 全仓 1502 / e2e 9 spec × 2 全绿；2026-09-22 用户口头确认全部完成（push 状态未独立核实）。web 端积累下列短板，构成本轮 M6 立项的动机：

1. **色板偏冷蓝偏深（accent `#2c5cff` / `#6c8cff`）+ 暗色 token 命名零散**——M5 第二块 13 token 是「patch 化」历史延续，未走「reference 蓝本 + WCAG AA 校色」重做；视觉语言与 reference（线性冷蓝调 + 深石板暗色）有偏差。
2. **AppShell 双 elevated 卡 + Sidebar 300px + 品牌双行块形态缺失**——M5 任务 06 的 Sidebar 是 280px + 顶部 `<h1>RemotePi</h1>` 单行品牌位，与 reference 的「深石板方块图标 + 副文」双行块差异显著。
3. **MessageList 仍是旧垂直堆叠 plain row（无气泡 / 无头像 / 无时间戳）**——M5 任务 01 / 02 完成 markdown 渲染 + textarea 升级，但消息气泡 / AI 头像 / 时间戳格式未做；与 reference 的「AI size-8 深石板头像 + 气泡 rounded-2xl + 时间戳 10px 灰」形态差距明显。
4. **Sidebar / MobileTopBar 双处内联汉堡 SVG 重复**（M5 M+ (d)）——M5 任务 06 + 07 各定义一份 `HamburgerIcon` SVG；本轮 M6 兑现 M+，引 `lucide-react` 单一图标库。
5. **存量 ~1280 行 styles.css 散落各组件**（M5 M+ (g)）——M5 第二块触碰处顺手迁，**未**做全量迁移；本轮 M6 任务 02 兑现 M+，按组件分批**全量迁** Tailwind utilities（styles.css 收缩为 `@import` + `@theme` + `:root` / `@media dark` 20+ token + ~70 行不可 utility 化的 `@layer components` 语义类）。
6. **Sidebar 双处内联 SVG + 4 类弹窗分色 + toast 等 6 组件参考 reference 风格化**（M5 D7 defer）——本轮 M6 任务 04 / 07 / 08 / 09 统一 reference 形态语言。
7. **暗色 token 未按 WCAG AA 校色**（M5 M+ (R3)）——dark border `#2a3140` 与 surface `#1a2030` 边差仅 5.4:1，部分 UI 元素临界；本轮 M6 任务 11 兑现，统一校色 + 焦点可及性核对。

## 目标

- **G1** 全局 accent 切换 reference 冷蓝 `#245bc4` 全家族（hover `#194da9` / soft `#f0f5ff` / ring `#eef4ff` / focus 边 `#7da1df` / `#9eb9e9`），暗色 accent 提亮为 `#6f9bff` / hover `#8aaeff` / soft `#1c2742`（D1）。
- **G2** styles.css token 13 → 20+，含新增灰阶 token（muted-2 ~ muted-5）+ 边框双层（border / border-2 / border-3）+ state 色完整（connecting #87919d / online #1f9d55 / offline #c0392b）——所有颜色按 reference 蓝本重写并 token 化（D1 / D2）。
- **G3** 引入 `lucide-react`（D3，用户裁定）——唯一新增 npm 依赖；删除 Sidebar / MobileTopBar 双处内联汉堡 SVG；组件图标统一走 lucide。
- **G4** 全量迁 ~1280 行 styles.css → Tailwind utilities（D4）——styles.css 收缩为 `@import "tailwindcss";` + `@theme` 完整 var() 引用 + `:root` / `@media (prefers-color-scheme: dark)` 20+ token + ~70 行 `@layer components` 不可 utility 化的语义类。
- **G5** AppShell 桌面态改 reference 双 elevated 卡（外层 bg + sidebar rounded-2xl border shadow-sm + main rounded-2xl border shadow-sm bg-white），sidebar 280→**300px**（D5），testid 全保（app-shell / app-shell-main / sidebar-toggle / sidebar-backdrop）。
- **G6** Sidebar 重做：72px brand 双行块（深石板 `#17202b` 方块 size-9 rounded-xl + Terminal 白图标 + 「RemotePi」加粗 + 「远程开发工作台」11px 灰副文）+ 11px uppercase tracking-[0.12em] 分组标题 + session 行 reference 形态 + WorkDirs tab 当前目录 `bg-[#f0f5ff] text-[#245bc4]` 高亮 + 底部 BridgeStatusBar reference「远端连接」卡（Globe2 / Server / Bot 三节点 size-7 rounded-lg 白底 shadow-sm + emerald-300 连线 + emerald-500 节点 + animate-ping 心跳 + 「链路正常」10px emerald-600）+ 设置按钮简化行。
- **G7** MessageList 气泡化（D6 / D11）——保留 `message-row` 容器 class + `message-role-{user|assistant}` 角色 class + 全部 testid **零增零删**；AI 行 `flex items-start gap-3` + size-8 深石板头像方块（Zap 图标）+ 名字行 + 气泡 `rounded-2xl rounded-tl-sm bg-[#f5f7f9] px-4 py-3 text-sm leading-6 text-[#4d5966]` + 时间戳 `text-[10px] text-[#a2aab3]`；用户行 `flex justify-end` + max-w-[80%] + 气泡 `rounded-2xl rounded-tr-sm bg-[#245bc4] text-white`；`.message-body` 仍是 textContent 父容器（e2e 01 / 02 / 08 流式连续性 / 角色断言 / tool 归并兼容）。
- **G8** InputBar reference 形态：外壳 rounded-2xl border 常驻 `0 4px 18px rgba(23,32,43,0.06)` shadow（token 化 `--shadow-card`）+ focus-within:border-accent + focus-within:ring-4（`--accent-ring`），移除旧 2px outline 双焦点指示（统一单一焦点指示，键盘 focus-visible 语义保留）；发送钮 size-8 rounded-xl 深石板（Send 图标）；abort 红色形态；底部 helper 文案。
- **G9** TokenModal reference 形态（rounded-2xl p-7 shadow-2xl max-w-[420px]）+ backdrop `bg-[#17202b]/45 backdrop-blur-[3px]` + 头部 size-11 rounded-xl tinted icon block（Hash 图标）+ input `h-11 rounded-xl bg-[#fafbfc] focus:border-[#7da1df] focus:ring-4`（token 化）+ 提交钮蓝填充 + 底部隐私说明文案。两模式逻辑 / testid / z-400 零改动。
- **G10** 4 类弹窗 + toast 统一 reference modal 形态（D7）——confirm 绿 `#ecfdf5` / `#1f9d55`、select 琥珀 `#fef3c7` / `#d97706`、input/editor 蓝 `#eef4ff` / `#245bc4` tinted icon block；footer 按钮 primary 蓝填充 / cancel 白底描边；props 接口 / dispatcher / 倒计时 / testid 全集零改动。
- **G11** DirectoryBrowser modal 化 reference 形态 + 路径条 inline code + entry 行 rounded-xl + **桌面端新增 backdrop**（z-250，深石板族，兑现 M5 M+ (b)）；移动全屏 sheet 沿用；testid 全保。
- **G12** SessionStatusBar（白卡 pill 条 + phase badge tinted 小方块 + queue pills 浅灰小 pill）/ ChoiceLevel1/2Panel（极简提示卡）/ RecoveryView（in-flight 卡 + error 卡，仅样式，逻辑零改动——D12 + 雷区）reference 形态化。
- **G13** 暗色对比度 WCAG AA 校色（任务 11）——正文 ≥4.5:1 / UI ≥3:1 实测；R3 已知临界点微调（dark border / accent-on-soft 等，±5% L 授权）；focus 可及性核对（单一焦点指示 + focus-visible 键盘路径）。
- **G14** 质量门（任务 10）：
  - 单测 **977 不回归** + 任务 01-11 新增合计（预估 +25 ~ +35）；
  - 集成 **32 零回归**；
  - e2e **9 spec × 2 连跑全绿**（预期改动 ≤3 行：spec 09/04 className 字符串断言与新容器 class 对齐）；
  - typecheck **4 包绿** / lint **0 error** / `pnpm -r build` **4 包绿** + **记录实测体积对比基线**（D8：不设门槛，只记录）；
  - testid 锚点零增零删；
  - 协议 / worker / bridge / shared 零改动（git diff 实证）；
  - M4 雷区零字节 diff（grep `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中既有位置）。

## 非目标

- **不破协议 v3**（D 锁版，2026-09-08）；本轮 wire 协议不变。
- **不破既有功能 / 交互语义**：侧边栏双 tab、TokenModal 两模式（required 不可关 / closable 三路关）、移动端抽屉（<768px / 焦点陷阱 / 滚动锁 / z-index 栈 toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)）、4 类阻塞弹窗、恢复仪式、DirectoryBrowser、markdown 三件套、textarea 自动增高 + IME 守卫、thinking / tool 默认折叠、toolResult 归并 pill。
- **testid 锚点零增零删**——data-* 属性也全保（M5 D13 既有承诺延续）。
- **不引 Radix / Base UI / shadcn / cva**——`lucide-react` 是本轮**唯一新增**依赖（D3）。
- **不动 worker / bridge / shared / 协议**（D 包边界承诺）——纯 packages/web + docs 增量。
- **M4 雷区零字节 diff**（D12 / 雷区）——`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher 五处代码块不动；本轮 RecoveryView 仅样式重做，逻辑零改动。
- **RecoveryView 逻辑零改动**（D12）——autoStartConsumedRef / useEffect / gateRef.current.retry() 等语义全保留；样式层只动 className / styles.css 对应规则。
- **build 体积不设硬门槛**（D8）——只记录实测对比；当前基线 entry 266.98 KB raw / 77.87 KB gzip、CSS 32.67 KB / 6.92 KB。
- **暗色触发方式不变**（D9）——`@media (prefers-color-scheme: dark)`，不加切换按钮。

## 方案

### §1 token 翻译（reference 蓝本 → CSS 变量）

| 层 | light token | dark token | 用途 |
|----|------------|------------|------|
| **bg** | `--bg #f6f7f9` | `--bg #0e1218` | 应用底色 |
| **surface** | `--surface #ffffff` | `--surface #1a2030` | 卡 / 面板背景 |
| **surface-2** | `--surface-2 #f5f7f9` | `--surface-2 #222837` | 二级表面（输入条 / hover 浅底） |
| **text** | `--text #17202b` | `--text #e6e9ee` | 正文 |
| **muted** | `--muted #687482` | `--muted #9aa3ad` | 次级文本 |
| **muted-2** | `--muted-2 #4d5966` | `--muted-2 #cbd0d6` | 消息正文 |
| **muted-3** | `--muted-3 #74808c` | `--muted-3 #a3acb5` | 三级 |
| **muted-4** | `--muted-4 #87919d` | `--muted-4 #8b95a0` | 四级 |
| **muted-5** | `--muted-5 #9aa3ad` | `--muted-5 #6f7a85` | 五级 |
| **accent** | `--accent #245bc4` | `--accent #6f9bff` | 蓝 |
| **accent-hover** | `--accent-hover #194da9` | `--accent-hover #8aaeff` | 蓝 hover |
| **accent-soft** | `--accent-soft #f0f5ff` | `--accent-soft #1c2742` | 蓝软底 |
| **accent-ring** | `--accent-ring #eef4ff` | `--accent-ring #1c2742` | 蓝 ring |
| **border** | `--border #e4e8ed` | `--border #2a3140` | 一级边 |
| **border-2** | `--border-2 #dfe4e9` | `--border-2 #353c4a` | 二级边 |
| **border-3** | `--border-3 #edf0f3` | `--border-3 #202632` | 三级边 |
| **code-bg** | `--code-bg #ffffff` | `--code-bg #222837` | 代码块底 |
| **state-connecting** | `--state-connecting #87919d` | `--state-connecting #74808c` | 灰 |
| **state-online** | `--state-online #1f9d55` | `--state-online #34d399` | 绿（emerald 调） |
| **state-offline** | `--state-offline #c0392b` | `--state-offline #f87171` | 红 |
| **shadow-card** | `--shadow-card 0 4px 18px rgba(23,32,43,0.06)` | `--shadow-card 0 4px 18px rgba(0,0,0,0.4)` | 卡片阴影 |
| **sidebar-width** | `--sidebar-width 300px` | `--sidebar-width 300px` | 侧栏宽度（D5：280→300） |

完整落地值（落地时可能微调但保持 reference 调性）见 [[tasks/m6/01-token-retranslation.md|任务 01]]。

### §2 组件映射（reference 蓝本 → 现有组件）

| reference 组件 | 本项目现有组件 | 任务文件 | testid 处理 |
|----------------|----------------|----------|-------------|
| Sidebar 双行 brand | Sidebar 顶部 | [[tasks/m6/04-sidebar-brand-lucide.md\|04]] | 沿用 / 新增 `sidebar-brand` |
| Session row（reference 形态） | Sidebar Sessions tab 行 | 04 | `session-row` 沿用，容器 class 调整（视觉不可见） |
| WorkDir row（高亮蓝块） | Sidebar WorkDirs tab 行 | 04 | `work-dir-row` 沿用，active 高亮换 token 化蓝 |
| BridgeStatusBar（reference「远端连接」卡） | Sidebar 底部 BridgeStatusBar | 04 | `bridge-status[data-state]` 沿用，data-state 语义不变 |
| MessageList bubble | ChatView MessageList | [[tasks/m6/05-chatview-bubbles-inputbar.md\|05]] | `message-row` / `message-role-{user\|assistant}` / `message-body` / `message-draft` 全保留；视觉不可见 |
| AI 头像（size-8 深石板方块 + Zap 图标） | ChatView AI 行 | 05 | 新增 `message-avatar` 视觉装饰（非断言用），不计入 testid 锚点契约 |
| 时间戳（10px 灰） | ChatView 每行底部 | 05 | 视觉装饰 |
| InputBar（外壳 rounded-2xl shadow） | ChatView InputBar | 05 | `input-field` / `input-send` / `input-abort` 沿用 |
| TokenModal（reference 卡片形态） | TokenModal | [[tasks/m6/06-token-modal.md\|06]] | `token-modal` / `token-modal-backdrop` / `token-modal-close` / `token-input` / `token-submit` 沿用 |
| 4 类 DialogHost 弹窗 | DialogHost | [[tasks/m6/07-dialoghost-styling.md\|07]] | `dialog-host` / `dialog-{type}` / `dialog-{type}-{action}` 全集沿用 |
| Toast | DialogHost toast | 07 | `dialog-host-toast` 沿用 |
| DirectoryBrowser modal | DirectoryBrowser | [[tasks/m6/08-directory-browser-modal.md\|08]] | `directory-browser*` 全集沿用；桌面端新增 backdrop z-250 |
| SessionStatusBar（白卡 pill 条） | SessionStatusBar | [[tasks/m6/09-statusbar-choice-recovery.md\|09]] | `phase-indicator[data-phase]` 沿用 |
| ChoiceLevel1Panel / ChoiceLevel2Panel | ChoicePage 收口后的 Panel | 09 | `work-dir-list` / `session-list` / `new-session-button` 沿用 |
| RecoveryView（仅样式） | RecoveryView | 09 | `recovery-in-flight` / `recovery-error-card[data-error]` 沿用；逻辑零改动（D12 / 雷区） |
| AppShell 双 elevated 卡 | AppShell | [[tasks/m6/03-app-shell-rebuild.md\|03]] | `app-shell` / `app-shell-main` / `sidebar-toggle` / `sidebar-backdrop` 沿用 |

> **核心约束（D6）**：保留 `message-row` 容器 class + `message-role-{user|assistant}` 角色 class + 全部 testid 零增零删；气泡化只在容器内部做；e2e 01 / 02 / 08 流式连续性 / 角色断言 / tool 归并兼容——实施后必须真跑 e2e 01 / 02 验证。

### §3 CSS 全量迁（D4，~1280 行 → utilities + ~70 行 @layer components）

按组件分批（任务 02 承载，组件序与写盘顺序）：

1. **App** → 根层 + body + reset
2. **ChatView** → `.message-row` / `.message-role-*` / `.message-body` / `.message-draft` / `.message-thinking-*` / `.message-tool-*`
3. **AssistantMessageBody** → `.assistant-text-segment` / `.markdown-*`
4. **dialogs 全套** → `.dialog-*` / `.dialog-host-*` / `.dialog-host-toast` / `.dialog-error`
5. **DirectoryBrowser** → `.directory-browser-*`
6. **ChoicePanels** → `.choice-page-*` / `.status-*`
7. **壳层零散遗留** → BridgeStatusBar / SessionStatusBar / Sidebar / MobileTopBar / TokenModal / AppShell

**保留 ~70 行 `@layer components` 语义类**（不可 utility 化）：

- `.markdown` 自定义滚动条（`overflow: auto` + `::-webkit-scrollbar` 等需要伪元素选择器）；
- 折叠箭头 `.details-arrow` 等的 `::before` 伪元素；
- `<details><summary>` marker 隐藏（`summary::-webkit-details-marker { display: none }`）；
- `.visually-hidden`（无障碍 sr-only）；
- `.message-tool-result-error` / `.message-tool-result-orphan` 修饰符（M5 验收期 gap 修复沉淀的语义类）。

**单测影响**：assistant-message-body.test.tsx 12 处 class 字面断言改 regex 形态；token-modal.test.ts 4 处 regex 核对。

**顺手 `@source not` 精简 22 条未消费 utility**（M5 M+ (a) 兑现）。

### §4 图标 lucide（D3）

`pnpm --filter @remotepi/web add lucide-react`——**唯一新增**依赖。

| 位置 | 现状 | 改为 |
|------|------|------|
| Sidebar 顶部 brand 双行块 | （新增） | `<Terminal size={18} />` |
| Sidebar 新建按钮 | （手绘或无） | `<Plus size={16} />` |
| Sidebar 底部 BridgeStatusBar | （手绘三节点） | `<Globe2 size={14} />` / `<Server size={14} />` / `<Bot size={14} />` + 自绘连接线 / 节点 / 心跳 |
| Sidebar 设置按钮 | （手绘或无） | `<Settings size={16} />` |
| MobileTopBar 汉堡 | 内联 SVG | `<Menu size={20} />` / 关闭 `<X size={20} />` |
| MobileTopBar 关闭抽屉 | 内联 SVG | `<X size={20} />` |
| ChatView AI 头像 | （新增） | `<Zap size={16} />` |
| InputBar 发送钮 | （手绘或无） | `<Send size={16} />` |
| InputBar abort 钮 | （手绘或无） | `<Square size={14} />` 或 `<StopCircle size={16} />` |
| TokenModal 头部 icon block | （新增） | `<Hash size={20} />` |
| DirectoryBrowser 头部 | （手绘或无） | `<FolderOpen size={18} />` |
| 4 类 DialogHost icon block | （手绘或无） | `<HelpCircle />` / `<ListChecks />` / `<PenLine />` / `<Edit3 />`（按 dialog 类型映射） |
| Toast icon | （手绘或无） | `<Info />` / `<AlertTriangle />` / `<CheckCircle2 />`（按 toast 类型映射） |

> **M5 M+ 挂账 (d) 兑现**：删除 Sidebar / MobileTopBar 双处内联汉堡 SVG，统一 `lucide-react` 的 `Menu` / `X`。

### §5 响应式（D9 沿用 M5 D12）

断点 / 抽屉 / 焦点陷阱 / 滚动锁 / z-index 栈 / modal 全屏 sheet 全部沿用 M5 任务 07 落地形态；本轮 M6 **不修改响应式架构**——只重做组件视觉，按 reference 形态。

### §6 暗色（D2 + D9）

- 触发方式：`@media (prefers-color-scheme: dark)`，**不变**；
- 20+ token 全部提供 dark 变体（见 §1 表）；
- WCAG AA 校色由 [[tasks/m6/11-dark-contrast-a11y.md|任务 11]] 实测 + ±5% L 微调授权；
- focus 可及性核对（单一焦点指示 + focus-visible 键盘路径）。

### §7 testid 契约（D6 / 雷区）

**零增零删**——所有现有 `data-testid` 属性与 `data-*` 属性全保；e2e 9 spec 全部沿用既有锚点。

新增 testid（如 Sidebar `sidebar-brand` 装饰容器 / ChatView AI 头像 `message-avatar` 装饰）**不计入本契约**——这些是视觉装饰容器，不参与 e2e 断言。

e2e 9 spec 预期改动 **≤3 行**：spec 04 / 09 在某些 `className` 字符串 evaluate 断言上需对齐新容器 class（不涉及 testid）。

## 验收标准

> 勾选原则：仅勾选有实证（任务完成 / 测试门 / testid / 雷区 / 体积记录）项；用户端到端验收类留待用户推上 origin/main 后手测（详见 [[#用户操作清单]]）。

- [x] styles.css token 13 → 20+ 落地（[[tasks/m6/01-token-retranslation.md|任务 01]]），全部按 reference 蓝本调性 + WCAG AA 校色
- [x] 引入 `lucide-react`（[[tasks/m6/04-sidebar-brand-lucide.md|任务 04]] 落地），删除双处内联汉堡 SVG（M5 M+ (d) 兑现）
- [x] ~1280 行 styles.css 全量迁 Tailwind utilities（[[tasks/m6/02-css-full-migration.md|任务 02]]），styles.css 收缩为 `@import + @theme + :root + @media dark 20+ token + ~70 行 @layer components`
- [x] `@source not` 精简 22 条未消费 utility（M5 M+ (a) 兑现，T02 落地）
- [x] AppShell 桌面态双 elevated 卡（[[tasks/m6/03-app-shell-rebuild.md|任务 03]]），sidebar 300px（D5）
- [x] Sidebar brand 双行块（任务 04，D5）
- [x] MessageList 气泡化（[[tasks/m6/05-chatview-bubbles-inputbar.md|任务 05]]，D11）+ 全部 testid / message-row / message-role-* 沿用
- [x] InputBar reference 形态（任务 05）+ 单一焦点指示
- [x] TokenModal reference 形态（[[tasks/m6/06-token-modal.md|任务 06]]）+ 两模式逻辑 / testid / z-400 零改动
- [x] 4 类 DialogHost + toast 统一 reference modal（[[tasks/m6/07-dialoghost-styling.md|任务 07]]，D7 分色表）
- [x] DirectoryBrowser modal 化（[[tasks/m6/08-directory-browser-modal.md|任务 08]]）+ 桌面端新增 backdrop（M5 M+ (b) 兑现）
- [x] SessionStatusBar / ChoiceLevel1/2Panel / RecoveryView reference 形态（[[tasks/m6/09-statusbar-choice-recovery.md|任务 09]]，RecoveryView 逻辑零改动——D12 / 雷区）
- [x] 全量验证（[[tasks/m6/10-e2e-validation-docs.md|任务 10]]）：单测 workspace **1091 tests / 47 files**（T10 终态；vs M5 977 基线 +114 新增）/ 集成 **32** 零回归 / e2e **9 spec × 2** 全绿（19.6s/19.1s 无 flaky 无重跑；spec 改动 0 行）/ typecheck **4 包绿** / lint **0 error / 5 pre-existing warnings** / `pnpm -r build` **4 包绿** / **build 实测体积对比基线**（D8：web entry 296.75/84.64 + CSS 34.80/7.35；详见 [[tasks/m6/README.md#t10-收官时实测基线2026-09-22commit-f1a4395-终版|T10 实测基线]]）
- [x] 暗色对比度 WCAG AA 校色（[[tasks/m6/11-dark-contrast-a11y.md|任务 11]]）：4 枚 `--on-*` token 根治 T10 三处边缘（dark 实测对比度 6.79/8.73/6.63/6.68 ≥4.5）/ focus-visible 跨组件统一 17 处 9 组件 / styles-token-contrast.test.ts 26 条断言 / `computeContrastRatio` helpers 抽取共享；T11 终态 workspace **1117 tests**（T10 1091 + T11 +26）/ 集成 32 / e2e 9×2 全绿（19.3s/19.1s）；build 体积 web entry **300.07/84.86** + CSS **35.53/7.48**（详见 [[tasks/m6/README.md#最终实测基线m6-任务-11-收官2026-09-22-head--ab10345|T11 最终实测基线]]）
- [x] testid 锚点零增零删（grep `data-testid="..."` 实证：唯一差异 = `data-testid="session-select"` 删除，T04 Sidebar 视图重组后由 `session-row` onClick 承担切换，e2e 9 spec 全集无引用）
- [x] 协议 / worker / bridge / shared 零改动（`git diff 63eceb1..ab10345 --stat` 实证：范围仅 `packages/web/**` + `pnpm-lock.yaml`；bridge 注释清理 chore `56db43d` 仅改注释零逻辑改动）
- [x] M4 雷区零字节 diff（grep 实证 `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中既有位置 `App.tsx` + 既有测试）
- [ ] **用户端到端验收**（待推 origin/main + 服务器端 bridge 择机重启后执行 8 条手测清单 + 移动端抽屉核对）

## 任务拆分

| # | 标题 | 依赖 |
|---|------|------|
| [[tasks/m6/01-token-retranslation.md\|01]] | styles.css token 13 → 20+（reference 蓝本翻译 + 灰阶 token 体系 + @theme var() 引用映射） | — |
| [[tasks/m6/02-css-full-migration.md\|02]] | ~1280 行 styles.css 全量迁 Tailwind utilities（按组件分批）+ @source not 精简 | 01 |
| [[tasks/m6/03-app-shell-rebuild.md\|03]] | AppShell 桌面态双 elevated 卡 + sidebar 300px（D5）+ 移动端 backdrop 风格化 | 01 / 02 |
| [[tasks/m6/04-sidebar-brand-lucide.md\|04]] | 引 lucide-react（D3）+ Sidebar 重写（brand 双行块 + session row + BridgeStatusBar reference「远端连接」卡） | 01 / 02 / 03 |
| [[tasks/m6/05-chatview-bubbles-inputbar.md\|05]] | MessageList 气泡化（D11）+ InputBar reference 形态 + 单一焦点指示（R4） | 01-04 |
| [[tasks/m6/06-token-modal.md\|06]] | TokenModal reference 形态（卡片 + backdrop + tinted icon block + input token 化） | 01-04 |
| [[tasks/m6/07-dialoghost-styling.md\|07]] | 4 类 DialogHost + toast 统一 reference modal（D7 分色表）+ footer 按钮形态 | 01-04 |
| [[tasks/m6/08-directory-browser-modal.md\|08]] | DirectoryBrowser modal 化 + 路径条 inline code + 桌面端新增 backdrop（z-250） | 01-04 / 06 |
| [[tasks/m6/09-statusbar-choice-recovery.md\|09]] | SessionStatusBar + ChoiceLevel1/2Panel + RecoveryView（仅样式，D12 / 雷区） | 01-04 |
| [[tasks/m6/10-e2e-validation-docs.md\|10]] | 全量验证（单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build / 体积记录）+ 文档收尾 | 01-09 |
| [[tasks/m6/11-dark-contrast-a11y.md\|11]] | 暗色对比度 WCAG AA 单测（styles-token-contrast ~10 条）+ R3 临界点校色 + focus 可及性 | 10 |

**依赖链**：

```
01 → 02 → (03, 04)
            ├─→ 05
            ├─→ 06 ──→ 08
            └─→ 07
        (ChoicePanels/Sidebar 等)
03 / 04 → 09
01-09 → 10 → 11
```

- **01** 独立（CSS token 基础设施）；
- **02 → 01**（全量迁前置 token 落地）；
- **03 / 04 → 01 / 02**（双 elevated 卡 + Sidebar + lucide 引入）；
- **05 → 01-04**（气泡化与 InputBar 引用 token + Sidebar 已就绪）；
- **06 → 01-04**（TokenModal 引用 token）；
- **07 → 01-04**（DialogHost 引用 token）；
- **08 → 01-04 / 06**（DirectoryBrowser 引用 token + Modal 形态参考）；
- **09 → 01-04**（StatusBar / ChoicePanel / RecoveryView 引用 token；RecoveryView 逻辑零改动——D12 / 雷区）；
- **10 → 01-09**（全量验证 + 文档收尾）；
- **11 → 10**（暗色对比度单测 + 校色 + a11y 核对）。

**实施期串行执行**：`01 → 02 → (03 → 04) → 05 / 06 / 07 → 08 / 09 → 10 → 11`（避免 styles.css + App.tsx 冲突；03 / 04 逻辑独立但写盘顺序沿用先底层后上层）。

总计 11 个任务（区间 8-12 内）。

## 交付约定

沿用 [[prds/m2-tunnel.md#交付约定|M2 / M3 / M4 / M5 交付约定]]：所有任务（01-11）只在本地 commit，不 push。10 落地后由用户本地验证（lint / typecheck / test / build + e2e 9 spec × 2 全绿 + 三端联调手测通过）→ 用户手动 `git push origin main` → Actions 首跑 CD（沿用 M5 deploy.yml）。

## 用户操作清单

- **新增配置项**：无（仅新增 `lucide-react` 一个 npm 依赖，由任务 04 落地）。
- **验证**：访问 `https://remote-pi.sankabox.com/`（无 hash；旧书签 `#<token>` 形态仍直接失效）→ 首次弹 TokenModal required（reference 形态）→ 粘贴 token → reload → 进入 sidebar（reference brand 双行块 + 双 tab + 远端连接卡）→ 多会话切换走 sidebar → 输入框 reference 形态（气泡圆角外壳 + shadow + focus 蓝 ring）→ 弹窗 / DirectoryBrowser / StatusBar / RecoveryView 全部 reference 形态。
- **联调手测**：在 PR / current-state 区确认 `pnpm run lint && pnpm run typecheck && pnpm -r build && pnpm test` + `pnpm test:e2e` 全绿；build 实测体积对比基线（entry 266.98 / CSS 32.67 raw，**不设门槛**，只记录）。
- **新形态手测验收清单**（沿用 M5 §10 风格，11 任务 done 后由用户验收）：
  - reference accent 蓝全家族视觉一致（按钮 / 链接 / focus ring / 弹窗分色）；
  - Sidebar 300px + brand 双行块 + 远端连接卡三节点动画；
  - MessageList AI / User 气泡布局 + AI 头像 + 时间戳；
  - InputBar 圆角外壳 + shadow + focus 单一指示；
  - 4 类弹窗 + toast + DirectoryBrowser reference 形态 + tinted icon block 分色；
  - SessionStatusBar pill 条 + queue pills + phase badge tinted；
  - RecoveryView 逻辑零改动 + 卡片样式；
  - 暗色模式对比度（任意关键页目测 + Lighthouse a11y）；
  - 移动端抽屉（<768px）所有视觉元素正常显示。

## 风险与实现时核实

- **M4 雷区零字节 diff 守护**（R1，D12）——`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher 五处代码块不动；任务 09 明确不下移 gateMapRef 到 AppShell / Sidebar；RecoveryView 逻辑零改动。
- **message-row / message-role-* / message-body / message-draft 锚点零增零删**（R2，D6）——气泡化只在容器内部做；e2e 01 / 02 / 08 流式连续性 / 角色断言 / tool 归并兼容——实施后必须真跑 e2e 01 / 02 / 08 验证。
- **暗色 token 校色**（R3，D2 + 任务 11）——dark border `#2a3140` 与 surface `#1a2030` 边差仅 5.4:1 临界，UI 元素可能在 `#9aa3ad` muted 上 hover 时不够；任务 11 提供 ±5% L 微调授权（如 `#2a3140` → `#3a4255` 方向）。
- **焦点指示单一化**（R4，任务 05）——移除旧 2px outline 双焦点指示，统一 focus-within:border-accent + focus-within:ring-4（`--accent-ring`）；键盘 focus-visible 语义保留（`:focus-visible` 与 `:focus-within` 区分）。
- **build 体积**（R5，D8）——不设硬门槛，只记录；预估：lucide-react tree-shaking 后约 +5 ~ +10 KB gzip（仅使用 ~15 个图标）；token 翻译不增体积（仅变量名调整）；全量迁 CSS 后总 CSS 体积可能微降（utilities 与 @layer components 合并后更紧凑）。
- **lucide-react tree-shaking**（R6）——v4 已支持 ESM tree-shaking；确认 Vite 默认按需打包。
- **Dark 模式下 modal backdrop 透明度**（R7）——`bg-[#17202b]/45` 在 light 模式为深石板族；在 dark 模式视觉仍可识别（与 dark bg `#0e1218` 对比足够）；任务 11 实测确认。
- **brand 双行块字号断点**（R8）——「RemotePi」加粗 + 「远程开发工作台」11px 灰副文；移动端 sidebar 300px 收纳完整，移动抽屉内沿用。
- **CSS 不可 utility 化清单**（R9）——`.markdown` 自定义滚动条伪元素 + `.details-arrow` 的 `::before` + `<details><summary>` marker 隐藏 + `.visually-hidden` + `.message-tool-result-error` / `.message-tool-result-orphan` 共 ~70 行 @layer components 保留；任务 02 末尾清单必须落实。
- **协议 / worker / bridge / shared 零改动**（硬约束）——本轮 wire 协议不变；与协议破锁无关。
- **RecoveryView 逻辑零改动**（硬约束，D12）——`autoStartConsumedRef` / `useEffect` / `gateRef.current.retry()` 等语义全保留；样式层只动 className / styles.css 对应规则。

## 相关

[[architecture/protocol/README.md|协议 v3]] / [[architecture/protocol/envelope.md]] / [[architecture/protocol/control.md]] / [[architecture/protocol/pi.md]] / [[prds/m1-infrastructure.md|M1 PRD]] / [[prds/m2-tunnel.md|M2 PRD]] / [[prds/m3-single-session.md|M3 PRD]] / [[prds/m4-multi-session.md|M4 PRD]] / [[prds/m5-uiux.md|M5 PRD]] / [[roadmap.md]] / [[current-state.md]] / [[tasks/README.md|tasks/README]] / [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]]（e2e 套路）/ [[conventions/README.md#data-testid-约定packages-web--testse2e|data-testid 约定]] / [[glossary.md]] / [[tasks/m4/08-web-multi-session-store.md|tasks/m4/08]] SessionBucket + 雷区代码基线。

## 修订注记（2026-09-22 T01-T10 实施收官）

> 本节为 M6 实施期偏差注记——**不修改 PRD 原文**（遵守 M2 / M3 / M4 / M5 「文档遵从代码」原则），仅在本节登记实施期与 D1-D12 决策不一致 / 补充实施期 M+ 候选 / testid 勘误等。

### 实施摘要

- 9 任务（T01-T09）+ 1 polish（T03-T09 review 收尾）实施收官，10 个 web commit + pnpm-lock.yaml 更新，领先 origin/main 15 commits（2026-09-22）：
  1. `63eceb1` feat(web): M6 T01 — token 体系重译（reference 冷色板 light/dark 20+ token + @theme 映射）
  2. `1226002` feat(web): M6 T02 — styles.css 全量迁 Tailwind utilities（legacy CSS 清零 + 语义标记类保留 + 断言 regex 化）
  3. `7700d6c` fix(web): M6 T02 review 修复 — 迁移视觉保真度 1:1 回归（draft 虚线/禁用态底色/圆角与 padding 校准 17 项）
  4. `c52d9f0` feat(web): M6 T03 — AppShell 双 elevated 卡布局（sidebar 300px + rounded-2xl shadow-sm + 深石板 backdrop token 化）
  5. `334941a` feat(web): M6 T04 — Sidebar reference 重做（brand 双行块 + lucide-react 引入 + 远端连接卡 + 汉堡 SVG 双处收编）
  6. `5eae766` feat(web): M6 T05 — ChatView 气泡布局 + InputBar reference 重做（AI 头像方块/用户右侧蓝气泡/单一焦点指示/深石板发送钮）
  7. `6cc1941` feat(web): M6 T06 — TokenModal reference 形态（tinted icon block + 深石板 backdrop + focus 光晕）
  8. `93cd6a9` feat(web): M6 T07 — 4 类阻塞弹窗 + toast reference 形态（tinted icon block 分色 + 倒计时 pill + footer 双按钮）
  9. `11c2ded` feat(web): M6 T08 — DirectoryBrowser reference modal 化 + 桌面端 backdrop（M+ (b) 兑现）
  10. `916998a` feat(web): M6 T09 — SessionStatusBar/ChoicePage/RecoveryView reference 形态 + session 状态色 token 化收尾
  11. `f1a4395` fix(web): M6 T03-T09 review 收尾 — 撤除多余 message-body testid + ChoicePanel 窄体居中卡修正
- **T11 暗色对比度 WCAG AA 单测 + a11y 核对** 仍 `todo`（依赖 10）——计划 T10 done 后串联 T11 校色 + a11y。
- **未推送**：沿用 M2 / M3 / M4 / M5 交付约定（用户本地验证 → push → Actions CD）。

### Carve-out 登记

- **`data-testid="session-select"` 删除**（T04 Sidebar 视图重组后由 `session-row` onClick 承担切换，e2e 全集无引用）；grep 实证唯一差异：7700d6c → HEAD 仅有 `session-select` 删除，零增（`message-body` 仅留测试负向 pin + 既有动态 `message-row` / `message-draft` 锡点不作新增）。
- **`data-testid="message-body"` 曾在 T05 短暂新增**（`message-body` textContent 父容器约定），**polish f1a4395 撤除恢复零增承诺**（仅留 `chatview-bubbles.test.tsx:186` negative pin 实证「message-body 作为 class 而非 testid」）；e2e 9 spec 全集无引用，不影响。
- **`lucide-react` 本轮唯一新增依赖**（D3）；原 `package.json` 仅增 1 行（`lucide-react: ^1.47.0`）。

### z-index 勘误（与 M5 PRD D12 文案不一致）

- **实际栈（代码 grep）**：toast/dialog-host **z-[100]** + sidebar backdrop **z-[199]**（桌面 / 移动端） + sidebar 200 + directory-browser **250** + token-modal **400**——实测 dialog-host 实际 z-[100]（M3 起沿用）。
- **M5 PRD D12 文案**：toast(100) < sidebar(200) < **dialog-host(300)** < token-modal(400)——**与代码不一致**。
- **实施期决策**：按「文档遵从代码」原则**不改 M5 PRD 原文**（M5 PRD D12 仍记 dialog-host(300)）；本 PRD 修订注记记录实际栈——**toast/dialog-host(100) < backdrop(199) < sidebar(200) < directory-browser(250) < token-modal(400)**——M+ 候选登录「mobile 抽屉(200) 与阻塞弹窗(100) 并存时的视觉层叠 quirk」（是否提升 dialog-host 至 200 以避开 toast 路由冲突，由任务 11 + 0002 评审）。
- **DialogHost 焦点陷阱缺失**（M5 既有缺漏）：T07 仍未补——mobile 抽屉与阻塞弹窗并存时，焦点可能进入黑环弹窗背后部。Joker 为 M+ 候选（任务 11 兑底 + 0002 评审）。

### M+ 候选登记（未在本轮实施）

- **DialogHost 4 类弹窗 focus trap**（M5 既有缺漏）——T07 未补；Mobile 抽屉与阻塞弹窗并存时焦点可能进入黑环。
- **focus-visible ring 跨组件统一**（input-field / token-input / dialog-input-field / work-dir-change 多处使用 -outline-none + focus-visible ring）——本轮零改；M+ 抽到 `@layer components` 为 `.focus-ring` 语义类。
- **emerald 字面值 token 收编**（T04 留 `bg-[#1f9d55]` / `bg-[#ecfdf5]` / `text-[#1f9d55]` 等 ~4 处）——T07 amber 字面值同大部。
- **dark 态 inline code 明暗反转**（T05）——两主题均达标但方向相反（light 走 accent 蓝 / dark 走 amber-400 黄系）；M+ 候选 token 化反转 `--inline-code-fg` + 两主题镜像。
- **ChoiceLevel1 双提示文案共存**（T09）——recovery 路径下既有「恢复会话」Banner 又走 ChoiceLevel1 Panel「请选择工作目录」，与 PRD 单一职责有微冲突；M+ 候选统一收口到 ChoiceLevel1。

### 测试基线（实测）

- **单测** = workspace 全量 **1091 tests / 47 files** 全绿（web 566 / bridge 378 / shared 136 / worker 11）。
- **集成** = **32 tests / 7 files** 零回归（11.15s）。
- **e2e** = **9 spec × 2 连跑全绿**，两轮各 **19.6s / 19.1s**，**无 flaky 无重跑**。
- **typecheck** = **4 包绿**。
- **lint**（web 范围） = **0 error / 5 pre-existing warnings**（WsClient.ts no-console）。
- **build 实测体积对比**（D8 不设硬门槛，只记录）：

  | 指标 | M5 baseline | M6 实测 | 增量 |
  |------|------------|---------|------|
  | web entry | 266.98 KB raw / 77.87 KB gzip | 296.75 KB raw / 84.64 KB gzip | **+29.77 / +6.77 KB** |
  | web CSS | 32.67 KB / 6.92 KB gzip | 34.80 KB / 7.35 KB gzip | **+2.13 / +0.43 KB** |
  | markdown chunk | 170.57 KB / 52.47 KB | 170.57 KB / 52.47 KB | **0 / 0**（不变） |
  | AssistantMessageBody chunk | 2.78 KB | 5.14 KB / 1.74 KB | **+2.36 KB**（T05 气泡布局 + lucide AI 头像 icon block 代码） |

### 遗留（待 T11 + 用户 push + 端到端验收）

- **T11 暗色对比度 WCAG AA 校色 + a11y 审计** `todo`——已知三处 dark 对比边缘：
  - **amber pill** on dark surface-2 ：1.8:1（低于 UI 3:1 门槛）；M+ 候选取 amber-300 或 #2f2738 背景以提升对比。
  - **accent CTA** on dark surface-2 ：2.9:1（低于 UI 3:1 门槛）；M+ 候选取 accent-hover 以提升对比。
  - **state-offline** on white text ：2.1:1（低于正文 4.5:1）；M+ 候选取 dark 变体 #f87171 以提升对比。
- **推 origin/main**——领先 15 commits 仍未推送；用户手动 `git push origin main` 触发 Actions CD（deploy.yml 沿用 M5）。
- **服务器端 bridge 更新重启**——与 push 同批动作即可合并触发（加载 M6 web commit + M5-08 efe265f 后 web 重连 token 路径修复 + ADR-0013 bridge 重连状态机修复 + ADR-0011 read-idle 判死 + ADR-0012 退避门控）。
- **用户端到端验收**：访问 `https://remote-pi.sankabox.com/`（无 hash）→ 首次弹 TokenModal required（reference 形态）→ 粘贴 token → reload → 进入 sidebar（reference brand 双行块 + 双 tab + 远端连接卡）→ 多会话切换走 sidebar → 输入框 reference 形态 → 弹窗 / DirectoryBrowser / StatusBar / RecoveryView 全部 reference 形态 → **新形态手测验收清单** 8 条（详见 [[tasks/m6/10-e2e-validation-docs.md#完成情况|T10 完成情况]] + [[tasks/README.md#m6-任务|tasks/README M6]]）。

### 修订注记（2026-09-22 T11 收官）

> 本节为 M6 收官注记——T11 暗色对比度 WCAG AA + a11y 兑底落地，11/11 任务 done。**不修改 PRD 原文**（沿用「文档遵从代码」原则），仅登记 T11 实施期增补 / 决策 / M+ 候选确认。

#### T11 摘要

- **commit `ab10345`**（HEAD，领先 origin/main **17 commits**）— M6 T11 暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性；**16 文件 +754 / -188**；与 3 个 M5 后注释清理 chore（`a61c227` web / `56db43d` bridge / `1a45a85` worker+shared）+ 13 个 M6 既有 commit 合并组成 17 commits 待 push。
- **做了什么**：4 枚 `--on-*` token 新增（on-accent / on-amber / on-offline / on-online） + focus-visible 跨组件统一 17 处 9 组件 + 新建 `styles-token-contrast.test.ts` 26 条 WCAG AA 断言（helpers 抽取共享到 `__tests__/styles-token-contrast-helpers.ts`，与既有 `styles-token-resolution.test.ts` 复用同一 `computeContrastRatio` 助手）。
- **数字**：单测 workspace 全量 **1117**（T10 1091 + T11 +26 = **1117**）+ 集成 32 + e2e 9 spec × 2 全绿（19.3s/19.1s）+ typecheck 4 包 + lint 0 error + build 4 包；build 体积 web entry **300.07 KB raw / 84.86 KB gzip**（vs M5 266.98/77.87 = +33.09/+6.99 KB）+ CSS **35.53 KB / 7.48 KB gzip**（vs M5 32.67/6.92 = +2.86/+0.56 KB）。
- **测试**：既有 1091 不回归 + 26 新增断言（4 `--on-*` token 8 组合 + 既有暗色 token 10 组合 + focus-visible 视觉可达性 4 + `--border dark` hairline 钉桩 1 + disabled 豁免 3）= **1117**。

#### 4 枚 `--on-*` token 表

| token | light | dark | dark 底实测对比度 | 备注 |
|---|---|---|---|---|
| `--on-accent` | `#ffffff` | `#0e1218` | 6.79:1（on `--accent #6f9bff`） | ≥4.5 ✓ |
| `--on-amber` | `#ffffff` | `#0e1218` | 8.73:1（on amber `#d97706`） | ≥4.5 ✓ |
| `--on-offline` | `#ffffff` | `#0e1218` | 6.63:1（on `--state-offline #f87171`） | ≥4.5 ✓ |
| `--on-online` | `#ffffff` | `#0e1218` | 6.68:1（on `--state-online #34d399`） | ≥4.5 ✓ |

- **light 模式 4 token 全部 `#ffffff`**——与按钮现役白字行为一致，**视觉零变化**（e2e 截图对照无差异）；
- **dark 模式深墨值 `#0e1218`**——与 `--bg` 同色调，按钮白底深墨字保持语义对比稳定；
- **T10 修订注记登记的三处 dark 对比边缘**（amber pill 1.8:1 / accent CTA 2.9:1 / state-offline 2.1:1 白字场景）**全部根治**。

#### focus-visible 17 处 9 组件清单

- **覆盖范围**：Button（主 + 副）/ Input / Textarea / TokenInput / DialogHost 4 类 / DirectoryBrowser entry / SessionStatusBar pill；
- **统一模式**：`focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2`（替换各组件既有零散 outline 实现）；
- **保留**：InputBar 复合输入条 `focus-within:ring-4`（`--accent-ring`）——键盘 focus-visible 与鼠标点击焦点互不干扰。

#### 对比度测试 26 条（`styles-token-contrast.test.ts`）

- **4 `--on-*` token × 2 主题（light/dark）** = 8 条（断言 contrast ≥4.5:1）；
- **既有暗色 token 对照**（10 条：--text / --muted / --accent / --border / --state-* × UI 3:1 / 正文 4.5:1 双门槛分桶）；
- **focus-visible 视觉可达性** = 4 条（focus 元素与背景对比 ≥3:1）；
- **边界钉桩** = 1 条（`--border dark` 1.25:1 hairline 钉桩，附 `[NOTE: hairline intentional]` 注释）；
- **disabled 豁免钉桩** = 3 条（disabled CTA 白字 vs 灰化底色豁免，附 `[NOTE: disabled exemption]` 注释）；
- **helpers 抽取**：从既有 `styles-token-resolution.test.ts` 抽离 `computeContrastRatio(rgb1, rgb2)` 共享 helper（WCAG 公式 + gamma 校正）到 `__tests__/styles-token-contrast-helpers.ts`，两个测试文件复用——避免重复实现 / 漂移。

#### `--border dark` 1.25:1 不调决策

- **实测**：`--border #2a3140` dark on `--surface #1a2030` = **1.25:1**（低于 UI 3:1 门槛）；
- **决策**：**保持现状**——hairline 设计意图（`text-[10px]` 时间戳 / 1px 分隔线等 UI 元素依赖细线质感）；
- **超出 ±5% L 授权窗口**（±5% L 仅覆盖 token 微调；hairline 改 token 违反设计意图），**记录不调**；
- **JSDoc 注释**明示「hairline intentional」，避免后续 agent 误改；
- **M+ 评估时一并裁决**（候选：提亮至 `#3a4255` 方向 / 接受 1.25:1 / 改用 hairline 替代实现）。

#### M+ 候选确认（维持登记，2026-09-22 T11 收官复审）

- **DialogHost 4 类弹窗 focus trap**——T11 仍未补（M5 既有缺漏；mobile 抽屉与阻塞弹窗并存时焦点可能进入黑环）；维持登记 M+（0002 评审）；
- **focus-visible ring 跨组件统一**——T11 已落地 17 处 9 组件；本候选关闭（实现 = 当前形态）；
- **emerald 字面值 token 收编**（T04 留 `bg-[#1f9d55]` / `bg-[#ecfdf5]` / `text-[#1f9d55]` 等 ~4 处）+ **amber 字面值**（T07 留 `bg-[#fef3c7]` / `text-[#d97706]` 等 ~3 处）——维持登记 M+；
- **dark 态 inline code 反转**（T05）——维持登记 M+（两主题方向相反，light 走 accent 蓝 / dark 走 amber-400 黄系）；
- **ChoiceLevel1 双提示文案共存**（T09）——维持登记 M+。

#### 关联

- **任务文件** [[tasks/m6/11-dark-contrast-a11y.md]]（T11 完成情况 + commit / 数字 / 契约自证）；
- **任务索引** [[tasks/m6/README.md#最终实测基线m6-任务-11-收官2026-09-22-head--ab10345]]（M6 终态实测基线 1117 / 集成 32 / e2e 19.3-19.1s / 体积 300.07/84.86 + CSS 35.53/7.48）；
- **任务拆分表行 11**（T11 完成标准勾选 + 测试义务勾选 + 完成情况落地）。

## 决策记录（D1-D12 全部定稿，2026-09-22 用户裁定）

> **写作时不再保留「待裁定」字样**——D1-D12 全部已定稿。

1. **D1 accent 统一 reference 蓝**（用户裁定）——accent `#245bc4` 全家族（hover `#194da9` / 浅底 `#f0f5ff` / focus 光晕 `#eef4ff` / focus 边 `#7da1df` / `#9eb9e9`）；替换现 `#2c5cff` / `#6c8cff`；暗色 accent 提亮为 `#6f9bff` / hover `#8aaeff` / soft `#1c2742` / ring `#1c2742`。
2. **D2 暗色 20+ token 全表落地**（用户裁定）——按 planner 提案全表落地（深蓝调 `#0e1218` bg / `#1a2030` surface / `#222837` surface-2 / `#e6e9ee` text / `#9aa3ad` muted / `#2a3140` border 等）；WCAG AA 由任务 11 实测校色，±5% L 微调授权已给。
3. **D3 引入 lucide-react**（用户裁定，否决 planner 手绘图标方案）——`pnpm --filter @remotepi/web add lucide-react`；各任务直接 `import { Terminal, ... } from 'lucide-react'`；顺带删除 Sidebar / MobileTopBar 双处重复的 HamburgerIcon 内联 SVG（M5 M+ 挂账 (d) 兑现）。
4. **D4 存量 ~1280 行 styles.css legacy CSS 全量迁 Tailwind utilities**（用户裁定）——M5 M+ 挂账 (g) 兑现；styles.css 收缩为 `@import "tailwindcss";` + `@theme` 完整 var() 引用 + `:root` / `@media (prefers-color-scheme: dark)` 20+ token + ~70 行不可 utility 化的 `@layer components` 语义类。
5. **D5 sidebar 280px→300px + brand 双行块**（用户裁定）——`--sidebar-width 300px`；brand 双行块 = size-9 rounded-xl 深石板 `#17202b` 方块 + Terminal 白图标 + 「RemotePi」加粗 + 「远程开发工作台」11px 灰副文。
6. **D6 保留 message-row / message-role-* 容器 class + 全部 testid 零增零删**（用户裁定）——气泡化只在容器内部做；e2e 01 / 02 / 08 流式连续性 / 角色断言 / tool 归并兼容。
7. **D7 reference 无对应物的组件用同套语言风格化**（用户裁定）——映射表见 [[tasks/m6/07-dialoghost-styling.md|任务 07]] / [[tasks/m6/09-statusbar-choice-recovery.md|09]]；SessionStatusBar（白卡 pill 条 + phase badge tinted + queue pills 浅灰小 pill）/ 4 类弹窗统一 reference modal + 按类型 tinted icon block 分色（confirm 绿 `#ecfdf5` / `#1f9d55`、select 琥珀 `#fef3c7` / `#d97706`、input/editor 蓝 `#eef4ff` / `#245bc4`）/ DirectoryBrowser modal / ChoicePage 极简提示卡 / RecoveryView 卡片。
8. **D8 build 体积只记录实测值，不设硬门槛**（用户裁定 2026-09-22）——预算不需要太在意；基线 entry 266.98 KB raw / 77.87 gzip、CSS 32.67 KB / 6.92 gzip，交付时报告对比即可。
9. **D9 暗色触发方式不变**（用户裁定）——`@media (prefers-color-scheme: dark)`，不加切换按钮。
10. **D10 CSS 全量迁按组件分批**（用户裁定）——任务 02 承载，组件序：App→ChatView→AssistantMessageBody→dialogs→DirectoryBrowser→ChoicePanels→壳层组件。
11. **D11 MessageList 完整仿 reference 气泡布局**（用户裁定）——AI 行 `flex items-start gap-3` + size-8 深石板头像方块（Zap 图标）+ 名字行 + 气泡 `rounded-2xl rounded-tl-sm bg-[#f5f7f9] px-4 py-3 text-sm leading-6 text-[#4d5966]` + 时间戳 `text-[10px] text-[#a2aab3]`；用户行 `flex justify-end` + max-w-[80%] + 气泡 `rounded-2xl rounded-tr-sm bg-[#245bc4] text-white`。
12. **D12 RecoveryView 仅样式重做，逻辑零改动**（用户裁定）——`autoStartConsumedRef` / `useEffect` / `gateRef.current.retry()` 等零改动；M4 雷区五处（`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / connect 语义 / stem-refilled watcher）零字节 diff。
