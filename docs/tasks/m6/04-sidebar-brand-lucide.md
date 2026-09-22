---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：引 lucide-react + Sidebar 重写（brand 双行块 + session row + BridgeStatusBar reference「远端连接」卡）

## 完成情况（2026-09-22，334941a 范围）

- **commit**：`334941a` feat(web): M6 T04 — Sidebar reference 重做（brand 双行块 + lucide-react 引入 + 远端连接卡 + 汉堡 SVG 双处收编）。
- **做了什么**：`pnpm --filter @remotepi/web add lucide-react`（唯一新增依赖，D3 兑现）；删除 Sidebar / MobileTopBar 双处内联 `HamburgerIcon` SVG（M5 M+ (d) 兑现，统一 `<Menu>` / `<X>`）；Sidebar 顶部 72px brand 双行块（深石板 `#17202b` size-9 rounded-xl + `<Terminal>` 白图标 + 「RemotePi」加粗 + 「远程开发工作台」11px 灰副文）；分组标题 11px uppercase tracking-[0.12em]；session 行 rounded-xl + hover/active token 化蓝块（WorkDirs tab 当前目录 `bg-[var(--accent-soft)] text-[var(--accent)]`）；BridgeStatusBar reference「远端连接」卡（Globe2 / Server / Bot 三节点 size-7 rounded-lg + emerald-300 连线 + emerald-500 + animate-ping 心跳 + 「链路正常」10px emerald-600）；设置按钮简化行（lucide `<Settings>` + 「设置」文案）；**carve-out**：session-row 直接接管点击（移除 7700d6c 既有 `session-select` testid，由 session-row onClick 承担——T10 实证 e2e 9 spec 全集无引用）。
- **关键偏差**：BridgeStatusBar 离线态文案由草案「未连接」落地「链路断开」（draft 用「未连接」），与「正在连接 / connecting / 链路正常」三态文案对齐。
- **关键候选**：`use-only lucide` 字面值收编进 token（M+ 候选，T04 留 `bg-[#1f9d55]` / `bg-[#ecfdf5]` 等 emerald 字面值未抽 4 处 — 由 T07 dialog icon block 顺手收编）。
- **testid**：`sidebar-tabs` / `session-row` / `work-dir-row` / `bridge-status[data-state]` / `settings-button` 沿用；`data-state` 语义不变（e2e 01 / 05 / 07 强依赖）。
- **测试基线**：`sidebar.test.tsx` 既有 ≥5 + 新增 22 条（**from 4 to 26 tests**；brand 双行块 + lucide 节点 + BridgeStatusBar 三态文案 + 离线态无 emerald-500 断言全部覆盖）。
- **build 实测**：lucide-react tree-shaking 后实际增量 ~+6 KB gzip（web entry **296.75 KB / 84.64 gzip** vs M5 baseline 266.98 / 77.87 = +29.77 / **+6.77 KB**）——落在预估 +5~+10 KB 区间内。
- **M4 雷区**：零字节 diff。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + §4 图标 lucide + G6 + D3 / D5 / D7]] 落地 Sidebar 全量重做 + 引 lucide-react：

1. **引 lucide-react**（D3，唯一新增依赖）：
   - `pnpm --filter @remotepi/web add lucide-react`；
   - 各组件直接 `import { Terminal, Plus, Settings, Globe2, Server, Bot, Menu, X } from 'lucide-react'`；
   - 验证 Vite 默认按需打包（tree-shaking）。
2. **删除双处内联 HamburgerIcon SVG**（兑现 M5 M+ (d)）：
   - 删除 `Sidebar.tsx` 内联 HamburgerIcon SVG（如有）；
   - 删除 `MobileTopBar.tsx` 内联 HamburgerIcon SVG；
   - 统一 `lucide-react` 的 `Menu` / `X`。
3. **Sidebar 顶部 72px brand 双行块**（D5）：
   - 左侧 size-9 rounded-xl 深石板 `#17202b` 方块 + Terminal 白图标（lucide）；
   - 右侧两行：上行「RemotePi」加粗（`text-[15px] font-semibold text-[var(--text)]`）+ 下行「远程开发工作台」11px 灰（`text-[11px] text-[var(--muted)]`）；
   - 整体高度 72px（`h-[72px]`）。
4. **分组标题 11px uppercase tracking-[0.12em]**：
   - 「对话」/「工作目录」分组标签，token 化 `text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]`；
   - 仅在 tab 内容上方显示。
