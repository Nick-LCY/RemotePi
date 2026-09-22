---
prd: prds/m6-visual-rebuild.md
status: todo
---
# 任务：TokenModal reference 形态（卡片 + backdrop + tinted icon block + input token 化）

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G9 + D7]] 落地 TokenModal reference 形态：

1. **卡片容器**：
   - `rounded-2xl p-7 shadow-2xl max-w-[420px] bg-[#ffffff]`（token 化 `bg-[var(--surface)]`）；
   - 居中定位 + 圆角 + 阴影；
   - 整体宽度不超过 420px（移动端 sheet 沿用 M5 任务 07 全屏化）。
2. **backdrop**：
   - `bg-[#17202b]/45 backdrop-blur-[3px]`（与 M6 任务 03 / 08 一致性）；
   - z-index 400 沿用。
3. **头部 size-11 rounded-xl tinted icon block**（D7）：
   - 蓝 tinted 块：`bg-[#eef4ff] text-[#245bc4]`（token 化 `bg-[var(--accent-soft)] text-[var(--accent)]`）；
   - lucide `<Hash size={20} />`；
   - 11x11 (44px) 圆角块。
4. **input**：
   - `h-11 rounded-xl bg-[#fafbfc]`（token 化 `bg-[var(--surface-2)]`）；
   - `focus:border-[#7da1df]` + `focus:ring-4`（token 化 `border-[var(--accent)]` + `ring-[var(--accent-ring)]`）；
   - placeholder 沿用既有文案。
5. **提交钮蓝填充**：
   - `bg-[#245bc4] text-white rounded-xl` + hover `bg-[#194da9]`（token 化）；
   - 宽度 100%（`w-full`）。
6. **底部隐私说明文案**：
   - 11px 灰副文（`text-[11px] text-[var(--muted)]`）；
   - 文案沿用 M5 任务 05 既有「token 仅存浏览器本地，不上传服务器」说明（如有，沿用；如无，新增）。
7. **两模式逻辑 / testid / z-400 零改动**（M5 D10 沿用）：
   - required 模式：不可关闭（无 Esc / 遮罩 / X）；
   - closable 模式：三路关闭（Esc / 遮罩 / X）；
   - testid：`token-modal` / `token-modal-backdrop` / `token-modal-close` / `token-input` / `token-submit` 沿用；
   - z-index 400 沿用。
8. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，06 仅确认无遗留）。

## 测试义务

- [ ] **`token-modal.test.ts` 既有 19 例 0 回归**：
   - required 模式：Esc / 遮罩 / X 三者均**不**触发 onClose；
   - closable 模式：Esc / 遮罩 / X 三者均触发 onClose；
   - required 提交 = onSubmit 回调（值传给回调，App 层负责 write+reload）；
   - closable 提交 = onSubmit 回调（值传给回调，App 层负责 write+connect）；
   - autofocus 钉桩（input 元素 mount 时获得焦点）；
   - 空值禁用（submit 按钮 disabled 当 input 为空）；
   - 不可见 testid 全命中（token-modal / token-modal-backdrop / token-modal-close / token-input / token-submit）。
- [ ] **`token-modal.test.ts` 4 处 regex 核对**（任务 02 前置落地，本任务确认）：
   - `backdrop-blur-sm` → `backdrop-blur-[3px]` regex 更新；
   - 卡片容器 `rounded-2xl p-7 shadow-2xl max-w-[420px]` regex 形态；
   - input 容器 `h-11 rounded-xl` regex 形态；
   - tinted icon block `bg-[var(--accent-soft)] text-[var(--accent)]` regex 形态。

## 完成标准

- [ ] `packages/web/src/components/TokenModal.tsx` 容器 / backdrop / 头部 / input / 提交钮 / 隐私文案 reference 形态
- [ ] 两模式逻辑零改动（required 不可关 / closable 三路关）
- [ ] testid 锚点零增零删（token-modal / token-modal-backdrop / token-modal-close / token-input / token-submit 沿用）
- [ ] z-index 400 沿用
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证；e2e 08 token 来源换路 + spec 09 移动端 TokenModal 全屏 sheet 兼容）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]（backdrop 一致性）
- 依赖 [[tasks/m6/04-sidebar-brand-lucide.md|04-sidebar-brand-lucide]]（lucide 已引入；Hash 图标）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G9 / 决策 D7]]
- [[tasks/m5/05-token-storage.md|tasks/m5/05]] TokenModal 两模式基线 + testid / z-index 沿用
- [[tasks/m5/06-app-shell-sidebar.md|tasks/m5/06]] AppShell 装配基线
- [[tasks/m5/07-mobile-drawer.md|tasks/m5/07]] 移动端 modal 全屏 sheet 沿用
