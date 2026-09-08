---
prd: prds/m3-single-session.md
status: done
---
# 任务：`tests/e2e/` 骨架 + 四进程装配 + 场景 (a)（ADR-0009 §决策 1/2/5/6/7 + §开放点 3 落地）

## 目标

把 [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 1/2/5/6/7 已挂账的"四进程全栈链路 E2E 套件"从设计落成本机可跑的回归资产——`tests/e2e/` 顶层（独立 Playwright runner + 独立 tsconfig）+ wrangler dev + bridge 子进程 + 真 pi + 进程内假 LLM server + 假 LLM fixture 全栈装配 + globalSetup/teardown + MVP 三场景中的**场景 (a) 首次对话流式渲染**。本任务不解决任何产品行为问题（5s 超时挂账 / bridge 僵尸 / 同 token 重连语义等一律按现状断言），与 [[tasks/m3/10-integration-test-infra.md|10]] 同口径（独立 runner / 本机专用 / CI 跳过 / `packages/*` 零改动）。

## 依赖

- 依赖 [[tasks/m3/11-web-testid-hooks.md|11]]（断言 testid 是消费对象；11 未完成时场景 (a) 断言只能走 className / 文案，脆）
- 间接依赖 [[tasks/m3/10-integration-test-infra.md|10]]（helper 复用源——`fake-llm-server` / `make-fixture` / `make-manager` 都是任务 10 落地的 seam）

## 任务内容

### 硬约束（写在最前）

- **唯一新增代码面**：`tests/e2e/` 顶层新建 + 根 `package.json` 加脚本 + `.gitignore` 补 Playwright 产物；**零改动**于 `packages/*` / `worker/` / `.github/` / 根 `tsconfig`（与 [[tasks/m3/10-integration-test-infra.md|10]] §完成情况「零改动」同口径）。
- **不触任何既有挂账**——5s 恢复超时 / bridge 僵尸 / 同 token 重连语义 / 多 web 端"先答者胜"产品行为一律**不在本任务范围**；测试按现状断言（场景 (a) retry 容错断言写法见下）。
- **CI 四步 workflow 零改动**——与 ADR-0008 §决策 3 + ADR-0009 §决策 6 同口径（runner 无 pi / 无浏览器二进制）。
- **场景范围严格 ≤ (a)**——场景 (b) F5 恢复 + (c) 多端弹窗先答者胜放在任务 13。

### 顶层骨架（ADR-0009 §决策 1 + §开放点 3 "待实施时敲定"逐项落定）

- `tests/e2e/playwright.config.ts` —— 独立 runner 配置
  - **敲定点 1**（§开放点 3）：`.ts` 是否撞 ESLint `projectService.allowDefaultProject`——实施时用最小 `pnpm lint` 验证；若撞，**优先**把 `tests/e2e/**` 加进 ESLint `projectService` 配置（理由：与 ADR-0008 §3 `.js` 退路比，多一处 source-of-truth 更利于长期维护），**退路**改 `.js`（与 ADR-0008 路径对齐）。无论哪种，本任务**完成情况段必须记录验证结论**。
  - `testDir: './'`（Playwright 默认拾取 `*.spec.ts` / `*.test.ts`）
  - `timeout: 60_000`（单场景，§开放点 3 起点建议）
  - `retries: 1`（本机专用，§开放点 3 起点建议）
  - `use.baseURL: 'http://localhost:8787'`（wrangler dev 端口见 §就绪链）
  - `use.trace: 'retain-on-failure'` + `use.screenshot: 'only-on-failure'` + `use.video: 'retain-on-failure'`（flakiness 调查锚点；产物由 `.gitignore` 屏蔽，见下）
  - `reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]`（CI 不开但本机可查）
  - `globalSetup` / `globalTeardown` 指向 `tests/e2e/helpers/{global-setup,global-teardown}.ts`
- `tests/e2e/tsconfig.json` —— 独立 typecheck 入口
  - 仿 [[tasks/m3/10-integration-test-infra.md|10]] `tests/integration/tsconfig.json` 模式：`baseUrl: ../..` + `paths` 把 `@remotepi/{shared,bridge}` 映射到 `packages/*/src`（与 ADR-0008 §3 双通道一致——`tests/e2e/node_modules` 同样无 workspace symlink，必须 `resolve.alias` + tsconfig `paths` 双管齐下；Playwright config 自身可用 `ts-node` / `tsx` 加载 .ts；实际敲定记录于完成情况段）。
- `tests/e2e/helpers/` —— 5 个新文件（命名待敲定，本任务给意图清单）
  - `global-setup.ts`：双构建前置（见 §就绪链第 1 段）+ `.wrangler/` 清理 + `assertPiAvailable` 预检（沿用 ADR-0008 §2.7 形态）+ token 生成（带 run-tag 见 §就绪链第 4 段）+ 临时目录 `.tmp/<run-tag>/` 创建
  - `global-teardown.ts`：按序 kill bridge（含 pi 子进程，bridge `stop()` 内建 SIGTERM→1s→SIGKILL 兜底）→ wrangler dev → 假 LLM server `close()` → fixture `cleanup()` → 临时目录保留策略决定（默认保留供 trace 回溯）
  - `bridge-process.ts`：bridge 子进程 spawn + stdout/stderr 监听 + `stop()` 包装
  - `wrangler-process.ts`：wrangler dev 子进程 spawn + 端口占用预检（见 §就绪链）+ stdout/stderr 监听 + `stop()` 包装
  - `env-builder.ts`：`buildHermeticEnv({agentDir, baseEnv})`——首选**抽取**至 `tests/integration/helpers/build-hermetic-env.ts` 与 [[tasks/m3/10-integration-test-infra.md|10]] `make-manager.ts` 共用单一真源（**硬约束**：抽取后 30 条集成测试**必须仍全绿**，否则退路：在 `tests/e2e/helpers/env-builder.ts` 复制 + 头部 JSDoc 注释指回 ADR-0008 §2.6 密闭性三层防线 + [[tasks/m3/10-integration-test-infra.md|10]] 对应实现）；不论抽取还是复制，`PROVIDER_KEY_ENV_VARS` 清单以 [[tasks/m3/10-integration-test-infra.md|10]] 现有清单为真源（review 扩过一次 4→11），漂移即 bug
- `tests/e2e/specs/` —— 场景测试文件
  - `01-first-turn.spec.ts`（场景 a）—— 见下 §场景 (a)
  - `02-reload-recovery.spec.ts`（场景 b，**本任务写空 stub / `test.skip()`**）—— 任务 13 实施
  - `03-multi-tab-first-responder.spec.ts`（场景 c，**本任务写空 stub / `test.skip()`**）—— 任务 13 实施
  - **理由**：Playwright 不允许跨 spec 共享 globalSetup/teardown 的中间产物；任务 13 在本任务骨架上**增量**写 spec 即可，避免后期改动装配代码
- 根 `package.json`：
  - `"test:e2e": "playwright test --config tests/e2e/playwright.config.ts"`
  - `"typecheck:e2e": "tsc -p tests/e2e/tsconfig.json"`（可选，§决策 1 列入）
- `.gitignore` 补（**敲定点 2**——§开放点 3 `.gitignore` 具体条目）：
  - `tests/e2e/.tmp/`（fixture / run-tag 隔离产物）
  - `test-results/`（Playwright 默认 trace 落点）
  - `playwright-report/`（HTML reporter 落点）
  - `worker/.wrangler/`（每次 run 前清理，由 globalSetup 保证，gitignore 是双保险）
  - `tests/e2e/blob-report/`（备——若 reporter 改了形态）

### 四进程装配（ADR-0009 §决策 2 + §开放点 3 落地）

- **wrangler dev** —— 用 `worker/wrangler.toml` 现成配置；启动命令 `npx wrangler dev --port 8787 --persist-to worker/.wrangler`（`--persist-to` 与 globalSetup 的 `rm -rf worker/.wrangler` 配对）；stdout 监听 `/healthz` 200 出现即就绪。
- **bridge** —— `node packages/bridge/dist/index.js --config <tmp>.json`（**禁用 tsx watch**——`[[current-state.md#TODO-/-阻塞]]` bridge 僵尸挂账）；config 四字段（zod strict，[[tasks/m3/03-bridge-config-file.md|03]] 落地）：
  - `worker_url: ws://localhost:8787/bridge`（**强制**含 `/bridge` 路径——漏路径是 §决策 2 最易踩配置错）
  - `web_base_url: http://placeholder.invalid`（仅用于打印 `shareUrl`，占位即可）
  - `work_dir: <makeAgentDir().workDir>`
  - `token: e2e-fixed-token-<runTag>`（见 §就绪链第 4 段）
- **真 pi** —— 由 bridge spawn（`PiProcessManager` 既有 seam 直接消费——[[tasks/m3/04-bridge-pi-process.md|04]] 落地）；env 经 `buildHermeticEnv({agentDir, baseEnv})` 注入 `PI_CODING_AGENT_DIR=<fixture>` + `PI_OFFLINE=1` + 剥离 11 个 provider key。
- **进程内假 LLM server** —— 复用 [[tasks/m3/10-integration-test-infra.md|10]] `tests/integration/helpers/fake-llm-server.ts` 的 `startFakeLlmServer`（port 0 → 回填 fixture `models.json.baseUrl`）；相对导入 `../integration/helpers/fake-llm-server.js`（同在 `tests/` 下）。

### 全套就绪链（ADR-0009 §决策 7 钉死的 flakiness 防线，**七条全部落地**）

1. **双构建前置**（§7.1 + §开放点 3 build 时机敲定）：
   - **敲定点 3**（§开放点 3 build 塞脚本还是 globalSetup）—— **首选**塞进 Playwright `globalSetup`：web build 命令 `pnpm --filter @remotepi/web build`（自带 `vite build`，需传 `VITE_WSS_URL=ws://localhost:8787/web`——`packages/web/src/ws/config.ts:12` 解析顺序是"VITE_WSS_URL 非空胜出"，生产 build 不设会连到 `PROD_DEFAULT_WSS_URL` 线上域名）+ bridge build 命令 `pnpm --filter @remotepi/bridge build`；缺 `dist/` 明确报错（`fs.existsSync` 预检 + 指引到 build 命令），**不**白屏等死。
   - **退路**：`test:e2e` 脚本里 `&&` 串两 build（`pnpm -r build && playwright test --config tests/e2e/playwright.config.ts`）——简单但失去"其他命令单独跑 E2E"灵活性。
   - **敲定结论记录于完成情况段**。
2. **`.wrangler/` 每次 run 前清理**（§7.2）—— globalSetup `rm -rf worker/.wrangler`；不清会导致上轮消息残留被 `get_messages` 拉回、场景 (a) 空态断言失效；首次启动 SQLite migration 约 1-2s 就绪等待要含进 §7.5 就绪链。
3. **端口固定 8787，占用即 fail fast**（§7.3）—— globalSetup 启动前 `net.Socket` 探 8787，被占立刻报错说清原因（"8787 被占，请先 `pnpm dev` 退出"），不静默换端口；理由：`VITE_WSS_URL` 在 build 期烘进 bundle，动态端口意味着每次 run 重新 build web。
4. **token 固定带 run-tag**（§7.4）—— `crypto.randomBytes(4).toString('hex')` 跑一次生成 runTag，token 形如 `e2e-fixed-token-<runTag>`；理由：`bridge.config.token` 非空时逐字使用且不回写（`packages/bridge/src/config.ts:219-226` 实证），即便 `.wrangler` 清理漏了也不撞旧房间。
5. **三段就绪链**（§7.5 + §开放点 3 探针敲定）：
   - **敲定点 4**（§开放点 3 bridge 就绪探针取 stdout 还是 StatusBar）—— **首选**第二段探针走 bridge stdout 连接日志（已出现 `connected to worker` 或等价字串即就绪，监听实现简单）；**备选**浏览器 `StatusBar[data-state=reachable]`——更稳但需等 playwright 启动 + ChatView 渲染，与第三段重叠。本任务**首选 stdout**（少一个 race surface），敲定结论记录。
   - 三段串行：
     - **第一段**：`GET http://localhost:8787/healthz` 返回 200（含版本文本，wrangler dev 现成就绪探针——worker `GET /healthz` handler）；
     - **第二段**：bridge stdout 出现连接日志（见敲定点 4）；
     - **第三段**：浏览器 `page.goto('/#<token>')` + 等 `data-testid="chat-view"` 出现（恢复仪式成功，可交互）。
   - **不靠 sleep**——每段 `expect.poll` / `await fetch` / `await waitForOutput` 至 30s。
6. **进程清理必须兜底**（§7.6）—— globalTeardown 按 `bridge.stop() → wrangler.stop() → fakeLlm.close() → fixture.cleanup()` 顺序；任何一条漏掉都会堆积僵尸 / 占住 8787；用 `try/finally` 链 + 各自 SIGKILL 兜底（`process.kill(-pid, 'SIGKILL')` 杀进程组）。
7. **`.gitignore` 补 Playwright 产物**（§7.7）—— 见上文敲定点 2 清单。

### 断言语义约定（ADR-0009 §决策 7 末两条，本任务内化进 spec helper）

- **弹窗自动关闭走 React key 卸载**——断言看 DOM 消失（`toBeHidden()` / `toHaveCount(0)`），不等倒计时数字。
- **同 token 重连不重发仪式**——`autoStartConsumedRef` 按 token 守门（`packages/web/src/App.tsx` JSDoc 实证）。场景 (e) 若实现按错假设断言会假红；本任务三场景不涉及此条但 spec helper 注释里钉一句。

### 场景 (a) 首次对话流式渲染

- **步骤链**：
  1. `page.goto('http://localhost:8787/#<token>')` —— 触发恢复仪式
  2. 断言 `data-testid="recovery-in-flight"` 出现（过渡态）
  3. 断言 `data-testid="chat-view"` 出现（仪式成功；**retry 容错断言见下**）
  4. 在 `data-testid="input-field"` 输入固定文本 `"hello-from-e2e"`
  5. 点击 `data-testid="input-send"`
  6. 断言用户消息行 `data-testid="message-row"` 出现 + 文本含 `"hello-from-e2e"`
  7. 假 LLM server 按多个 `content_block_delta` 吐字（`textReply("hello back from fake LLM")`），断言 `data-testid="message-draft"` 出现 + 用 `expect.poll` 观察 draft 文本逐步增长（`text` 长度单调增 → 终态 `"hello back from fake LLM"`）
  8. `agent_settled` 后断言 `data-testid="message-draft"` 消失（被终态消息替换）+ 输入框 `input-field` 重新可用（`input-send` 可点击 + `input-abort` 消失）
- **retry 容错断言**（应对 5s 恢复超时挂账未修——ADR-0009 §开放点 1 短期路径）：
  - `await expect.poll(() => page.locator('[data-testid="chat-view"]').or(page.locator('[data-testid="recovery-error"]')).first().isVisible(), { timeout: 30_000 })` —— 等 ChatView 或 RecoveryErrorCard 二者之一先出现
  - 若先见 `recovery-error` → 点 `recovery-retry` 一次 → 重新等 ChatView（一次性 retry；二次 retry 不兜底，避免挂账升级）
  - 拿到 ChatView 后进入正常断言链
  - **理由**（与 ADR-0009 §开放点 1 短期路径一致）：`RECOVERY_TIMEOUT_MS = 5_000`（`packages/web/src/ws/recovery.ts:48`）对 pi 冷启动不足，5s 超时挂账未修前 E2E 大概率首启踩；retry 容错断言是 **E2E 已知行为**而非产品修复——根因挂账仍在 [[current-state.md#TODO-/-阻塞]] 2026-09-07 条目
  - **取消条件**（实施期再次确认）：若挂账已决议修复（[[current-state.md#TODO-/-阻塞]] 2026-09-07 条目被勾掉），retry 容错可简化为纯等 ChatView；本任务**完成情况段**须记录当时挂账态
- **断言不依赖文案**——所有断言锚点都是 testid（任务 11 提供）；文案 / className 变化不连带红。

## 验收标准

- [ ] `tests/e2e/` 顶层骨架完整（`playwright.config.ts` + `tsconfig.json` + `helpers/{global-setup,global-teardown,bridge-process,wrangler-process,env-builder}.ts` + `specs/{01-first-turn,02-reload-recovery,03-multi-tab-first-responder}.spec.ts`；后两 stub 文件含 `test.skip()` + JSDoc 指回任务 13）
- [ ] **敲定点 1-4 全部落定**（`.ts` 撞 ESLint projectService 验证 + `.gitignore` 条目 + build 塞脚本还是 globalSetup + bridge 就绪探针首选 stdout）—— 结论记录于完成情况段
- [ ] **抽取 `buildHermeticEnv` 共用首选落地**（30 条集成测试仍全绿）；若退路复制则在 `env-builder.ts` 头部 JSDoc 注释指回 ADR-0008 §2.6 + [[tasks/m3/10-integration-test-infra.md|10]] 真源
- [ ] **§决策 7 七条纪律全部落地**（双构建前置 + `.wrangler/` 清理 + 端口 8787 fail fast + token run-tag + 三段就绪链 + 进程清理兜底 + `.gitignore` 补全）
- [ ] 场景 (a) 全流程 spec 完整（§场景 (a) 步骤链 8 步 + retry 容错断言）—— `pnpm test:e2e tests/e2e/specs/01-first-turn.spec.ts` 全绿（本机）
- [ ] **回归基线零变化**：30 条 `pnpm test:integration` 仍全绿 ≈11s（抽 env 函数共用后必须重跑验证）+ 基线 281 单测不变 + 4 包 typecheck + `typecheck:integration` + `typecheck:e2e` + lint + build 全绿
- [ ] **CI 四步零改动**——`.github/workflows/` `git diff` 零结果
- [ ] **`packages/*` / `worker/` / 根 `tsconfig` 零改动**（除 `package.json` 加 2 脚本 + `.gitignore` 加 4-5 行）——与 [[tasks/m3/10-integration-test-infra.md|10]] §完成情况「零改动」同口径
- [ ] 端口 8787 被占时 `pnpm test:e2e` 立即 fail 并说清原因（手动跑一次验证）
- [ ] 完成情况段回填：实际敲定结论（4 个敲定点）+ commit hash + review 结论 + 场景 (a) 实测耗时 + retry 容错断言是否触发（被触发即 5s 超时挂账仍未修的硬证据）

## 参考

- [[architecture/decisions/0009-headless-browser-e2e.md|ADR-0009]] §决策 1（栈与位置）/ §决策 2（全真进程组装）/ §决策 5（复用策略——含 `buildHermeticEnv` 抽取首选/退路）/ §决策 6（CI / 本机口径）/ §决策 7（七条就绪与清理纪律 + 断言语义约定）；§开放点 3（决策条文里"待实施时敲定"项汇总——本任务逐项落定）。
- [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] §2.6 密闭性三层防线（`PROVIDER_KEY_ENV_VARS` 11 项真源）/ §2.7 CI 门控（与本任务同口径）/ §关键 wire 发现（LLM 失败走事件流等——场景 (a) 假 LLM server 脚本据此设计）。
- [[tasks/m3/10-integration-test-infra.md|10]] —— helper 复用源 + 「零改动」基线锚点（直接对照 §完成情况段）；本任务的 `env-builder.ts` 与之共用 `buildHermeticEnv`。
- [[tasks/m3/11-web-testid-hooks.md|11]] —— 断言锚点消费对象（testid 命名清单在任务 11「任务内容」段）。
- [[tasks/m3/04-bridge-pi-process.md|04]] / [[tasks/m3/05-bridge-popup-core.md|05]] —— bridge spawn seam 与 `ExtensionUIRouter` 端到端验证对象（场景 (a) 跑通即隐含验证）。
- 关键源码锚点：
  - `worker/wrangler.toml`（`[assets]` / `run_worker_first` / `not_found_handling`）+ `worker/` `GET /healthz` handler
  - `packages/web/src/ws/config.ts:12,29`（`VITE_WSS_URL` 解析顺序 + `DEV_DEFAULT_WSS_URL`）
  - `packages/web/src/ws/recovery.ts:48`（`RECOVERY_TIMEOUT_MS = 5_000`——retry 容错断言的触发条件依据）
  - `packages/web/src/App.tsx`（`autoStartConsumedRef` 守门 / 三态渲染——**断言语义约定**实证）
  - `packages/bridge/src/config.ts:219-226`（token 非空即逐字使用不回写）
  - `tests/integration/helpers/{fake-llm-server,make-fixture,make-manager}.ts`（直接相对导入复用）
  - `tests/integration/helpers/build-hermetic-env.ts`（**抽取首选**目标位置；如未抽取则见 §10 现有清单）

## 完成情况

### 敲定点结论（实施期沉淀）

- **敲定点 1**（Playwright config `.ts` 是否撞 ESLint `projectService`）—— **首选 `.ts` 落地**。`.ts` 文件被 ESLint flat config 正确处理（`recommendedTypeChecked` ruleset + `projectService.allowDefaultProject: ['*.js', '*.mjs', '*.cjs']` + 根 tsconfig include 覆盖 `tests/e2e/**`），0 errors / 5 pre-existing warnings（`packages/web/src/ws/WsClient.ts` 的 5 条 `no-console`，与本任务无关）。退路 `.js` 未走——`.ts` 工作良好。
- **敲定点 2**（`.gitignore` 具体条目）—— 3 条全部落地：`tests/e2e/.tmp/` + `tests/e2e/test-results/` + `tests/e2e/playwright-report/`（前者为本任务 fixture 隔离路径，后两者是 Playwright config 实际产出的位置——根级 `test-results/` / `playwright-report/` 是误位置，已删除）。`tests/e2e/blob-report/` v1 不产出，删除。`worker/.wrangler/` 已在根级 `.wrangler/` 覆盖，无需额外条目。
- **敲定点 3**（build 塞脚本还是 globalSetup）—— **首选落地（更精确的版本）**：塞进 Playwright `globalSetup` 不是简单 `pnpm -r build`，而是「**dist 存在性预检 + bundle 内容审计**」两步（`assertDistArtifacts` + `webDistWssUrlCheck`）。理由：单纯跑 `vite build` 不会修 `pnpm -r build` 留下的 prod-default bundle（实施期实证：跑完 `pnpm -r build` 后 bundle 烘的是 `wss://remote-pi.sankabox.com/web` 而非 `ws://localhost:8787/web`——SPA 永远连不上本地 wrangler，bridge 日志显示「Bridge gone · closed」直到加 `webDistWssUrlCheck` 才 fail-fast 报错）。web build 必须显式带 `VITE_WSS_URL=ws://localhost:8787/web`（bridge 通过 `tsx packages/bridge/src/index.ts --config` 直跑源——dist 不需要，节省 ~2s 启动开销）。
- **敲定点 4**（bridge 就绪探针走 stdout 还是 StatusBar）—— **首选 stdout 落地**：grep `bridge stdout` 的 `connected to ` 子串（`BridgeClient.handleOpen()` 实证于 `packages/bridge/src/client.ts` 的 `logger.info(\`connected to ${this.url}\`)`）。`waitForReady` 同时绑定 `child.on('exit')` 提前 reject——避免「bridge 进程死了但 stdout 还没刷新完」导致的虚假 30s 超时。第二段就绪链比 StatusBar 路线少一个 race surface（不需要等浏览器启动 + ChatView 渲染）。

### `buildHermeticEnv` 抽取路径

**首选落地**——抽取至 `tests/integration/helpers/build-hermetic-env.ts`（独立文件，`PROVIDER_KEY_ENV_VARS` 11 项 + `buildHermeticEnv({agentDir, baseEnv})`），`tests/integration/helpers/make-manager.ts` 改为 import 复用。`tests/e2e/helpers/env-builder.ts` 是 4 行 re-export 包装（避免 e2e 直接路径漂移；JSDoc 指向真源）。**抽取后 `pnpm test:integration` 30 条全绿**（`tsc -p tests/integration/tsconfig.json` + `vitest run --config tests/integration/vitest.integration.config.js` 均通过）——硬约束满足。

### 场景 (a) 断言要点

- **retry 容错断言**：实现为「`Promise.race` `chat-view` OR `recovery-error`」二选一，命中 `recovery-error` 则点 `recovery-retry` 一次后等 `chat-view`；二次 retry 不兜底（不掩盖 5s 超时挂账）。**实测未触发 retry**——pi 冷启动 ~500ms 内完成 `spawning → ready → running → idle`，5s 超时未踩中（连跑 2 次稳定性验证一致）。挂账仍在 [[current-state.md#TODO-/-阻塞]] 2026-09-07 条目；断言链就位，挂账修复后无需改 spec 即可平滑切换到「纯等 ChatView」路径。
- **input 状态断言**：**踩到一个 spec 设计 bug**——初版断言 `sendButton.toBeEnabled()`，但 `sendButton.disabled = phase === 'running' || value.trim().length === 0`（值空时永远 disabled）。改为「`inputField.toBeEnabled()`（仅 phase gated）+ `inputField.fill('ready-again')` 后 `sendButton.toBeEnabled()`」双重断言——前者验证 phase 已回 idle，后者验证输入流程可继续。
- **assistant message 断言**：用 `expect.poll` 监听 `message-row hasText: 'ok'` 出现（30s budget）——默认 fake server 队列空，每次返回 `textReply('ok')`，DOM 渲染一帧即终态。**多 delta 流式断言（task 12 §场景 (a) step 7）暂未落地**——需要 spec 拥有独立的 fake-llm-server 来注入多 delta 脚本（当前 harness 的 fake server 被 bridge 持有，spec 不可达）；该增强属 task 13 / 后续任务。
- **draft cleanup**：场景 (a) 步骤 7 末要求 `message-draft` 消失；spec 用 `expect(draft).toHaveCount(0, { timeout: 30_000 })` 收尾——单 delta 路径下 draft 可能根本没渲染（one-shot terminal）或瞬时出现后被终态替换，`toHaveCount(0)` 容忍两种语义。

### 装配偏差（task 12 §全局 setup step 4 vs 实际落地）

任务文件 §装配步骤 4 写「bridge → wrangler」顺序，但实施期实证：bridge 僵尸挂账（current-state TODO 2026-09-07）下，bridge 首次 WS 连不上 wrangler 时 Node 22 `WebSocket` 仅 fire `onerror` 不 fire `onclose`，`BridgeClient.handleClose` 不触发，重连 timer 不调度，事件循环空 → bridge 进程以 exit 0 干净退出。**改顺序为 wrangler → bridge**（`wrangler.waitForReady()` 拿到 /healthz 200 之后再 `startBridgeProcess`），保证 bridge 首次连接就成功。**`packages/bridge/` 源码零改动**——本任务「零产品修复」约束遵守。

另一项偏差：fake LLM server 必须独立子进程（**不在 globalSetup 内 in-process**）。Playwright globalSetup worker 进程在 `setupHarness()` return 后立即退出，in-process `http.createServer` 随之死——bridge spawn 的 pi 第一次 LLM 通话即 `ECONNREFUSED`，recovery ceremony 卡 5s。抽至 `tests/e2e/helpers/fake-llm-process.ts` + `fake-llm-standalone.ts` 子进程（`FAKE_LLM_URL=...` 第一行 stdout banner 父进程解析），teardown SIGKILL 进程组回收。

### 验收命令结果（commit 提交前）

| 命令 | 结果 |
|------|------|
| `pnpm run test` | **281 passed**（基线不变，12 文件） |
| `pnpm run test:integration` | **30 passed**（≈11.7s，6 文件，buildHermeticEnv 抽取后仍全绿） |
| `pnpm run test:e2e` | **1 passed + 2 skipped**（场景 a ≈4.3s 整轮；stubs task 13 实施） |
| `pnpm run test:e2e`（连跑 2 次稳定性） | 全绿（5.2s + 5.6s） |
| `pnpm run lint` | 0 errors / 5 pre-existing warnings |
| `pnpm run typecheck` | 4 包全绿 |
| `pnpm run typecheck:e2e` | 全绿 |
| `pnpm run typecheck:integration` | 全绿 |
| 端口 8787 被占时 `pnpm run test:e2e` | fail-fast with clear message（`E2E harness requires port 8787 to be free... Most likely pnpm dev is running in another shell — stop it first.`） |
| `playwright install chromium` | 已装（`~/.cache/ms-playwright/chromium-1243`） |
| `pnpm -r build` | 4 包全绿 |

### 文件清单

**新增**（11 文件）：
- `tests/e2e/playwright.config.ts`（独立 runner，敲定点 1 `.ts` 通过）
- `tests/e2e/tsconfig.json`（独立 typecheck，`paths` 仿 integration 双通道）
- `tests/e2e/helpers/global-setup.ts`（五段就绪链 + wrangler-first 顺序 + bundle WSS URL 审计）
- `tests/e2e/helpers/global-teardown.ts`（反序 SIGKILL + debug.log 跨 run 保留）
- `tests/e2e/helpers/bridge-process.ts`（spawn `npx tsx src/index.ts --config` + grep `connected to`）
- `tests/e2e/helpers/wrangler-process.ts`（spawn `npx wrangler dev` + /healthz 200 poll）
- `tests/e2e/helpers/fake-llm-process.ts` + `fake-llm-standalone.ts`（独立子进程，survive globalSetup 退出）
- `tests/e2e/helpers/env-builder.ts`（4 行 re-export 包装）
- `tests/e2e/specs/{01-first-turn,02-reload-recovery,03-multi-tab-first-responder}.spec.ts`（场景 a 实现 + b/c stub + JSDoc 指回 task 13）
- `tests/integration/helpers/build-hermetic-env.ts`（抽取真源，11 项 PROVIDER_KEY_ENV_VARS）

**修改**（4 文件）：
- `package.json`（`test:e2e` + `typecheck:e2e` 两个脚本 + `@playwright/test` devDep）
- `.gitignore`（3 行：`tests/e2e/.tmp/` + `tests/e2e/test-results/` + `tests/e2e/playwright-report/`）
- `eslint.config.js`（`projectService` ignores 加 4 条：`tests/e2e/.tmp/**` / `tests/e2e/playwright-report/**` / `tests/e2e/test-results/**` / `tests/integration/.tmp/**`）
- `tests/integration/helpers/make-manager.ts`（改为 import `buildHermeticEnv`；`PROVIDER_KEY_ENV_VARS` 11 项 + provider-key-strip 逻辑迁出至 `build-hermetic-env.ts`）
- `pnpm-lock.yaml`（+ `@playwright/test` devDep + transitive）

**零改动**（按 §硬约束）：
- `packages/*`（web/bridge/shared 源码）
- `worker/`
- `.github/`
- 根 `tsconfig`
- `worker/wrangler.toml`
- `packages/web/src/` 任何源码（testid 钩子来自 task 11，本任务仅消费）
- bridge 僵尸 / 5s recovery 超时 / 同 token 重连语义等挂账一律不动（装配顺序 + 独立 fake-llm 子进程规避）

### 已知限制 / 后续挂账

- **场景 a 跑 4-5s 整轮**（含 wrangler dev 启动 + DO SQLite migration + pi 冷启动 + Playwright chromium 启动），相比 ADR-0009 §影响段「十几秒到一分钟」预估偏短——本机 dev 机器足够快。如未来需要 CI 跑（ADR-0009 §决策 6 当前禁用），建议把 testTimeout 从 60s 提到 90s。
- **场景 a 首次运行 retry 容错断言未触发**（pi 冷启动 <5s）——但断言链就位，挂账修复后无需改 spec 即可平滑切换到「纯等 ChatView」路径。
- **debug.log 默认写入 `tests/e2e/.tmp/<runTag>/debug.log`**；teardown 跨 run 保留至 `tests/e2e/.tmp/debug-<runTag>.log`（供下一次失败时对照）——轮转 1 次，下次成功 run 会被新 run 覆盖。
- **本任务未做 product fix**：bridge 僵尸（exit 0 on ECONNREFUSED）通过装配顺序规避，不动 `packages/bridge/src/client.ts`。该挂账根因见 current-state TODO 2026-09-07 + ADR-0009 §开放点 1。

### Review 待办（提交后）

- 真实 multi-tab 场景（task 13）需要并发 browser contexts 与同一 Room DO 共享的隔离——目前 `workers: 1` 写死，单 spec 串行。task 13 实施时改为场景 (c) 内部 `Promise.all([ctxA.newPage(), ctxB.newPage()])` 共享同一 `test` 的 fixture，但 spec 间仍串行。
- `webDistWssUrlCheck` 当前 grep 全 bundle 字符串——大 bundle 上 O(n) 但实测 < 1ms，可接受；future-proof 可改为 sourcemap 反查或 vite 编译期 contract。
