---
prd: prds/m6-visual-rebuild.md
status: todo
---
# 任务：MessageList 气泡化 + InputBar reference 形态 + 单一焦点指示

## 目标

按 [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 + G7 / G8 + D6 / D11 / R2 / R4]] 落地 MessageList 气泡化 + InputBar reference 形态 + 单一焦点指示：

1. **MessageList 完整仿 reference 气泡布局**（D11）：
   - **AI 行**：`flex items-start gap-3` + size-8 深石板头像方块（`bg-[#17202b] rounded-lg flex items-center justify-center`，lucide `<Zap size={16} className="text-white" />`）+ 名字行（「RemotePi」11px 灰）+ 气泡 `rounded-2xl rounded-tl-sm bg-[#f5f7f9] px-4 py-3 text-sm leading-6 text-[#4d5966]` + 时间戳 `text-[10px] text-[#a2aab3]`；
   - **用户行**：`flex justify-end` + max-w-[80%] + 气泡 `rounded-2xl rounded-tr-sm bg-[#245bc4] text-white`；
   - **token 化**：bg / muted / accent / surface-2 / 时间戳色全部 token 化（`bg-[var(--surface-2)]` 等，落地时统一）；
   - **lucide 图标**：AI 头像 `Zap` size 16（白）；用户头像（可选装饰）+ abort 按钮 `<StopCircle size={16} />`。
2. **保留 `message-row` 容器 class + `message-role-{user|assistant}` 角色 class + 全部 testid 零增零删**（D6）：
   - `message-row` / `message-role-user` / `message-role-assistant` / `message-body` / `message-draft` 沿用；
   - 气泡化只在容器内部做（不改容器 className 语义）；
   - 视觉装饰容器 `message-avatar` / `message-timestamp` 新增 testid 不计入本契约。
3. **`.message-body` 仍是 textContent 父容器**——e2e 01 §6 流式连续性 + 02 角色断言 + 08 流式打字机兼容；实施后必须真跑 e2e 01 / 02 / 08 验证。
4. **内嵌 code 白底蓝字 `text-[#245bc4]`**（token 化 `text-[var(--accent)]`）：
   - `.markdown-code` 内嵌 code 块 / 行内 code 视觉重做；
   - 与外层卡片底 `bg-[#f5f7f9]` 对比足够。
5. **InputBar 重做**：
   - 外壳 `rounded-2xl border bg-[#fafbfc]`（token 化 `bg-[var(--surface)]`）+ 常驻 shadow `0 4px 18px rgba(23,32,43,0.06)`（token 化 `shadow-[var(--shadow-card)]`）；
   - focus-within:border-accent + focus-within:ring-4（`ring-[var(--accent-ring)]`）；
   - 移除旧 2px outline 双焦点指示（R4：统一单一焦点指示，键盘 focus-visible 语义保留——`:focus-visible` 与 `:focus-within` 区分）。
6. **发送钮 size-8 rounded-xl 深石板**（lucide `<Send size={16} className="text-white" />`，`bg-[#17202b]`）；
7. **abort 红色形态**：lucide `<Square size={14} />` 或 `<StopCircle size={16} />` + `bg-[var(--state-offline)]` 圆角按钮；
8. **底部 helper 文案**：11px 灰副文（`text-[11px] text-[var(--muted)]`），按 M4 既有行为显示（如 `commandError` 5s / `settledHint` 等）。
9. **testid 全保**：
   - `input-field` / `input-send` / `input-abort` / `message-row` / `message-draft` / `message-body` / `message-role-{user|assistant}` / `message-list` 沿用；
   - `data-*` 属性也全保。
10. **`styles.css` 触碰处顺手迁**（任务 02 已全量迁，05 仅确认无遗留）。

## 测试义务

