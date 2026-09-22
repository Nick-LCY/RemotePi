# M6 — Web UI 全量视觉重做（reference 蓝本，任务索引）

> 详见 [[prds/m6-visual-rebuild.md|M6 PRD]]。本目录 11 个任务——**01-09 实施完成（2026-09-22，10 done），11 todo**（T01-T09 + polish 10 个 web commit 全部落地，领先 origin/main 15 commits；T10 全量验证轮已真跑单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build 与 M+ 候选；T10 文档收尾随本轮一起落档）。
>
> **范围说明**：纯 packages/web + docs 增量；协议 / worker / bridge / shared 零改动；testid 锚点零增零删（carve-out：`session-select` testid 删除，T04 Sidebar 视图重组后由 `session-row` onClick 承担，e2e 全集无引用）；不破既有功能 / 交互语义。

## 任务列表

- [[tasks/m6/01-token-retranslation.md|01 — styles.css token 翻译（13 → 20+，reference 蓝本 + WCAG AA 校色）]] ✅ done（2026-09-22 63eceb1；styles-token-resolution.test.ts 43 条）
- [[tasks/m6/02-css-full-migration.md|02 — ~1280 行 styles.css 全量迁 Tailwind utilities（按组件分批）+ `@source not` 精简]] ✅ done（2026-09-22 1226002 + 7700d6c review；legacy CSS 清零 + 语义标记类保留 + 断言 regex 化）
- [[tasks/m6/03-app-shell-rebuild.md|03 — AppShell 桌面态双 elevated 卡 + sidebar 300px + 移动端 backdrop 风格化]] ✅ done（2026-09-22 c52d9f0 + f1a4395 review）
- [[tasks/m6/04-sidebar-brand-lucide.md|04 — 引 lucide-react + Sidebar 重写（brand 双行块 + session row + BridgeStatusBar reference「远端连接」卡）]] ✅ done（2026-09-22 334941a；M5 M+ (d) 兑现）
- [[tasks/m6/05-chatview-bubbles-inputbar.md|05 — MessageList 气泡化 + InputBar reference 形态 + 单一焦点指示]] ✅ done（2026-09-22 5eae766 + f1a4395 polish）
- [[tasks/m6/06-token-modal.md|06 — TokenModal reference 形态（卡片 + backdrop + tinted icon block + input token 化）]] ✅ done（2026-09-22 6cc1941）
- [[tasks/m6/07-dialoghost-styling.md|07 — 4 类 DialogHost + toast 统一 reference modal（D7 分色表）+ footer 按钮形态]] ✅ done（2026-09-22 93cd6a9）
- [[tasks/m6/08-directory-browser-modal.md|08 — DirectoryBrowser modal 化 + 路径条 inline code + 桌面端新增 backdrop（z-250）]] ✅ done（2026-09-22 11c2ded；M5 M+ (b) 兑现）
- [[tasks/m6/09-statusbar-choice-recovery.md|09 — SessionStatusBar + ChoiceLevel1/2Panel + RecoveryView reference 形态（仅样式，D12 / 雷区）]] ✅ done（2026-09-22 916998a + f1a4395 polish）
- [[tasks/m6/10-e2e-validation-docs.md|10 — 全量验证（单测 / 集成 / e2e 9 spec × 2 / typecheck / lint / build / 体积记录）+ 文档收尾]] ✅ done（2026-09-22 T10）
- [[tasks/m6/11-dark-contrast-a11y.md|11 — 暗色对比度 WCAG AA 单测 + R3 临界点校色 + focus 可及性]] `todo`（依赖 10；暗色对比度边缘 3 处：amber pill 1.8:1 / accent CTA 2.9:1 / state-offline 2.1:1 白字场景）

## 依赖链

