---
prd: prds/m6-visual-rebuild.md
status: done
---
# 任务：DirectoryBrowser modal 化 + 路径条 inline code + 桌面端新增 backdrop（z-250）

## 完成情况（2026-09-22，11c2ded 范围）

- **commit**：`11c2ded` feat(web): M6 T08 — DirectoryBrowser reference modal 化 + 桌面端 backdrop（M+ (b) 兑现）。
- **做了什么**：modal 化卡片容器 `rounded-2xl shadow-2xl max-w-[640px] bg-[var(--surface)]` + backdrop `bg-[#17202b]/45 backdrop-blur-[3px]` **z-[250]**（在 sidebar 200 之上、dialog-host 100/300（注：实际 dialog-host 100，详见修订注记）之下——m 与移动端抽屉栈兼容）；点击 backdrop 关闭 modal（M4 既有行为保留沿用）；头部 `px-6 py-5 border-b border-[var(--border)]` 含 `<FolderOpen size={18} />` + 「选择工作目录」+ 关闭按钮 `<X>`；路径条 inline code `bg-[var(--surface-2)] text-[var(--accent)] font-mono text-[13px] px-3 py-2 rounded-md`；entry 行 `rounded-xl px-3 py-2.5 hover:bg-[var(--surface-2)]` + 选中态 `bg-[var(--accent-soft)] text-[var(--accent)]`；footer 按钮形态沿用 T07（primary 蓝 / cancel 白底描边）；移动全屏 sheet 沿用 M5 任务 07。
- **M5 M+ (b) 兑现**：桌面端新增 backdrop（M4 既有 desktop 无 backdrop，本任务起桌面端也带 modal backdrop——视觉层叠与 TokenModal closable 一致）。
- **关键偏差**：z-250 落地（PRD 原文「桌面端新增 backdrop」未规定具体 z-index——M5 本附录栈 toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)，本任务取 sidebar(200) 与 dialog-host(300) 中间值 250）——**但实施期 DialogHost 实际 z-[100]**（M3 起沿用），与 M5 PRD D12 文案 dialog-host(300) 不一致，详见 [[prds/m6-visual-rebuild.md#修订注记2026-09-22-t01-t10-实施收官\|PRD 修订注记]] §z-index 勘误。
- **testid 全保**：`directory-browser*` 全集沿用——零增零删。
- **测试基线**：新增 `directory-browser-reference.test.tsx` **10 条**（桌面端 backdrop 渲染 + 路径条 inline code + entry 行 hover/active token 化形态覆盖）。
- **e2e 04 重点回归**：T10 实测 spec 04 路径列表断言 + 桌面端 backdrop 后断言零回归；e2e 09 移动端 sheet 兼容零回归。
- **M4 雷区**：零字节 diff。
- **协议 / worker / bridge / shared**：零改动。

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G11 + D7]] 落地 DirectoryBrowser modal 化 reference 形态 + 桌面端新增 backdrop：

1. **modal 化 reference 形态**：
   - 卡片容器 `rounded-2xl p-0 shadow-2xl max-w-[640px] bg-[#ffffff]`（token 化 `bg-[var(--surface)]`）；
   - 头部 `px-6 py-5 border-b border-[var(--border)]`：lucide `<FolderOpen size={18} />` + 标题「选择工作目录」+ 关闭按钮（X）；
   - 路径条 inline code：`bg-[var(--surface-2)] text-[var(--accent)] font-mono text-[13px] px-3 py-2 rounded-md`；
   - entry 行 `rounded-xl px-3 py-2.5 hover:bg-[var(--surface-2)]` + 选中态 `bg-[var(--accent-soft)] text-[var(--accent)]`；
   - footer 按钮形态沿用任务 07 形态（primary 蓝 / cancel 白底描边）。

2. **桌面端新增 backdrop**（兑现 M5 M+ (b)）：
   - backdrop `bg-[#17202b]/45 backdrop-blur-[3px]`（与 TokenModal / DialogHost 一致）；
   - z-index **250**（在 sidebar 200 之上、dialog-host 300 之下——与移动端抽屉与 modal 栈兼容）；
   - 点击 backdrop 关闭 modal（M4 既有行为保留，**沿用**）。

3. **移动全屏 sheet 沿用**（M5 任务 07）：
   - `<768px` 断点下 `position: fixed; inset: 0` + 圆角移除；
   - backdrop 全屏化（同 06 任务 TokenModal 全屏 sheet）。

4. **testid 全保**：
   - `directory-browser` / `directory-browser-path` / `directory-browser-list` / `directory-browser-entry-{name}` / `directory-browser-up` / `directory-browser-confirm` / `directory-browser-cancel` 沿用；
   - `data-*` 属性也全保。

5. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，08 仅确认无遗留）。

## 测试义务

- [ ] **`directory-browser.test.tsx` 既有 ≥N 例 0 回归**（具体数量以 M5 任务 06 落地为准——本任务以既有基线 977 不回归为门槛）
- [ ] **`directory-browser.test.tsx` 新增 ≥2 条**（modal 形态 + backdrop）：
   - 桌面端渲染 backdrop 元素（z-250，token 化 `bg-[#17202b]/45`）；
   - 路径条 inline code 渲染（含 font-mono + token 化 accent 蓝）；
   - entry 行渲染 rounded-xl + hover/active token 化形态。
- [ ] **e2e 04 / 09 真跑**（任务 10 终验）：
   - 04 spec directory-browser 路径列表断言（spec 04 桌面端新增 backdrop 后，断言 backdrop 元素存在——预期改动 ≤3 行）；
   - 09 spec 移动端 DirectoryBrowser 全屏 sheet 兼容（spec 09 已有 backdrop 断言需更新——预期改动 ≤3 行）。

## 完成标准

- [ ] `packages/web/src/components/DirectoryBrowser.tsx` modal 化 reference 形态
- [ ] 路径条 inline code token 化
- [ ] entry 行 rounded-xl + hover/active token 化
- [ ] **桌面端新增 backdrop z-250**（兑现 M5 M+ (b)）
- [ ] 移动全屏 sheet 沿用
- [ ] testid 锚点零增零删
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证——e2e 04 / 09 重点回归，预期改动 ≤3 行）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]（backdrop 一致性）
- 依赖 [[tasks/m6/04-sidebar-brand-lucide.md|04-sidebar-brand-lucide]]（lucide 已引入；FolderOpen 图标）
- 依赖 [[tasks/m6/06-token-modal.md|06-token-modal]]（modal 形态参考）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G11 / 决策 D7]]
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] DirectoryBrowser modal 化基线
- [[tasks/m5/07-mobile-drawer.md|tasks/m5/07]] 移动全屏 sheet 沿用
- [[prds/m5-uiux.md#修订注记2026-09-12-第二块收官|PRD M5 §修订注记]] M+ 挂账候选 (b) 兑现依据
