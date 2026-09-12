---
prd: prds/m5-uiux.md
status: done
---
# 任务：tokenStorage + TokenModal + hash 模型收缩（彻底删除 token 维度）

## 目标
按 [[prds/m5-uiux.md|M5 PRD §第二块 G6 + D9 / D10 / 方案 §2]] 落地 token 迁移：

1. **新建 `packages/web/src/ws/tokenStorage.ts`**：
   - 单一 export `remotepi.token` 常量（key 名硬编码，与 SSR 安全：不读 `window`）；
   - `read()` lazy 访问 `localStorage`（StrictMode 双跑安全——纯函数 + 不在模块顶层读）；
   - `write(token)` + `clear()`；
   - `try { ... } catch (e) { if (e instanceof SecurityError) return null; throw e }`——浏览器隐私模式 / 第三方 iframe 禁用 localStorage 时 swallow 为 `null`（不抛、不污染控制台）。
2. **新建 `packages/web/src/components/TokenModal.tsx`**：
   - **required 模式**（首次无 token 默认打开）——**不可关闭**：无 Esc 键关闭 / 无遮罩点击关闭 / 无 X 按钮；提交 = `tokenStorage.write(value)` + `window.location.reload()`（硬刷新触发 App 重新 `readAuth`，token===null 分支消失，App 走正常 recovery 流程）；
   - **closable 模式**（已有 token 从设置按钮打开）——三路关闭：Esc 键 + 遮罩点击 + X 按钮；提交 = `tokenStorage.write(value)` + 调 onSubmit 回调（App 透传 `client.connect(newToken)` 走既有 teardown+swap+openSocket 语义，自动重连）；
   - testid：`token-input`（沿用既有）/ `token-submit`（沿用既有）/ 新增 `token-modal`（容器）/ `token-modal-backdrop`（closable 模式遮罩）/ `token-modal-close`（closable 模式 X 按钮）；
   - autofocus input（required 模式开 modal 即聚焦输入框）。
3. **改造 `packages/web/src/hash.ts`**：
   - `AuthFromHash` 接口**删除 `token: string | null` 字段**（彻底删除，不做向后兼容/迁移收编——D9 用户明确裁定）；
   - `readAuthFromHash` 函数**删除 token 维度解析**（M3 token-only URL 形态已不存在——第二块后所有入口都通过 TokenModal 拿到 token）；
   - `encodeHash` 删除 token 参数（从 `AuthToHash` 接口移除）；
   - `decideView` 决策表改为 work_dir × session 二维（行：workDir=null+session=null → choiceLevel1 / workDir+session=null → choiceLevel2 / workDir+session → recovery；**tokenPrompt 分支由 App 层 token===null 触发**——hash.ts 不再判定 token）；
   - 导航 helpers（`exitSessionHash` / `changeWorkDirHash` / `newSessionHash` / `selectSessionHash` / `selectWorkDirHash`）签名**删除 token 参数**；
   - **退化形态 `session-without-workdir` 告警保留且与 token 无关**（W3 既有告警不变，只是不再提及 token 维度）。