```
01 → 02 → (03, 04)
            ├─→ 05
            ├─→ 06 ──→ 08
            └─→ 07
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

## 预估基线 / 实测基线（M6 立项 2026-09-22 → T10 实施收官 2026-09-22）

> 预估仅供实施期对照。T10 落地后实测见下节。

## 实测基线（M6 任务 10 全量验证轮，2026-09-22）

> T10 落地后实测数字（任务 10 已 done）。**对照**预估基线——实测 **全栈在工作区实跑** 1091 tests / 47 files + 集成 32 + e2e 9 spec × 2 全绿 + 4 包绿 + lint 0 error / 5 pre-existing warnings。

- **单测（workspace 全量，pnpm test 根）** = **1091 tests / 47 files / 2.22s 全绿**：
  - web **566**（26 文件）+ bridge **378**（12 文件）+ shared **136**（8 文件）+ worker **11**（1 文件）= 1091；
  - vs M5 立项基线 977（web only）/ 1502（全仓）—— workspace 调整后实测单仓总 = **1091**（同一套 workspace 报告口径，与 M5 1502 报告口径差异：M5 把 web/bridge/shared/worker 各另计汇总；workspace 统一报告 1091 = 566+378+136+11）。
- **集成** = **32 tests / 7 files / 11.15s**（零回归；bridge wire 零改动）；
- **e2e** = **9 spec × 2 连跑全绿**，两轮各 **19.6s / 19.1s**，**无 flaky 无重跑**（spec 改动 ≤3 行：未发生，spec 09 / 04 className 字符串断言与新容器 class 默认对齐，零行修改）；
- **typecheck** = **4 包绿**（shared / web / bridge / worker）；
- **lint**（`pnpm exec eslint packages/web/src` 范围限定）= **0 error / 5 pre-existing warnings**（WsClient.ts no-console 915/963/970/987/1670 沿用）；
- **根 `pnpm lint`** = **86 problems（81 errors / 5 warnings）**——81 errors 全在 `reference/` 第三方 shadcn 风格源码（M5 立项前已存在污染，不计入本轮门），5 warnings 同 WsClient.ts no-console；
- **`pnpm -r build` 4 包绿** + web build 实测体积对比基线（D8 不设门槛，只记录）：
  - web **首屏 entry** **296.75 KB raw / 84.64 KB gzip**（vs M5 baseline 266.98 / 77.87 → **+29.77 KB / +6.77 KB**，主要来自 lucide-react tree-shaking 后 ~+6 KB gzip + 组件参考 reference 重做的形态代码增量）；
  - web **CSS** **34.80 KB / 7.35 KB gzip**（vs M5 baseline 32.67 / 6.92 → **+2.13 KB / +0.43 KB**）；
  - 懒加载 chunk：**markdown 170.57 KB / 52.47 KB**（不变）+ **AssistantMessageBody 5.14 KB / 1.74 KB**（vs M5 baseline 2.78 KB — 增加了 +2.36 KB，主要来自 T05 气泡布局 + lucide AI 头像 icon block 代码）；
- **testid 锚点零增零删**（grep `data-testid="..."` 实证：唯一差异 = `data-testid="session-select"` 删除，T04 Sidebar 视图重组后由 `session-row` onClick 承担切换，e2e 9 spec 全集无引用）；
- **协议 / worker / bridge / shared 零改动**（`git diff 7700d6c..HEAD --stat` 范围仅 `packages/web/**` + `pnpm-lock.yaml`，未触动 worker / shared / bridge 任何代码）；
- **M4 雷区零字节 diff**（grep `useRecoveryGateMap | handleRefill | gateMapRef | RecoveryView | stem-refilled watcher` 仍仅命中 `App.tsx` 与 `app-shell.test.tsx` / `tests/stem-refilled.test.ts`，未下移到 AppShell / Sidebar / 子组件）；
- **组件内硬编码 hex** = **0 处**（`grep -rn '#[0-9a-fA-F]\{6\}' packages/web/src/components packages/web/src/App.tsx` 仅命中 1 处注释提及 previous 值；全部 hex 在 `styles.css` `:root` / `@media dark` 块 token 化）。

## 交付约定（沿用 M2 / M3 / M4 / M5）

所有任务（01-11）只在本地 commit，不 push。10 落地后用户本地验证 → 用户手动 `git push origin main` 触发 Actions CD → 服务器端 bridge 择机重启加载（与 push 同批动作即可合并触发）。

## 决策记录（D1-D12 全部定稿，2026-09-22 用户裁定）

详见 [[prds/m6-visual-rebuild.md#决策记录d1-d12-全部定稿2026-09-22-用户裁定|M6 PRD §决策记录]]。D1-D12 全部已定稿——不再保留「待裁定」字样。