- [ ] **`assistant-message-body.test.tsx` 既有 28+ 用例 className 断言 regex 化**（任务 02 已落地 regex 化基础，本任务确认无新增冲突）：
   - AI 行 / 用户行 className 形态断言（`/flex items-start gap-3/` 等）；
   - 时间戳 className 断言（`/text-\[10px\] text-\[#a2aab3\]/` 等）；
   - 头像 lucide 图标渲染断言（`Zap` 节点）。
- [ ] **`input-bar-keydown.test.ts` 既有 9 例 0 回归**（Enter send / Shift+Enter newline / IME isComposing 守卫 / Safari 229 防御）
- [ ] **`use-auto-resize-textarea.test.ts` 既有 7 例 0 回归**（空内容单行 / 1 行 / 多行未超 max / 多行超 max 触发滚动 / 清空回单行 / 动态重算）
- [ ] **`assistant-message-body.test.tsx` 新增 ≥2 条**（气泡布局 + AI 头像）：
   - AI 行渲染头像方块 + Zap 图标 + 名字行 + 气泡 rounded-tl-sm + 时间戳；
   - 用户行渲染 max-w-[80%] + 气泡 rounded-tr-sm + 蓝底白字。
- [ ] **`input-bar.test.tsx` 新增 ≥2 条**（单一焦点指示）：
   - focus-within 状态下 input 容器含 ring-4 className（不重复出现 outline + ring 双指示）；
   - 键盘 Tab focus input-field 时 input 元素有 focus-visible 样式（保留键盘语义）。
- [ ] **e2e 01 / 02 / 08 真跑**（任务 10 终验）：
   - 01 spec §6 draft textContent 单调性（气泡化后 `<details>` 内文本仍计入 `textContent`）；
   - 02 spec History verification 角色断言（`message-role-user` / `message-role-assistant`）；
   - 08 spec 流式打字机 + tool 归并 pill（既有路径兼容）。

## 完成标准

- [ ] MessageList 完整仿 reference 气泡布局（D11）
- [ ] `message-row` / `message-role-*` / `message-body` / `message-draft` 全部沿用（D6 / R2）
- [ ] `.message-body` 仍是 textContent 父容器（e2e 01 / 02 / 08 兼容）
- [ ] 内嵌 code 白底蓝字 token 化
- [ ] InputBar reference 形态（外壳 rounded-2xl shadow + focus-within 单一指示）
- [ ] 发送钮 size-8 rounded-xl 深石板 + abort 红色形态
- [ ] 移除旧 2px outline 双焦点指示（R4 统一单一焦点指示）
- [ ] testid 锚点零增零删
- [ ] 既有 web **977 不回归**
- [ ] e2e **9 spec × 2 连跑全绿**（任务 10 真跑验证——e2e 01 / 02 / 08 重点回归）
- [ ] typecheck / lint / `pnpm --filter @remotepi/web build` 全绿
- [ ] commit 不 push（沿用 M2 / M3 / M4 / M5 交付约定）

## 依赖

- 依赖 [[tasks/m6/01-token-retranslation.md|01-token-retranslation]]
- 依赖 [[tasks/m6/02-css-full-migration.md|02-css-full-migration]]
- 依赖 [[tasks/m6/03-app-shell-rebuild.md|03-app-shell-rebuild]]
- 依赖 [[tasks/m6/04-sidebar-brand-lucide.md|04-sidebar-brand-lucide]]（lucide 已引入）

## 参考

- [[prds/m6-visual-rebuild.md|M6 PRD §2 组件映射 / G7 / G8 / 决策 D6 / D11 / 风险 R2 / R4]]
- [[tasks/m5/01-web-markdown-render.md|tasks/m5/01]] AssistantMessageBody / 流式分段 / message-row 锚点基线
- [[tasks/m5/02-web-input-textarea.md|tasks/m5/02]] InputBar textarea / useAutoResizeTextarea 基线
- [[tasks/m4/10-e2e-and-validation.md|tasks/m4/10]] e2e 01 spec §6 流式连续性 + 02 spec History verification 基线