4. **改造 `packages/web/src/App.tsx`**：
   - `readAuth()` = `{ token: tokenStorage.read(), workDir/session: readAuthFromHash(hash) }`（token 从 localStorage 读，workDir/session 从 hash 读）；
   - `decideView(auth)` 决策前**先**判定 `auth.token === null` → 渲染 `<TokenModal required>`；否则走 hash 决策表（work_dir / session 二维）；
   - closable 提交回调：`onSubmit(newToken) => tokenStorage.write(newToken); client.connect(newToken)`；
   - **雷区代码零字节 diff**：`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / `gateMapRef` 既有结构不动——本任务只动 `readAuth` 拼装 + 分支 JSX。
5. **改造 `packages/web/src/components/StatusBar.tsx`**：
   - **删除「此 URL 含访问令牌」文案**（token 不再在 URL hash，URL 不含 token——该警告失去意义）。
6. **`packages/web/src/ws/WsClient.ts` 零行为改动**：
   - 既有 `connect(token)` / `disconnect` / 重连退避路径不变；
   - **补 `connect(A) → connect(B)` 钉桩**：单元测试覆盖「handshake payload 用 B / 旧 socket close / 重连退避用最新 token」3 条边界（确保自动重连不丢更新）。

## 测试义务
- [ ] **`token-storage.test.ts` ≥10 条**：
  - `read()` / `write()` / `clear()` 三件套基础；
  - SecurityError 路径（mock `localStorage.getItem` throw `DOMException('SecurityError')`）→ swallow null；
  - 空串拒绝（write('') → 不写入 / read() 仍 null）；
  - StrictMode 双跑安全（同一组件 mount-unmount-mount 不重复 init）；
  - 单例（多次 import 同一 module instance）；
  - lazy 访问（不在模块顶层读 `localStorage`——import 时 mock spy 不被触发）；
  - SSR 安全（`localStorage` undefined 时不崩——read 返回 null / write 静默 no-op）；
  - key 名钉桩（`remotepi.token` 常量 export 后 grep 命中）。
- [ ] **`token-modal.test.ts` ≥8 条**：
  - required 模式：Esc 键 / 遮罩点击 / X 按钮 — 三者均**不**触发 onClose；
  - closable 模式：Esc / 遮罩 / X — 三者均触发 onClose；
  - required 提交 = onSubmit 回调（值传给回调，App 层负责 write+reload）；
  - closable 提交 = onSubmit 回调（值传给回调，App 层负责 write+connect）；
  - autofocus 钉桩（input 元素 mount 时获得焦点）；
  - 空值禁用（submit 按钮 disabled 当 input 为空）；
  - 不可见 testid 全命中（token-modal / token-modal-backdrop / token-modal-close / token-input / token-submit）。
- [ ] **`hash.test.ts` 等效改写**：
  - 删除所有 token 解析用例（旧用例 `#<token>` 形态解析不再有意义）；
  - 新增 hash 不含 token 钉桩（`encodeHash({ workDir: '/x', session: 'k' })` 输出 `'work_dir=%2Fx&session=k'`，无 token 前缀）；
  - `decideView` token 注入式输入（`{ token: 'anything', workDir, session }` —— **token 字段类型不再存在**，传 `{ workDir, session }` 即可）；
  - 退化形态 `session-without-workdir` 告警保留钉桩（W3 既有路径不变）。
- [ ] **`ws-client-choice-page.test.ts` 补 `connect(A) → connect(B)` ≥3 条**：
  - handshake payload 用 B（断言 outbound envelope 带 B 不带 A）；
  - 旧 socket close（断言 A 的 ws mock 收到 `close()` 调用）；
  - 重连退避用最新 token（mock clock 推进后 outbound token === B）。

## 完成标准
- [x] 全量单测（**基线 790 不回归 + 新增 ≥25**）/ 集成 32 零回归 / e2e 8 spec × 2 全绿
- [x] typecheck / lint / build 全绿
- [x] **雷区零字节 diff**：`App.tsx` 只动 `readAuth` 拼装 + 分支 JSX；`useRecoveryGateMap` / `handleRefill` / `RecoveryView` effect / `gateMapRef` 既有结构零改动（grep 实证）
- [x] testid 锚点核对（token-input / token-submit 沿用 + token-modal / token-modal-backdrop / token-modal-close 新增 + 既有 input-field / input-send / message-* 等全文件 0 增 0 删）
- [x] build 体积记录（与第一块基线 253.44 KB raw / 74.10 KB gzip 比较）
- [x] 旧书签 token 直接失效的 UI 提示文案（用户访问 `#<token>` 形态：App 读 hash 拿不到 token，token===null → TokenModal required 打开 + 顶部「旧书签 token 已失效，请粘贴新 token」提示）落地
- [x] commit 不 push（沿用 M2 / M3 / M4 交付约定）

## 依赖
- 无（与 04 并行无冲突——CSS 基础设施与 token 模型正交；04 之后或之前均可）
- 06 依赖本任务（AppShell 装配需 TokenModal 已就绪）

## 参考
- [[prds/m5-uiux.md|M5 PRD §第二块 G6 / 方案 §2 / D9 / D10]]
- [[architecture/protocol/README.md|隧道协议 v3]]（wire 协议零改动——token 仅 web ↔ bridge 在 WSS URL query 带，与 M3/M4 同）
- [[tasks/m4/07-web-choice-page.md|07-web-choice-page]] hash.ts 三字段解析基线 + decideView 决策表
- [[tasks/m4/08-web-multi-session-store.md|08-web-multi-session-store]] App.tsx readAuth 既有结构 + 雷区代码清单

## 完成情况（2026-09-12）

任务完成，1 笔代码 commit 在本任务验收后由用户 push（沿用 M2 / M3 / M4 交付约定）。

### Commit 链

- `efe265f` feat(web): M5 任务05 —— token 迁移 localStorage + TokenModal + hash 模型收缩（不做向后兼容）

### Review 轮次与裁决

本任务 1 轮 review 落地：0C / 2W / 3S。W1 隐私模式 write 失败静默 reload 死循环（reviewer 提出，移交任务 06 修复）；W2 closable 模式 setAuth 同步（已落）；S 全部落地。

