# 0009. 无头浏览器 E2E（Playwright 全栈本地链路 UI 回归套件）

- 日期：2026-09-08（已核实）
- 状态：已接受、已实施（MVP 三场景落地，2026-09-08 实施注记，详见末尾）
- 背景：
  [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]] 把 bridge→pi 的 wire 层从"用户手测"升级成了回归资产（`tests/integration/` 30 条全绿），但它明确划界：浏览器 UI 层不在其范围内（ADR-0008 背景段末 + 决策 §2 末 + 备选否决末条等处均标注"将另立 ADR 承载"）。本 ADR 即那个承载位，也是原 `docs/testing.md` §3 的最终归宿（2026-09-08 拆解时挂账于 [[current-state.md|current-state TODO]]）。

  ### 盲区一：web 包零测试基建
  M3 至今 `packages/web` 没有任何测试——无 vitest 配置、无测试依赖、无一条用例。shared 有 83 条 schema 测试、bridge 有 281 条单测，web 侧的渲染逻辑（消息提取器、恢复三态、弹窗状态机、队列指示器）全靠人眼。

  ### 盲区二：M3 12 问题中数个是 web 侧、全部由用户手测发现
  [[current-state.md#最近变更]] 2026-09-07 端到端修复轮里：
  - `e19a687` snapshot 不稳定——`useSyncExternalStore` 每次 render 返回新对象 → React Maximum update depth exceeded 直接崩页。页面级崩溃，任何能走到 ChatView 的 E2E 都会红。
  - `1f7679b` StrictMode 双跑 dispose 竞态——恢复仪式 `dispose()` 在双挂载下与新一轮 `initiate` 竞态，迟到 cancel 让在途 reply resolver 走 `request_expired` 而非真已过期。
  - `c6d2f90` web 提取器位置键——消息提取器按 pi 实物形状取位置键（同批 8 笔"wire/落盘细节 vs pi 实物"之一，落在 web 侧）。

  三笔共同点：都在浏览器里才暴露，bridge wire 层全绿也拦不住。

  ### 盲区三：手测清单里 UI 层永远挂账
  任务 [[tasks/m3/08-docs-and-validation.md|08]] 的三端联调 14 条清单，wire 层部分已由 ADR-0008 自动化（4 类弹窗 6 条 it），但"ChatView 渲染 / F5 仪式 UX / 弹窗可交互 / 多 web 端先答者胜"仍需用户逐条点击验收。每次改 web、每次升级 pi、每次动协议都得重走。

  ### 组装零件已全部就位（本 ADR 得以现在立项的前提）
  实证盘点（2026-09-08 scout）：
  - **worker 侧**：`worker/wrangler.toml` 的 `[assets]` 指向 `../packages/web/dist`、`not_found_handling = "single-page-application"`、`run_worker_first = ["/web","/bridge","/healthz"]`；wrangler dev 默认端口 `8787`，与 web 的 `DEV_DEFAULT_WSS_URL = 'ws://localhost:8787/web'`（`packages/web/src/ws/config.ts:12`）天然对齐；`GET /healthz` 返回 200 + 版本文本，是现成就绪探针。
  - **bridge 侧**：`node packages/bridge/dist/index.js --config <tmp>.json` 直起可行；config 四字段 zod strict，其中 token 写进 config 即被逐字使用且不回写（`packages/bridge/src/config.ts:219-226`）——E2E 无需解析 bridge stdout 抓 token。
  - **pi + 假 LLM 侧**：`tests/integration/helpers/fake-llm-server.ts`（`startFakeLlmServer` + `textReply`/`toolUseReply` 等 SSE 构造器）与 `make-fixture.ts`（`makeAgentDir`）同在 `tests/` 下，可直接相对导入复用；fixture 扩展 `test-ext.ts` 的 `trigger_dialog` 工具可脚本化触发 4 类弹窗。
  - **web 侧行为已实证**：生产 build（`vite build`，`NODE_ENV=production`）无 StrictMode 双 effect；token 从 URL hash 读（`/#<token>`，trim 后非空生效）；恢复三态 `RecoveryInFlight` / `ChatView` / `RecoveryErrorCard`（后者带"重试"按钮）；同 token 重连不重发仪式（`App.tsx` 的 `autoStartConsumedRef` 按 token 守门，只有 token 切换 / F5 / 手动 retry 才重发）。

  唯一缺口是断言抓手：21 个 web 组件里只有 1 个有 `data-testid`（`ChatView` 的 `chat-view`）。这是决策 §4 要补的前置改动。

- 决策：

  ### 1. 栈与位置：@playwright/test + chromium，顶层 `tests/e2e/`，独立 runner
  - 测试框架 `@playwright/test`（非 Playwright Library + vitest）——自带 fixture 生命周期、自动重试、trace/video/screenshot 归档、并行 worker 控制，这些是 E2E 稳定性的基础设施。
  - 浏览器只 chromium——M3 web 是自用工具（手机浏览器远程操控），跨浏览器矩阵在此阶段是纯成本。Firefox/WebKit 待实际遇到差异再加。
  - 位置 `tests/e2e/` 顶层——与 `tests/integration/` 平级，同样避开 `vitest.workspace.ts` 的拾取范围，且能相对导入 `../integration/helpers/*` 复用。
  - 独立 `tests/e2e/playwright.config.ts` + `tests/e2e/tsconfig.json`——tsconfig 仿 `tests/integration/tsconfig.json` 的 `baseUrl` + `paths` 模式，把 `@remotepi/{shared,bridge}` 映射到 `packages/*/src`。
    - 注意与 ADR-0008 §3 的差异：ADR-0008 的 vitest config 必须用 `.js`（ESLint `projectService.allowDefaultProject` 只认 `*.js`/`mjs`/`cjs`）。Playwright config 用 `.ts` 是其标准形态，是否会撞同一个 ESLint 坑**待实施时验证**——若撞上：把 `tests/e2e/**` 加进 `projectService`，或退回 `.js`。**待实施时敲定**。
  - 根 `package.json` 加脚本：`"test:e2e": "playwright test --config tests/e2e/playwright.config.ts"` + 可选 `"typecheck:e2e": "tsc -p tests/e2e/tsconfig.json"`。
  - 不并入 vitest workspace——独立 runner，`pnpm test` 默认集零接触、CI 四步零改动。与 ADR-0008 §3 完全同口径。

  ### 2. 全真进程组装：wrangler dev + bridge 子进程 + 真 pi + 进程内假 LLM
  被测系统（SUT）是四进程真实链路，Playwright 只扮演浏览器：

  ```
  [chromium]
    → ws://localhost:8787/web   (subprotocol: ['remotepi.v1', <token>])
    → [wrangler dev 子进程]     （供 SPA 静态资源 + Room DO 转发）
    → ws://localhost:8787/bridge（同 subprotocol 对）
    → [bridge 子进程]            node packages/bridge/dist/index.js --config <tmp>.json
    → stdin/stdout JSONL
    → [真 pi --mode rpc 子进程]  （bridge spawn，env 注入 fixture）
    → HTTP POST /v1/messages
    → [进程内假 LLM server]     （复用 tests/integration/helpers/fake-llm-server.ts）
  ```

  逐条约束：
  - **wrangler dev 起真 worker**——不 mock worker、不用 `vite preview` 顶替。Room DO 按 token 路由、subprotocol token 提取、bridge_status 广播、`routeOpenMessage` 转发链都是 M3 踩过坑的地方（`1c86aca` 就是转发链漏 default 分支），必须走真实现。
  - **bridge 走 `node dist/index.js`，禁用 tsx watch**——[[current-state.md|current-state TODO]] 有明确挂账（tsx watch 僵尸）。E2E 直起 dist 规避已知问题。
  - **bridge config 由测试生成到临时文件**，四字段：`worker_url` 必须含 `/bridge` 路径（如 `ws://localhost:8787/bridge`，漏路径是最容易踩的配置错）；`web_base_url` 仅用于打印 `shareUrl` 不参与运行时，任意占位即可；`work_dir` 指向 `makeAgentDir` 产出的 workDir（临时副本）；token 固定值写死（见 §7）。
  - **真 pi 由 bridge spawn**——E2E 不直接管 pi 进程；pi 的 env（`PI_CODING_AGENT_DIR=<fixture>` + `PI_OFFLINE=1` + 剥离 11 个 provider key）通过 bridge 子进程的 env 透传。
  - **进程内假 LLM server**——复用 `startFakeLlmServer`，port 0 随机端口回填 fixture `models.json`。密闭性三层防线（ADR-0008 §5）原样继承。
  - **明确否决进程内 bridge**——那是 ADR-0008 §2 的做法，对 wire 层最优；但浏览器 E2E 的全部价值就在跨进程真实链路（WS 握手、subprotocol 配对、DO 转发、重连退避），进程内驱动会全部旁路掉。

  ### 3. 场景范围：MVP 三场景 + 可选后续
  MVP 三场景（必做基线）：
  - **(a) 首次对话流式渲染**：`page.goto('/#<token>')` → 断言 `RecoveryInFlight` 出现 → `ChatView` 出现 → 输入发送 → 断言用户消息行出现 → assistant 草稿行文本逐步增长（假 LLM 按多个 `content_block_delta` 吐字，`expect.poll` 观察文本增长，或至少断言 draft 行先出现再被终态消息替换）→ `agent_settled` 后输入框重新可用（`data-phase` 回 idle）。
  - **(b) F5 恢复**：在 (a) 状态上 `page.reload()` → 恢复仪式再走一遍（fresh mount ⇒ fresh gate ⇒ `autoStartConsumedRef` 重置）→ `ChatView` 出现且消息历史完整渲染（条数/文本与 reload 前一致）。与 ADR-0008 §决策 2 的 `--session` 恢复同语义但走 UI 层。
  - **(c) 多端弹窗先答者胜**：两个 browser context 同 token → 两端都到 `ChatView` → context A 发 prompt 让 pi 调 `trigger_dialog(kind=confirm)` → 断言两端都弹 `ConfirmDialog` → A 点 Yes → A 弹窗收起、B 弹窗也收起（`blocked_on` 移除该 id 后 React key 卸载）→ B 若窗口内抢答，断言 B 侧 `request_expired` 的 UI 表现。
    - **架构事实**：worker 按 token 路由同一 Room DO，没有 cookie 隔离概念——两 context 同 token 就是同一房间两个 web 端（ADR-0004 + 任务 [[tasks/m3/05-bridge-popup-core.md|05]] 的语义）。
    - **竞态断言时序脆弱**：B 侧"迟交"要在 A 已答之后、bridge 清 pending 之前送达。具体手法**待实施时敲定**（候选：B 先点到 `submitting` / `page.route` 延迟 / 接受"两端都收起"为主断言而把 `request_expired` 降为 soft assertion）。

  可选后续（不阻塞 MVP）：(d) abort 路径；(e) idle kill / bridge 重启自愈（缩短 `idleTimeoutMs` 加速）；(f) PRD §4.5 命令失败 UX；(g) 4 类弹窗逐一交互。

  实施任务拆分与归属**待排期**（见开放点）。

  ### 4. 前置改动：web 组件补 ~15 处 `data-testid`（唯一 web 源码改动）
  当前 21 个组件只有 1 个 testid。E2E 实施前必须补齐抓手，否则断言只能靠 CSS class / 文案，样式重构或文案改写会连带 E2E 红。

  待补清单（具体命名与最终数量**待实施时敲定**，此处给意图）：
  - `RecoveryInFlight`（`recovery-in-flight`）；
  - `RecoveryErrorCard`（`recovery-error` + `recovery-retry`，已有 `data-error`）；
  - `MessageList`（`message-list` / `message-row` / `message-draft` / 空态）；
  - `QueueIndicator`（`queue-indicator` 含两个计数 pill）；
  - `InputBar`（`input-field` / `input-send` / `input-abort` / `input-error`）；
  - `DialogHost`（`dialog-host` / `dialog-toast`）；
  - `ConfirmDialog`（容器 + 三按钮 `dialog-cancel` / `dialog-decline` / `dialog-confirm-yes` + `dialog-error`）；
  - `SelectDialog` / `InputDialog` / `EditorDialog`（容器 + 输入 + 提交/取消）；
  - `StatusBar`（`bridge-status`，`data-state` 已可用）；
  - `TokenPrompt`（输入 + 提交，备用）。

  已可直接用：`ChatView` 的 `data-testid`、`PhaseIndicator` 的 `data-phase`、`StatusBar` 的 `data-state`、`RecoveryErrorCard` 的 `data-error`。

  **纪律**：只加 `data-testid` 属性，不动 `className`、不动 DOM 结构、不动文案——样式与断言解耦。这是本套件对 `packages/web` 的唯一源码改动面（对比 ADR-0008 的 `packages/*` 零改动）。

  ### 5. 复用策略：直接相对导入 integration helper + 提炼 env 构造逻辑
  - **可直接相对导入复用**（同在 `tests/` 下）：`../integration/helpers/fake-llm-server.js`（`startFakeLlmServer` + SSE 构造器 + requests 录制）；`make-fixture.js`（`makeAgentDir`：四件套 + `test-ext.ts` 拷贝 + `.tmp/<run-tag>/` 隔离 + cleanup）；`wait-for.js`（非 DOM 条件等待仍有用，Playwright 自带 `expect.poll` 管 DOM）。
  - **不能直接复用、需提炼或复制**：`make-manager.ts` 的 `PROVIDER_KEY_ENV_VARS` 剥离 + `PI_CODING_AGENT_DIR` / `PI_OFFLINE` 注入——该 helper 产物是进程内 `PiProcessManager`，E2E 要的是 spawn bridge 子进程时的 env 对象。**首选**：抽出纯函数 `buildHermeticEnv({agentDir, baseEnv})`，两侧共用单一真源（清单已在 review 扩过一次 4→11 个，防漂移）；**退路**：`tests/e2e/helpers/` 复制 + 头部注释指回。**待实施时敲定**（抽取会碰 `tests/integration/`，需确认 30 条仍绿）。
  - **fixture 扩展** `test-ext.ts` 的 `trigger_dialog` 是场景 (c) 与可选 (g) 的弹窗触发手段，`makeAgentDir` 已自动拷贝，零额外工作。

  ### 6. CI / 本机口径：本机专用，CI 四步零改动跳过
  与 ADR-0008 §决策 3 完全同口径：`pnpm test:e2e` 本机专用，三项前置：
  1. 本机装了 pi（沿用 `assertPiAvailable` 式预检，失败 fail fast 指回本 ADR）；
  2. `packages/web/dist` 与 `packages/bridge/dist` 已构建（见 §7）；
  3. Playwright chromium 二进制已装（`npx playwright install chromium`，本机一次性）。

  CI 四步（`.github/workflows/` 零改动）有意跳过——runner 没 pi、没浏览器二进制，跑只会假绿或假红。`pnpm test` 默认集不含本套件；`pnpm typecheck` 也不含，需显式 `typecheck:e2e`。

  ### 7. 就绪与清理纪律（flakiness 的主要来源，逐条钉死）
  1. **双构建前置**——wrangler dev 的 `[assets]` 是 `packages/web/dist` 静态快照不热更新；bridge 走 `dist/index.js`。web build 与 bridge build 必须先于套件启动。web build 必须设 `VITE_WSS_URL=ws://localhost:8787/web`——`config.ts` 解析顺序是"VITE_WSS_URL 非空胜出"，生产 build 不设会连到 `PROD_DEFAULT_WSS_URL`（线上域名）。build 塞 `test:e2e` 脚本还是 Playwright `globalSetup`，**待实施时敲定**；无论哪种，缺 `dist` 时要明确报错而不是白屏。
  2. **`.wrangler/` 每次 run 前清理**——DO SQLite 状态落 `worker/.wrangler/` 跨运行持久。不清的后果：上轮消息残留被 `get_messages` 拉回，场景 (a) 空态断言失效。`globalSetup` 里 `rm -rf worker/.wrangler` 最简。（首次启动 SQLite migration 约 1-2s，就绪等待要含进去。）
  3. **端口固定 8787，占用即 fail fast**——不做动态端口。理由：`VITE_WSS_URL` 在 build 期烘进 bundle，动态端口意味着每次 run 重新 build web（慢且脆）。代价是"本机跑 `pnpm dev` 时不能同时跑 E2E"——可接受；端口被占要立刻报错说清原因，不能让 wrangler 静默换端口导致 web 连错地址。
  4. **token 固定写死在 config**——`config.token` 非空时 bridge 逐字使用且不回写（`config.ts:219-226` 实证）。测试直接 `page.goto('/#<固定 token>')`，不需要解析 stdout。建议带 run-tag 的固定串（如 `e2e-fixed-token-<runTag>`）而非常量，即便 `.wrangler` 清理漏了也不撞旧房间。
  5. **三段就绪链**（每段都等到，不靠 sleep）：
     - 第一段 `GET /healthz` 返回 200 → wrangler dev 就绪（含 assets 与 DO migration）；
     - 第二段 bridge 已连上 worker → 首选看 bridge stdout 连接日志，备选（更稳）浏览器 `StatusBar` 的 bridge 状态转 reachable——取哪种**待实施时敲定**；
     - 第三段 page 上 `chat-view` 出现 → 恢复仪式成功，可交互。
  6. **进程清理必须兜底**——`globalTeardown` 按序 kill bridge 与 wrangler 子进程（bridge `stop()` 内建 `SIGTERM→1s→SIGKILL` 会带走 pi）；假 LLM server `close()`；fixture `cleanup()`。任何一条漏掉都会堆积僵尸/占住 8787。
  7. **`.gitignore` 补 Playwright 产物**——`tests/e2e/.tmp/`、`test-results/`、`playwright-report/`。具体条目**待实施时敲定**。

  另附两条断言语义约定：
  - **弹窗自动关闭走 React key 卸载不是 timer**——`DialogHost` 按 `session_state.blocked_on` 的 id 列表渲染，id 消失即卸载。断言看 DOM 消失（`toBeHidden` / `toHaveCount(0)`），不等倒计时数字。
  - **同 token 重连不重发恢复仪式**——`autoStartConsumedRef` 按 token 守门。"断线自动重连后仪式会再走一遍"的假设是错的；只有 token 切换 / F5 / 点 retry 才重发。写场景 (e) 时不要按错假设断言。

- 影响：

  ### 正面
  - **web 包获得首个测试基建**——从零测试到 UI 层回归资产，覆盖渲染（消息提取器/流式草稿）到状态机（恢复三态/弹窗三态）到跨端语义（多 web 先答者胜）。背景段三笔 web bug 都在 MVP 三场景射程内。
  - **补上 ADR-0008 明确划界之外的那层**——wire 层（ADR-0008，30 条）+ UI 层（本 ADR，MVP 3 场景）合起来，"手测才能发现"面收窄到极小：剩视觉/手机端触控/真 LLM 语义质量，这三类本来就该人看。
  - **手测清单减负**——任务 [[tasks/m3/08-docs-and-validation.md|08]] 的 14 条里 UI 层四项（ChatView 渲染 / F5 仪式 / 弹窗可交互 / 多 web 端）可从"每轮手点"降为"E2E 全绿即通过 + 偶尔冒烟"。
  - **全栈链路本身成为被测对象**——wrangler dev + DO 转发 + subprotocol 配对 + bridge WS 客户端这条链只有 E2E 会走。`1c86aca`（worker 转发链漏 default 分支）正是这一层。

  ### 代价
  - **flakiness 是主要风险，需持续面控**——四进程 + 真 pi 冷启动 + 浏览器渲染时序。缓解：§7 七条纪律 + `expect.poll` / auto-waiting（不写 sleep）+ trace 归档 + 保守 retry。具体 timeout 与 retry 次数**待实施时敲定**——起点建议单场景 60s、`retries: 1`（本机）。
  - **启动开销显著**——双构建 + wrangler dev 启动（首次 DO migration 1-2s）+ pi 冷启动（约 3s）+ 浏览器启动。参照 ADR-0008 的 30 条 ≈11s，本套件三场景预计十几秒到一分钟。本机专用可接受。
  - **双构建前置是新的心智负担**——"改了 web 代码要先 build 再跑 E2E"容易忘，忘了就是拿旧 bundle 测新代码（不报错，只是断言莫名红）。§7.1 把 build 编进流程正为此。
  - **浏览器二进制维护**——`npx playwright install chromium` 本机一次性，但 Playwright 升级要重装；`@playwright/test` 是不小的 devDependency。
  - **端口 8787 独占**——跑 E2E 时不能同时 `pnpm dev`。固定端口换来 bundle 不用每次重 build，值得。
  - **web 源码多 ~15 处 `data-testid`**——测试属性进生产 bundle（体积影响可忽略），比断言绑 CSS class 健康得多。

- 备选否决：
  - **Cypress**——否决。Playwright 的多 browser context 是场景 (c) "两端同 token"的原生能力；Cypress 单 tab 模型测多端要起两实例或 iframe 变通，成本高且失真。子进程编排（`globalSetup` 起 wrangler/bridge）也更自然。
  - **vite dev server 作为 SUT**——否决。① dev 模式 React StrictMode 双 effect 引入生产环境不存在的双挂载竞态（`1f7679b` 正是这条路上的 bug），拿 dev 测等于测用户永远不会遇到的环境；② wrangler dev 的 `[assets]` + `run_worker_first` + SPA fallback 这套路由配置本身就是部署形态（[[architecture/decisions/0005-unified-domain-with-worker-static-assets-and-actions-cd.md|ADR-0005]]）的一部分，绕过就漏测 deep-link/SPA fallback。用生产 assets 更稳也更真。
  - **进程内 bridge**（`new PiProcessManager` / `start()` 返回值驱动）——否决。ADR-0008 §决策 2 的做法对 wire 层最优，但对浏览器 E2E 会旁路掉 WS 握手 / subprotocol 配对 / DO 转发 / 重连退避——本套件的全部增量价值。见 §2 末条。
  - **mock WS 层的 web 单测替代**——否决作为替代，不否决作为补充。M3 三笔 web bug 里 `e19a687`（`useSyncExternalStore` 死循环）与 `1f7679b`（StrictMode dispose 竞态）都是真实 React 调度 + 真实时序下才暴露，jsdom + 假 client 大概率测不出。web 组件级单测有独立价值（`extractText` / `messageToItem` 等渲染纯函数尤其适合），但兜不住本 ADR 这层。未来若建 web vitest 基建属独立决策。
  - **CI 跑 E2E**——否决。runner 没 pi、没浏览器二进制、没 wrangler 环境，跑出来的绿是假绿（比不跑更危险）。与 ADR-0008 §决策 3 同口径。将来若上 CI，前置是"pi 二进制可在 CI 安装且无需 auth"——另一个决策。
  - **等 web 有了 vitest 基建再做 E2E**——否决这个排序。UI 层高价值 bug（页面崩溃 / 恢复仪式失败 / 多端竞态）恰恰是单测最难覆盖、E2E 最容易覆盖的；先 E2E 边际收益更高。

- 开放点：
  1. **恢复仪式 5s 超时 vs pi 冷启动**（与 E2E 有真实依赖）——[[current-state.md|current-state TODO]] 挂账（2026-09-07，待讨论）：`RECOVERY_TIMEOUT_MS = 5_000`（`packages/web/src/ws/recovery.ts:48`）对 pi 冷启动不足，实测首启可超 5s 致 `snapshot_failed`（探针：pi 冷启动约 3s + `get_messages` 往返，总时长逼近 5s 红线）。对 E2E 影响：场景 (a)(b) 第一步就是恢复仪式，大概率会踩。
     - **短期**（不阻塞立项）：`RecoveryErrorCard` 有 retry，E2E 容忍一次 retry——断言写成"等 ChatView；若先见 `recovery-error` 则点一次 retry 再等"。
     - **根治**（建议实施前先决议挂账）：TODO 已有候选 A/B/C/D，倾向 B+C 轻量合体（B bridge_status 感知：offline 秒失败 + online 给宽限；C 相位感知计时器：`session_state{phase:'spawning'}` 广播重置 snapshot 计时器）。
     - 本 ADR 立场：标注依赖关系，不阻塞立项；实施排期时先看挂账是否已决议，据此选断言写法。
     - 文档漂移一处顺手记下：原 `docs` 文档常量名漂移（源码实为 `RECOVERY_TIMEOUT_MS`）——已随 [[tasks/m4/09-docs-sync.md|任务 09 docs-sync]] 统一更正为 `RECOVERY_TIMEOUT_MS`（grep 实证零残留，2026-09-08）。
  2. **实施任务拆分与归属待排期**——本 ADR 只定决策。实施至少两块：(i) web 组件补 `data-testid`（§4，`packages/web` 唯一改动，可独立先行、零风险）；(ii) `tests/e2e/` 套件本体（config/helper/三场景）。拆两个任务还是一个两阶段、归 M3 收尾还是 M4，**待排期时定**。建议 (i) 先落——零风险且让 (ii) 实施者直接有抓手。
  3. **决策条文里显式标注的"待实施时敲定"项汇总**：Playwright config 的 `.ts` 是否撞 ESLint `projectService`（§1）；场景 (c) 的 `request_expired` 竞态构造手法（§3）；`data-testid` 具体命名与最终数量（§4）；env 构造逻辑取抽取共用还是复制（§5）；build 塞脚本还是 `globalSetup`（§7.1）；bridge 就绪探针取 stdout 还是 StatusBar（§7.5）；`.gitignore` 具体条目（§7.7）；timeout/retries 具体值（影响-代价段）。

- 参考：
  - [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md|ADR-0008]]（假 LLM + 隔离 pi，bridge wire 层）——姊妹 ADR。本 ADR 承接其"浏览器层另立 ADR"标注；复用其 §决策 1 fixture 四件套 / §决策 4 `trigger_dialog` / §决策 5 密闭性三层防线；§决策 3 的 CI 跳过口径原样沿用。
  - 任务 [[tasks/m3/10-integration-test-infra.md|10]]（done）——ADR-0008 的实施任务；其"后续挂账"段第一条即本 ADR 的前身（2026-09-08 同步加本 ADR 链接）。
  - 任务 [[tasks/m3/08-docs-and-validation.md|08]]（活）——三端联调 14 条手测清单；本套件为其中 UI 层四项提供自动化兜底。
  - [[current-state.md|current-state TODO]]——「无头浏览器 E2E」条目（本 ADR 立项来源）+「恢复仪式 snapshot 5s 超时」条目（开放点 1 依赖）+「bridge 僵尸进程」条目（§2 禁用 tsx watch 依据）。
  - [[current-state.md#最近变更]] 2026-09-07 端到端修复轮——12 问题 / 10 commit；`e19a687` / `1f7679b` / `c6d2f90` 三笔 web 侧问题是背景段直接论据。
  - [[architecture/decisions/0004-extension-ui-dialog-forwarding.md|ADR-0004]]——4 类弹窗转发 + 先答者胜 / `request_expired` 语义；场景 (c) 契约来源。
  - [[architecture/decisions/0005-unified-domain-with-worker-static-assets-and-actions-cd.md|ADR-0005]]——主域统一 + Worker Static Assets 部署形态；wrangler dev 作为 SUT 的真实性依据（备选否决第二条）。
  - **关键源码锚点**：`worker/wrangler.toml`（`[assets]` / `run_worker_first` / `not_found_handling`）；`packages/web/src/ws/config.ts:12,29`（`VITE_WSS_URL` 解析与 `DEV_DEFAULT_WSS_URL`）；`packages/web/src/ws/recovery.ts:48`（`RECOVERY_TIMEOUT_MS = 5_000`，开放点 1）；`packages/web/src/App.tsx`（`readTokenFromHash` / 恢复三态 / `autoStartConsumedRef` 守门）；`packages/bridge/src/config.ts:219-226`（token 非空即逐字使用不回写）；`tests/integration/helpers/{fake-llm-server,make-fixture,make-manager}.ts`（复用与提炼对象）。

## 实施注记（2026-09-08）

本 ADR §开放点 2 拆分建议落地为三任务，**5 笔本地 commit 全部落地**——本 ADR 状态由「待实施」升级为「已落地 MVP」（状态改为：已接受、已实施）。

- **(i) testid 抓手先行**（[[tasks/m3/11-web-testid-hooks.md|11]]，commit `96477eb`）—— 8 文件 / 22 处 `data-testid` 新增 + 2 处 `data-count` 计数透出；className/DOM/文案/样式/状态机/事件流零变化；review 零 C 零 W 零 S。
- **(ii) harness 装配 + 场景 (a)**（[[tasks/m3/12-e2e-harness.md|12]]，commit `127595c`）—— 4 进程装配（wrangler dev / bridge / 真 pi / 假 LLM 独立子进程）+ 场景 (a) 首次对话流式渲染 + 3 spec stub 指回任务 13；敲定点 1-4 全部落定（`.ts` 通过 ESLint projectService / 3 条 gitignore / globalSetup + `webDistWssUrlCheck` bundle 审计 / bridge stdout grep `connected to` 探针）；`buildHermeticEnv` 抽取首选落地（集成 30 条回归全绿）。
- **(ii) 后半部 场景 (b) + (c)**（[[tasks/m3/13-e2e-scenarios.md|13]]，commit `5b27300`）—— 场景 (b) F5 reload 逐字段对账（message-row 文本与条数）+ 场景 (c) 多端弹窗先答者胜（双 context 同 token + A 后答 / B 端 observation annotation 记录 `request_expired`）；假 LLM admin 端点 `POST /__e2e/script` + `GET /__e2e/requests`（精确路径匹配 + loopback-only）支撑 spec 脚本化注入；`flushEachEvent: true` 支撑场景 (a) 多 delta 严格单调断言。
- **两轮 review 修复**（commit `1558309` 合并三任务 W1-W5 + S1/S3/S5 + commit `bb34aaa` 收尾 W5 残留竞态 + 10 项清理）—— 总计 1 必修 W5（bridge 已退时 `stop()` 立即返回）+ 14 项机械清理（孤儿 JSDoc / 注释如实化 / 死字段删除 / 死代码三处 / 逐字段断言 / observation annotation 替代 console.log 等）。
- **验收终态**：e2e 3 场景全绿（≈10-11s 连跑 2 次稳定），基线 281 单测 + 30 集成不变，typecheck/lint/build 全绿，CI 四步零改动；`packages/*` / `worker/` / `.github/` 零改动——产品行为面仅 web 包增 22 处 `data-testid` 属性（任务 11 唯一 web 源码改动）。任务 10 review 期间漏配的 `eslint.config.js` `tests/integration/.tmp/**` ignore 由任务 12 顺带补配（4 条 ignore 一次性提交）。

### 开放点收敛

- **开放点 1（恢复仪式 5s 超时 vs pi 冷启动）**——走**短期 retry 容错路径**未变。e2e 已按此运行（任务 12 场景 (a) 步骤链 + 任务 13 场景 (b) F5 都以此为第一条容错逻辑）。**未触发** retry——本机 pi 冷启动 ~500ms 远低于 5s 超时。挂账仍**开放**（[[current-state.md|TODO]] 2026-09-07 条目），未根治；e2e 断言链就位，挂账修复后可简化断言为「纯等 ChatView」无需改 spec。
- **开放点 2（实施任务拆分）**——拆为三个任务（11 / 12 / 13），与本 ADR §开放点 2 建议（两任务 i/ii）**微调**：以「装配与场景 (a) 同任务」取代「装配 + 三场景同任务」——理由：任务 12 依赖任务 11 的 testid 抓手（不能完全独立），任务 13 依赖任务 12 的装配 + 场景 (a) 作为 retry 容错 helper 复用源；拆为三任务使每个 commit 体积适中、review 可分别发起。三任务已在 M3 周期内全部 done。
- **开放点 3（决策条文“待实施时敲定”项）**——**全部落定**：
  - Playwright config `.ts` 不撞 ESLint `projectService`（敲定点 1，首选 `.ts`）✅
  - 场景 (c) `request_expired` 竞态构造手法走**首选 A 降级**——主断言「先答者胜 + 双端收起」+ `request_expired` 降为 observation annotation（理由：本地快机器 dialog 生命周期仅 36-48ms，B 端迟交不会真触发；ADR-0004 语义在慢速环境/真机仍可能成立）✅（敲定点 5）
  - `data-testid` 命名与数量：22 处全库统一（任务 11 完成情况表）✅
  - env 构造逻辑走**首选抽取**（`buildHermeticEnv` 迁至 `tests/integration/helpers/build-hermetic-env.ts` 共用真源，e2e `env-builder.ts` 是 4 行 re-export 包装）✅
  - build 塞 Playwright `globalSetup`（首选「dist 存在性预检 + bundle 内容审计」两步：assertDistArtifacts + webDistWssUrlCheck——单纯 `pnpm -r build` 不会修 prod-default bundle，需 web build 显式带 `VITE_WSS_URL=ws://localhost:8787/web`）✅（敲定点 3）
  - bridge 就绪探针走 stdout（grep `connected to ` 子串）+ `child.on('exit')` 提前 reject 防「30s 虚假超时」✅（敲定点 4）
  - `.gitignore` 具体条目：3 条落定（`tests/e2e/.tmp/` + `tests/e2e/test-results/` + `tests/e2e/playwright-report/`）✅（敲定点 2）
  - timeout/retries 具体值：`timeout: 60_000` + `retries: 1`（与 ADR-0009 §影响-代价段起点建议一致）✅

### 关键实测（本地快速环境，本机化不推广）

- **dialog 生命周期 36-48ms**——场景 (c) MutationObserver 采样本机实测「add:dialog-confirm」与「remove:dialog-confirm」间隔仅 36-48ms（远低于 Playwright 默认轮询粒度）。**结论**：B 端迟交触发 `request_expired` 的竞态窗口在本机**不存在**。本 ADR §决策 3 首选 A 路径代码在「中速/慢速」环境下仍可能成立，e2e 已加 `test.info().annotations` observation 记录实际不触发状态；**仍可能藏 hidden flakiness**，未来慢速环境/真机仍需重新评估。详见 [[tasks/m3/13-e2e-scenarios.md#敲定点-5-结论|13 敲定点 5 结论]]。
- **pi 冷启动 ~500ms**——本机实测 pi 0.85.1 冷启动（`spawning → ready → running → idle`）仅 500ms。5s 恢复超时未踩中，retry 容错断言**未实际触发**。断言链就位为“不同机器/首次 SQLite migration 时仍可能踩”预留——该断言是 e2e **已知行为**而非产品修复，根因挂账仍**开放**。详见 [[tasks/m3/12-e2e-harness.md#场景-a-断言要点|12 场景 (a) 断言要点]]。
- **装配顺序铁律：wrangler → bridge**——Node 22 `WebSocket` 对 `ECONNREFUSED` 只 fire `onerror` 不 fire `onclose`，bridge `handleClose` 不调度重连，事件循环空 → bridge 进程以 exit 0 干净退出。这是**避免 bridge 僵尸挂账**的装配侧手段（[[current-state.md|TODO]] 2026-09-07 「bridge 僵尸」条目），**产品代码未动**（`packages/bridge/src/client.ts` 零 diff）。未来如根治该挂账（补 `onerror` → `onclose` 调度 / 加 `ws` 库代替原生 `WebSocket`），本铁律可取消。
- **假 LLM 独立子进程铁律**——Playwright `globalSetup` worker 进程在 `setupHarness()` return 后**立即退出**（globalSetup 退出会带走 in-process server）。桥接的 pi 第一次 LLM 通话即 `ECONNREFUSED`，recovery ceremony 卡 5s。必须抽至独立子进程（`tests/e2e/helpers/fake-llm-process.ts` + `fake-llm-standalone.ts` 入口，`FAKE_LLM_URL=...` 首行 stdout banner 父进程解析）。详见 [[tasks/m3/12-e2e-harness.md#装配偏差task-12-全局-setup-step-4-vs-实际落地|12 装配偏差段]]。
- **本机调试需预先清理残留进程**——`wrangler dev` / `workerd` / `tsx.*packages/bridge` 残留会占 8787 端口 / 留 .wrangler SQLite 状态。`pnpm test:e2e` 运行前最好 `pkill -9 -f 'wrangler|workerd|tsx.*packages/bridge'`——CI fresh runner 无此问题，仅本机调试需要。详见 [[tasks/m3/13-e2e-scenarios.md#收尾修复轮review-通过后的-follow-up-清单|13 收尾修复轮 stale process 清理项]]。

### 全量测试基线（2026-09-08 实测）

- **3 套件 314 条全绿**：`unit 281`（0.65s） + `integration 30`（11.7s） + `e2e 3`（10.1s，含一次性 globalSetup ≈3.2s：web 构建 + wrangler dev + bridge + fixture）；顺序总耗时 ≈23s。
- **integration 成本结构**：几乎全在 hooks——每条 it 冷启真 pi（`spawnCount` + `bridge.start()` + handshake + LLM 假 server 装配），用例体本身仅 ~0.02s。按文件 wall 时长分布：`04-extension-dialogs 3.1s` > `01-happy-path 1.7s` > `06-multi-turn 1.2s` > `02-session-persistence 1.1s`，另 ~4.7s 在套件级 `beforeAll/afterAll` hook 无法按条归因。**未来提速方向**：per-file 复用 pi 进程（cache + 复用 `PiProcessManager` 实例），代价是牺牲隔离性（fixture 串味 + 状态污染），本套件**有意不优化**——隔离性是 ADR-0008 §1.5 密闭性的核心。
- **口径注记**：vitest 原生「用例时长」不含 hooks，**看 `duration` 评估成本会严重低估**；需按文件 wall 而非 it duration 估算。`pnpm test:integration --reporter=verbose` 可看 it duration 但不包含 hook，`pnpm test:integration --reporter=default` 输出的 wall 总耗时更接近真实成本。
- **数据来源**：本次为本机单轮实测，**非稳定基准**——耗时机器相关（CPU / 磁盘 / pi 二进制版本 / 假 server 端口分配延迟均影响），单次数据不推广；如需稳定基线需多轮 `hyperfine` 或类似工具采样。