5. **session 行 reference 形态**：
   - 容器 `rounded-xl px-3 py-2.5`；
   - active `bg-[#f4f6f8]`（或 token 化 `bg-[var(--surface-2)]`，落地时统一）；
   - 非 active `text-[#687482] hover:bg-[#f8f9fa]`；
   - token 化表达（落地时 `text-[var(--muted)]` 等）。
6. **WorkDirs tab 当前目录高亮**：
   - active `bg-[#f0f5ff] text-[#245bc4]`（token 化 `bg-[var(--accent-soft)] text-[var(--accent)]`）；
   - 11px 行内 metadata 灰副文（first_message / time 摘要，与 M4 ChoicePage level2 既有渲染对齐）。
7. **底部 BridgeStatusBar 重做 reference「远端连接」卡**（D7）：
   - 容器：白底卡 + 边框 + 圆角 + shadow-sm；
   - 三节点 size-7 rounded-lg 白底 shadow-sm：`Globe2`（bridge）/ `Server`（worker）/ `Bot`（pi）——lucide 图标；
   - 节点之间 emerald-300 连线（SVG 自绘 1px line）；
   - 节点 emerald-500 + animate-ping 心跳（仅 bridge 节点）+ 「链路正常」10px emerald-600 文案；
   - 离线时三节点灰色 + 连线断 + 「链路断开」文案；
   - connecting 时节点 pulse + 「正在连接」文案。
8. **设置按钮简化行**：
   - 容器行 `flex items-center gap-2 px-3 py-2.5 rounded-xl hover:bg-[#f8f9fa]`；
   - lucide `Settings` size 16 + 「设置」文字；
   - 触发 TokenModal closable 模式（M5 行为延续）。
9. **testid 全保**：
   - `sidebar-tabs` / `session-row` / `work-dir-row` / `bridge-status[data-state]` / `settings-button` 沿用；
   - `data-state` 语义不变（e2e 01 / 05 / 07 强依赖）；
   - 视觉装饰容器（如 `sidebar-brand`）新增 testid 不计入本契约（D6）。
10. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，04 仅确认无遗留）。

## 测试义务

- [ ] **`sidebar.test.tsx` 既有 ≥5 用例 0 回归**（默认 tab / 切换 tab / session 点击 hash 写 / 设置按钮回调 / bridge 三态 badge）
- [ ] **`sidebar.test.tsx` 新增 ≥3 条**（lucide 引 + brand 双行块 + 「远端连接」卡）：
   - 顶部 brand 容器渲染 Terminal 图标 + 「RemotePi」 + 「远程开发工作台」（lucide Terminal 节点断言）；
   - 底部 BridgeStatusBar 容器含 Globe2 / Server / Bot 三节点（lucide 节点断言）；
   - 离线态时三节点无 emerald-500 class + 「链路断开」文案。
- [ ] **`bridge-status[data-state]` 钉桩不变**——e2e 01 / 05 / 07 强依赖，data-state 语义不变；单测 + e2e 双层验证。

## 完成标准

- [ ] `pnpm --filter @remotepi/web add lucide-react` 成功；`pnpm-lock.yaml` 更新
- [ ] 删除 Sidebar / MobileTopBar 双处内联 HamburgerIcon SVG（M5 M+ (d) 兑现）
- [ ] Sidebar 顶部 72px brand 双行块（D5）
- [ ] 分组标题 11px uppercase tracking-[0.12em]
- [ ] session 行 reference 形态 + WorkDirs tab 高亮 token 化蓝块
- [ ] BridgeStatusBar reference「远端连接」卡（Globe2 / Server / Bot + emerald-300 连线 + emerald-500 心跳 + animate-ping + 「链路正常」）
- [ ] 设置按钮简化行
- [ ] testid 锚点零增零删（sidebar-tabs / session-row / work-dir-row / bridge-status[data-state] / settings-button 沿用）
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证；e2e 01 / 05 / 07 bridge-status data-state 兼容）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] build 实测体积记录（D8 不设门槛，只记录——预估 lucide-react tree-shaking 后 +5 ~ +10 KB gzip）
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]（sidebar 容器宽度 300px 已落地）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / §4 图标 lucide / G6 / 决策 D3 / D5 / D7]]
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] Sidebar / BridgeStatusBar / SessionStatusBar 基线
- [[tasks/m5/07-mobile-drawer.md|tasks/m5/07]] MobileTopBar / 汉堡按钮基线
- [[prds/m5-uiux.md#修订注记2026-09-12-第二块收官|PRD M5 §修订注记]] M+ 挂账候选 (d) 兑现依据