### 关键数字（终验 2026-09-12，与 d290be6 终版一致）

- **单测**：基线 790 → **888**（+98；本任务新增 ≥25，全部归并到任务 06 / 07 终版基线 977 中，详见 [[tasks/m5/08-e2e-and-validation.md#完成情况2026-09-12|任务 08 完成情况]]）。
- **集成**：32/32 零回归。
- **e2e**：8 spec × 2 全绿（hash 模型 token 维度删除未引发回归——e2e spec 走 hash 注入 work_dir / session 不受影响）。
- **typecheck**：4 包绿。
- **lint**：0 error / 5 pre-existing warnings。
- **build**：4 包绿（web 首屏 entry 详见任务 08 完成情况）。

### 实施要点

- **`ws/tokenStorage.ts` 新建**：lazy/StrictMode/SecurityError swallow/key `remotepi.token`（hardcode 常量 export）。
- **`components/TokenModal.tsx` 新建**：required + closable 两模式，沿用 testid（`token-input` / `token-submit`）+ 新增（`token-modal` / `token-modal-backdrop` / `token-modal-close`）+ autofocus input + 空值禁用 submit。
- **`hash.ts` 改造**：`AuthFromHash` 删 `token` 字段 / `decideView` 二维 / 导航 helpers 删 token 参数 / W3 `session-without-workdir` 告警保留。
- **`App.tsx` 改造**：`readAuth` 拼装 token (localStorage) + workDir/session (hash) → 先判 token===null 弹 TokenModal required；雷区代码零字节 diff。
- **`StatusBar.tsx` 改造**：删除「此 URL 含访问令牌」文案（token 不在 URL，警告失去意义）。
- **`WsClient.ts` 零行为改动**：仅补 `connect(A) → connect(B)` 钉桩单测 ≥3 条（FakeWs `fireOpen` 增强），确保自动重连不丢更新。

### 关键架构决策与取舍

1. **彻底删除 token 维度（D9）**——用户明确裁定，无迁移 / 无 deprecated / 无软过渡提示；旧书签 `#<token>` 形态直接失效，UI 提示重新粘贴。**不写 `migrateLegacyHashToken`**、**不保留 deprecated 字段读取**。
2. **隐私模式 write 失败静默 reload 死循环（W1 遗留）**——`tokenStorage.write(value)` 在隐私模式 / 第三方 iframe SecurityError 时 swallow 为 null，`TokenModal` required 模式提交后 `window.location.reload()` 触发 App 重读 token 仍 null → 再次弹 TokenModal → 死循环。**reviewer 提出，移交任务 06 修复**（任务 06 完成 W1：write 返回 boolean + App 层捕获 storageError 内联提示）。**取舍记录**：本任务实施期未发现，reviewer 抓出。
3. **`stem-refilled.ts` 改动定性为纯机械适配**（reviewer 核实）——hash 模型 token 维度删除后，`stem-refilled` 中 token 透传相关代码同步清理；定性为机械适配，不构成新设计决策。

### 验证期补充

- **`seedToken` e2e helper 提前落地**（**编排者调整**）——按 PRD 08 任务原定计划 `seedToken(page, token)` 在任务 08 统一提供；编排者出于验证需要在本任务即提前落地（`tests/e2e/helpers/seedToken.ts`），供本任务验收 + 任务 06 review 修复轮 + 任务 08 全量 e2e 共用——单一真相源。
- **`connect(A) → connect(B)` 钉桩**（FakeWs `fireOpen` 增强）——WsClient `connect(A) → connect(B)` 路径不丢更新，新增 3 条钉桩单测：handshake payload 用 B / 旧 socket close / 重连退避用最新 token。
- **中断恢复说明**——前任 worker 在任务 05 中途 429 中断；续完 worker 核实补完：所有 PRD §非目标承诺（worker / bridge / shared / 协议零改动）+ D9 彻底删除 + D10 两模式全部落地，无遗漏。

### 雷区零 diff 实证

- `grep useRecoveryGateMap|handleRefill|gateMapRef|RecoveryView packages/web/src/` 仍仅命中既有 App.tsx；
- `packages/shared` / `packages/bridge` / `packages/worker` git diff 实证空；
- wire 协议零改动（v3 锁版承诺守住）。

### 交付约定

- **本地 commit 不 push**（沿用 M2 / M3 / M4）：本任务 1 笔代码 commit（`efe265f`）由用户手动 `git push origin main` 触发 Actions CD。
- **M5 第二块收官标记**：本任务 done + 任务 04 / 06 / 07 / 08 done → M5 第二块全部 5 个任务 done。
