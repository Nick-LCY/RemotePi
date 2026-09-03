# M1 基础设施基座

## 背景

RemotePi 路线图 [[roadmap.md]] 把项目切成 M1–M4 四步走：基建 → 通路 → 单 session 闭环 → 多 session 管理。M1 是后面三个里程碑赖以起跑的"地基"，必须先把 monorepo 拓扑、协议类型雏形、CF 边缘资源、CI 骨架搭好，否则 M2 一上来就要面对"目录还没定、类型没共享、DNS 不通、CI 没接"的复合阻塞。

M1 落地的两个待决问题（[[roadmap.md#6-待决问题prd-阶段逐个敲定|roadmap §6]] 归属表）：
- "monorepo 细节（`worker/` 与 `packages/` 目录关系；`packages/shared` 版本引用方式）" → 在本 PRD 的"方案 §1 仓库拓扑"中给出结论。
- "pi 版本锁定策略——依赖锁定半边（兼容性承诺留 M3）" → 在本 PRD 的"方案 §6 pi 版本锁定策略"中给出结论。

剩下的待决问题（bridge 分发方式、CF 套餐配额、token 安全、断线重连增量、多 web 端并发语义）均不属于 M1 范围，延期到对应里程碑。

## 目标

- 建立 pnpm workspaces monorepo 骨架，落定 ADR-0002 的目录布局（含 `worker/` 与 `packages/` 平级的最终结论）。
- 在 `packages/shared` 实现 RemotePi 隧道信封（envelope）的类型与运行时校验雏形——版本号、消息种类（kind）、hello/ping/echo 级别的最小消息类型。
- 用 Terraform 管理 Cloudflare 资源：zone 拉取（按 name 查 `sankabox.com`）、`remote-pi.sankabox.com` DNS 记录、worker 路由；S3 backend（参数化）。
- 用 wrangler 部署一个最小 hello worker，能 `wrangler dev` 本地起来，能被 Terraform 路由引用。
- 用 GitHub Actions 跑 lint + test + build（PR/push 触发）；Terraform 跑 `fmt -check` + `validate`（**不**做自动 apply）。
- 在仓库 README（或 `docs/getting-started.md`）写本地起步步骤。

## 非目标

- **不做自动部署**：CI 不跑 `terraform apply`、不跑 `wrangler deploy`、不发布 release；M1 只校验"能本地跑通、能在 CI 静态校验"。
- **不做 DO 业务逻辑**：worker 入口只回 hello，不接受 token 配对、不做转发；业务逻辑留给 M2。
- **不做 pi 进程管理**：bridge 包在 M1 可以是空壳（仅有 package.json + 一个 console.log 占位入口），不 spawn pi 子进程、不解析 JSONL、不持有 `SessionManager`。
- **不做 web UI**：web 包在 M1 只需要 vite 能起 dev server（带一个空 `<App />`），不接 WSS、不写聊天界面。
- **不做 systemd unit / bridge 安装方式**：roadmap §6 待决问题"bridge 分发与安装方式"归 M2，M1 不出 unit 文件、不出安装脚本。
- **不做 Pages 项目**：CF Pages 项目留给 M2（依赖 web 包实际能 build 出可部署产物）；M1 的 Terraform 只管 DNS + worker 路由。
- **不写 RemotePi 隧道协议规范文本**：规范落在 `docs/architecture/protocol/`，envelope 章节由 M2 PRD 补齐；本 PRD 只规划 `packages/shared` 的代码侧。M1 阶段 `docs/architecture/protocol/README.md` 的 envelope / 版本化 / 握手小节保持占位即可。

## 方案

### §1 仓库拓扑（落定 roadmap §6 "monorepo 细节"待决问题）

最终目录树：

```
RemotePi/
├── .github/
│   └── workflows/
│       ├── ci.yml                # lint + test + build（pnpm）
│       └── terraform.yml         # fmt -check + validate
├── .vscode/
│   ├── extensions.json         # 插件推荐（eslint/prettier/terraform）
│   ├── launch.json             # F5 调试：bridge / web / worker
│   ├── settings.json           # 保存即格式化 + eslint autofix
│   └── tasks.json              # dev:bridge / dev:worker / dev:worker:inspector / dev:web
├── .nvmrc                        # 22.23.1
├── package.json                  # 根：packageManager / engines / scripts / devDeps
├── pnpm-workspace.yaml           # workspaces: ['packages/*', 'worker']
├── pnpm-lock.yaml                # 由 pnpm install 生成，提交入库
├── tsconfig.base.json            # 严格模式 + ESM，所有包继承
├── eslint.config.js              # flat config（typescript-eslint + prettier）
├── .prettierrc.json              # 最小 prettier 配置
├── .gitignore                    # node_modules, dist, .wrangler, *.tfstate, backend.hcl
│
├── packages/
│   ├── shared/                   # 隧道信封 + pi RPC 转译（类型 + zod schemas）
│   │   ├── package.json          # name: @remotepi/shared, exports: { ".": { import: ... } }
│   │   ├── tsconfig.json         # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── index.ts          # 重导出
│   │       └── protocol/
│   │           ├── envelope.ts   # Envelope zod schema + 类型
│   │           ├── messages.ts   # Hello/Ping/Echo 消息 zod schemas
│   │           └── __tests__/    # vitest
│   ├── bridge/                   # Node 守护进程（M1 阶段空壳）
│   │   ├── package.json          # peerDependencies: @earendil-works/pi-coding-agent (optional)
│   │   ├── tsconfig.json
│   │   └── src/index.ts          # 启动时 console.log 占位
│   └── web/                      # React + Vite（M1 阶段空 App）
│       ├── package.json          # 依赖 vite + react + shared
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── src/main.tsx          # 渲染 <App />
│
├── worker/                       # Cloudflare Worker（M1：hello worker）
│   ├── package.json              # @remotepi/shared: workspace:*
│   ├── wrangler.toml             # name = "remotepi-hello", main = "src/index.ts"
│   ├── tsconfig.json
│   └── src/index.ts              # fetch 处理器返回 "hello"
│
├── infra/                        # Terraform
│   ├── versions.tf               # required_version ~> 1.15
│   ├── providers.tf              # cloudflare provider ~> 5.0
│   ├── backend.tf                # backend "s3" {} 空块（参数由 -backend-config 注入）
│   ├── variables.tf              # cloudflare_api_token, cloudflare_account_id（sensitive）
│   ├── data.tf                   # data "cloudflare_zone" "main" { name = "sankabox.com" }
│   ├── dns.tf                    # cloudflare_record remote-pi.sankabox.com (proxied A 192.0.2.1 占位)
│   ├── worker_route.tf           # cloudflare_worker_route → wrangler 部署的 worker
│   └── outputs.tf                # 输出 zone_id / route_id
│
└── docs/
    ├── architecture/protocol/README.md   # envelope/握手/版本化小节保持占位
    ├── getting-started.md               # 本地起步步骤（pnpm i / dev / terraform init）
    └── ...（既有文档不动）
```

**worker/ 与 packages/ 平级的最终结论**（roadmap §6 待决问题答案）：

- 保留 ADR-0002 描述的拓扑（`worker/` 与 `packages/` 平级、同属 pnpm workspace），原因：
  1. **构建工具链不同**：`packages/*` 用 tsc + vitest，worker 用 wrangler（内置 esbuild）—— 不同的 `package.json` 字段（`scripts` / `wrangler.toml`）、不同的产物形态（Node CJS/ESM vs Worker bundle）、不同的部署目标（用户服务器 vs CF 边缘）。
  2. **workspace 仍是统一的一张**：`pnpm-workspace.yaml` 同时声明 `packages/*` 和 `worker`，`pnpm -r build` 能跑全栈；`@remotepi/shared` 通过 `workspace:*` 协议被 bridge/web/worker 三方共享（见 §2）。
  3. **"可部署面"视觉对齐**：`packages/*` 是 Node/浏览器侧代码（bridge 给 systemd 用、web 给 Pages 用），`worker/` 是 CF 边缘代码；同层目录表达"两种部署目标"，符合 ADR-0002 的拓扑原意。
  4. 把 worker 塞进 `packages/` 会污染那个目录（多出一份 `wrangler.toml`、不同的 dev 流程），得不偿失。

**packages/shared 版本引用方式**（roadmap §6 待决问题答案）：

- worker / bridge / web 三处统一用 `workspace:*` 协议（pnpm 原生）：
  ```json
  // packages/bridge/package.json, packages/web/package.json, worker/package.json
  {
    "dependencies": {
      "@remotepi/shared": "workspace:*"
    }
  }
  ```
- **理由**：`workspace:*` 让 shared 始终引用工作区内的当前版本，零配置、零漂移；`pnpm install` 时自动建立 symlink（pnpm 默认行为），三个组件共享一份源码。固定版本号（如 `"0.1.0"`）在 monorepo 早期会频繁失效；固定到 npm registry 在 M1 阶段没有发布计划；`workspace:*` 是 pnpm 官方推荐的 monorepo 内引用方式。

### §2 共享包与协议雏形

- 包名：`@remotepi/shared`（在每个引用方的 package.json 中通过 `dependencies` 声明，pnpm 解析为 workspace 内的 symlink）。
- 入口：`packages/shared/src/index.ts` 重导出 `./protocol/*`。
- **运行时校验用 Zod**：
  - **理由**：envelope 必须做运行时校验——bridge 接 worker、worker 接 web、web 接 worker，三段链路任意一段收到消息都需要校验形状，否则畸形 JSON 立刻拖死进程。Zod 的 `z.infer<typeof Schema>` 直接生成 TS 类型，**类型与 schema 单一真相源**；体积小（~50KB，tree-shakable）、无 Node 专有依赖（worker 侧也能跑）；discriminated union 配合 envelope `kind` 字段做消息分派天然契合。
  - **否决的备选**：(a) 纯 TS 类型 + JSON Schema——双份维护，类型/schemas 漂移；(b) AJV——重、无类型推断；(c) TypeBox——类型能力强但生态比 Zod 弱，且生成的 JSON Schema 在 web 端不直接复用。
- **Envelope 雏形结构**（最小集，M2 会扩展）：
  ```ts
  // packages/shared/src/protocol/envelope.ts（示意，最终代码）
  export const PROTOCOL_VERSION = 1 as const;
  export type ProtocolVersion = typeof PROTOCOL_VERSION;

  export const Envelope = z.discriminatedUnion('kind', [
    HelloEnvelope,
    PingEnvelope,
    EchoEnvelope,
  ]);
  export type Envelope = z.infer<typeof Envelope>;
  ```
  - 字段：`v: ProtocolVersion`（字面量类型，未来用 `1 | 2` 演进）、`kind: 'hello' | 'ping' | 'echo'`、`id: z.string()`（消息 ID，用于请求-响应关联——M1 阶段不限长度、不做格式校验，M2 引入请求-响应关联时收紧为 `z.string().min(1)` 或 `z.string().uuid()`）、`payload: ...`（形态随 `kind` 变化，对应下方 `XxxPayload`）。
  - **命名约定**（M1 由 review 正式裁定，以实现命名为准——任务简报里的 `Hello` / `Ping` / `Echo` 仅指消息概念，代码层一律使用下述命名）：envelope 的 Zod schema 与推导类型同名（`HelloEnvelope` / `PingEnvelope` / `EchoEnvelope`）；payload 与 envelope 区分，Zod schema 带 `Schema` 后缀（`HelloPayloadSchema` / `PingPayloadSchema` / `EchoPayloadSchema`），推导类型不带后缀（`HelloPayload` / `PingPayload` / `EchoPayload`）。消费者按需 import：消费 envelope 时 import `Envelope` 或具体 `XxxEnvelope`；消费 payload 时 import `XxxPayload`。M2 扩展新 kind 时沿用该约定。
  - **`HelloEnvelope`**：连接建立后第一帧（web→worker、bridge→worker），载荷 `HelloPayload` 形状 `{ role: 'web' | 'bridge', token?: string }`（M1 可不带 token，M2 补齐）。
  - **`PingEnvelope` / `EchoEnvelope`**：最小双向探活，载荷分别为 `PingPayload`（空对象或 `{ nonce?: string }`）与 `EchoPayload`（`{ nonce: string }`）；M1 用于 e2e smoke test，M2 用于 keepalive。
  - **不实现** token 配对、业务消息、错误码——这些全部 M2 补。
- **导出格式**：`packages/shared` 用 `tsc` 编译为 ESM，输出 `dist/` + `.d.ts` + `src/` 源码（source 模式让 worker 端 wrangler 直接消费 TS，避免编译步骤）。`package.json` 用 `exports`：
  ```json
  {
    "name": "@remotepi/shared",
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "exports": {
      ".": "./src/index.ts"
    }
  }
  ```
  **理由**：M1 阶段三个消费方都跑 TS 直出（bridge 用 tsx、worker 用 wrangler 内置 esbuild、web 用 vite），无需先构建 shared；待 M2 末或 M3 切到"预构建产物"时再调整 exports。

### §3 构建与语言

- **TypeScript strict**，根 `tsconfig.base.json`：
  - `"target": "ES2022"`、`"module": "NodeNext"`、`"moduleResolution": "NodeNext"`、`"strict": true`、`"noUncheckedIndexedAccess": true`、`"esModuleInterop": true`、`"skipLibCheck": true`、`"isolatedModules": true`、`"verbatimModuleSyntax": true`。
  - 不在 base 里设 `outDir` / `rootDir` / `lib`（让各包按需覆盖；worker 不需要 DOM lib，web 需要）。
- **包级构建策略**：
  | 包 | 构建命令 | 开发命令 | 理由 |
  |----|----------|----------|------|
  | shared | `tsc --noEmit`（仅类型校验） | （无 dev） | M1 阶段导出源码，三个消费方各自编译；shared 自己只需保证类型能过 |
  | bridge | `tsc -p tsconfig.build.json` → `dist/` | `tsx watch src/index.ts` | bridge 是 Node 守护进程，无需打包；`tsx` 提供快速热重启，`tsc` 出可发布的 ESM 产物 + .d.ts |
  | web | `vite build` → `dist/` | `vite` | ADR-0002 已定 |
  | worker | `wrangler deploy --dry-run --outdir=dist` | `wrangler dev` | wrangler 内部用 esbuild，无需额外构建步骤；CI 用 `deploy --dry-run` 做产物校验 |
- **ESM 优先**：根 `package.json` 设 `"type": "module"`；bridge / shared 全程 ESM；worker 沿用 wrangler 默认 ESM；web 沿用 vite 默认 ESM。
- **顶层脚本**（`package.json` 的 `"scripts"`）：
  - `"dev"`: `pnpm -r --parallel run dev`
  - `"build"`: `pnpm -r run build`
  - `"lint"`: `eslint .`（flat config 作用整个 workspace）
  - `"test"`: `vitest run`（vitest 配置自动发现各包测试）
  - `"typecheck"`: `pnpm -r run typecheck`
  - `"format"`: `prettier --write .`
  - `"format:check"`: `prettier --check .`

### §4 测试（vitest 统一）

- 顶层 `vitest.config.ts`（或各包独立 config，本 PRD 倾向顶层一个）：`workspace` 模式列出 `packages/*` 和 `worker`，自动发现 `**/*.test.ts`。
- **最小可跑示例**放 `packages/shared/src/protocol/__tests__/envelope.test.ts`：
  - 测试 1：合法 hello envelope 通过 `Envelope.parse` 解析，类型推断为 `Hello`。
  - 测试 2：`v: 2` 被拒绝（版本不匹配抛 ZodError）。
  - 测试 3：`kind: 'unknown'` 被拒绝（discriminated union 兜底）。
- worker M1 阶段不写测试（hello worker 无逻辑可测），仅 `wrangler deploy --dry-run` 跑通即可；M2 再补 DO 单元测试。
- bridge M1 阶段不写测试（空壳），M2/M3 起补 JSONL 解析、spawn 生命周期测试。

### §5 Lint 与 Format

- **eslint flat config**（`eslint.config.js`，ESLint ≥ 9）：
  - 插件：`typescript-eslint`（parser + plugin 二合一）、`eslint-config-prettier`（必须放最后，关掉与 prettier 冲突的规则）。
  - 规则：`recommended-type-checked` + `recommended-style`；`no-console: 'warn'`（bridge 允许 `console.warn/error`，由 override 放开）；`no-unused-vars` 用 typescript-eslint 的 `no-unused-vars`（带类型感知）。
  - **忽略**：`dist/`、`.wrangler/`、`node_modules/`、`*.gen.ts`（Terraform / wrangler 生成的类型）。
- **prettier**（`.prettierrc.json`）：`{"singleQuote": true, "trailingComma": "all", "printWidth": 100, "semi": true}`。最小集，避免格式化器选型争议。

### §6 pi 版本锁定策略（roadmap §6 待决问题——依赖锁定半边）

- bridge 的 `package.json` 用 **`peerDependencies` + `optional`** 的组合：
  ```json
  {
    "peerDependencies": {
      "@earendil-works/pi-coding-agent": "^0.84.4"
    },
    "peerDependenciesMeta": {
      "@earendil-works/pi-coding-agent": { "optional": true }
    }
  }
  ```
- **理由**：
  1. bridge **生产部署假设 pi 由宿主全局安装**（systemd unit 启动时通过 PATH 找 `pi`）；bridge 自己 npm install 时不需要（也不应该）把 pi 拉到 `node_modules`——那会让 bridge 装出两份 pi（一份全局、一份本地），版本漂移、升级不便、产物体积膨胀。
  2. `peerDependencies` 在 npm/pnpm 都会发出"运行时需要外部满足"的元数据信号；`optional: true` 让 `pnpm install` 在 host 没有 pi 时不报错（M1 阶段 bridge 还是空壳，根本没 import pi，optional 正好合适）。
  3. 不放 `devDependencies`：bridge 单测和本地开发要用 pi 时显式 `pnpm add -D @earendil-works/pi-coding-agent` 或用全局安装的 node_modules 软链；不放进 dependencies 避免被人误以为 bridge 自带 pi。
  4. 不放 `dependencies`：bridge 发布时**不应该**把 pi 一起 npm publish——bridge 是给本机跑的守护进程，pi 是 host 运维责任。
- **README/`docs/getting-started.md` 必须明确**："运行 bridge 前确保 `pi`（v0.84.4+）已在 PATH 中，全局安装命令：`npm i -g @earendil-works/pi-coding-agent`"。
- **不**在 M1 给兼容性矩阵——roadmap §6 注明"兼容性承诺留 M3"，M1 只把"如何声明外部依赖"这个 schema 定下来。

### §7 Terraform 细节

| 项 | 选择 | 理由 |
|----|------|------|
| Terraform 版本 | `~> 1.15` | use_lockfile（S3 原生 state 锁）需 ≥1.10；本地与 CI 统一 1.15 线（实测本地 1.15.8），不需要 DynamoDB 表 |
| Cloudflare provider | `~> 5.0` | 5.x 是当前 major；具体小版本在首次 `terraform init` 时由 lock file 钉住 |
| Backend | S3 + `use_lockfile = true` | 与 ADR-0002 的 IaC 选型一致；参数化见下 |
| required_version 锚定 | `terraform { required_version = "~> 1.15" }` | 锁大版本线，避免 2.x 行为变更 |
| Zone 拉取 | `data "cloudflare_zone" "main" { filter = { name = "sankabox.com", account = { id = var.cloudflare_account_id }, match = "all" } }` | 5.x 必须用 `filter` 块（顶层 `name =` 已在 4.x 弃用）；zone_id 不进 git、PR 友好、自动适配 CF 账户里的真实 zone；`filter.account.id` 嵌套结构防御同名 zone 跨账户误匹配 |
| 敏感变量 | `TF_VAR_cloudflare_api_token`、`TF_VAR_cloudflare_account_id` | 全程不进 `.tf` 文件、不进 backend 配置、不进 CI secrets 以外的明文 |
| Backend 参数化 | `backend "s3" {}`（空块） + `terraform init -backend-config=backend.hcl` | bucket/region 不进 git；`backend.hcl` 加进 `.gitignore`；CI 用环境变量或 secret 注入等价配置 |
| State 加锁 | `use_lockfile = true`（S3 原生） | 不维护 DynamoDB；TF ≥ 1.10 原生支持 |
| 资源最小集（M1） | (1) `cloudflare_dns_record`（5.x 复数化，4.x 是 `cloudflare_record`）：`remote-pi.sankabox.com` 的 proxied A 记录占位（指向 `192.0.2.1` 文档保留地址，等 worker 真接管时再改）；(2) `cloudflare_workers_route`（5.x 复数化，4.x 是 `cloudflare_worker_route`）：`remote-pi.sankabox.com/*` → wrangler 部署的 worker 名（`remotepi-hello`，与 `worker/wrangler.toml` 的 `name` 对齐），字段 `script`（5.x 由 4.x 的 `script_name` 改名为 `script`） | M1 只需要"DNS + 路由到位"；worker 本体用 `wrangler deploy` 上传（不走 TF，避免双写同一资源） |
| 资源归属 | DNS / route 在 TF；worker script 在 wrangler | TF 关注"路由骨架与 DNS"，wrangler 关注"代码上传"；避免两边抢同一资源造成漂移 |
| cloudflare provider 5.x 适配要点 | (a) DNS 资源 `cloudflare_record` → `cloudflare_dns_record`（复数化，4.x 资源名已重命名）；(b) worker route 资源 `cloudflare_worker_route` → `cloudflare_workers_route`（复数化），字段 `script_name` → `script`；(c) `cloudflare_zone` data source 顶层 `name =` 参数废弃，必须用 `filter = { name = ..., account = { id = ... }, match = ... }` 块结构（`filter.account.id` 是嵌套结构而非 `filter.account_id`）；(d) provider 块不再接受 `account_id`（4.x 已删除），账户由 API token 隐式解析；防御性 account 约束下放到 data source 的 `filter.account.id`（避免 API token 跨账户时同名 zone 误匹配） | 5.x 与 4.x 的关键差异；按旧（4.x）文档直接复制粘板会触发 401 / 422 / Unknown resource 等报错，必须以本表为准 |

**M1 阶段 Terraform 不做的事**：
- 不 `apply`（CI 只跑 `fmt -check` + `validate`；首次 `apply` 由用户本地跑，验证无凭据也能 init/plan/validate）。
- 不管理 Pages 项目（Pages 留给 M2，依赖 web 包产出可部署 bundle）。
- 不导入已有 zone（`data` 而非 `resource`，无需 import）。

### §8 GitHub Actions CI 骨架

- 两个 workflow，**单 job 优先，不上矩阵**（M1 包少、构建快，矩阵只会拖时间；M2 起包之间构建时间分化再切矩阵）：

  **`.github/workflows/ci.yml`**（PR/push 触发）：
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    ci:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4   # 版本读根 package.json 的 packageManager 字段
        - uses: actions/setup-node@v4
          with:
            node-version-file: .nvmrc
            cache: pnpm
        - run: pnpm install --frozen-lockfile
        - run: pnpm run lint
        - run: pnpm run typecheck
        - run: pnpm run test
        - run: pnpm run build
  ```

  **`.github/workflows/terraform.yml`**（PR/push 触发，**不**需要 secret）：
  ```yaml
  name: Terraform
  on: [push, pull_request]
  jobs:
    terraform:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: hashicorp/setup-terraform@v3
          with: { terraform_version: 1.15.x }
        - working-directory: infra
        - run: terraform fmt -check -recursive
        - run: terraform init -backend=false   # 不连 S3，纯本地校验
        - run: terraform validate
  ```

- **缓存**：`pnpm` 缓存由 `actions/setup-node` 内置（`cache: pnpm` 配 `pnpm/action-setup`）；Terraform 不需要缓存（`fmt -check` + `validate` 不下载 provider，用 `-backend=false` 跳过 provider 拉取）。
- **pnpm 版本唯一真相源**：根 `package.json` 的 `packageManager` 字段（见 §9），CI 不再向 `pnpm/action-setup` 重复传 `version` 输入——v4 action 在同时收到 `version` 输入与 `packageManager` 字段时会报 "Multiple versions of pnpm specified"，故 workflow 一律让 action 从 `packageManager` 自动解析。
- **凭据**：CI **不**持有 Cloudflare / AWS 凭据；本地 `apply` 用户自跑。

### §9 版本锚定与根 package.json

- `packageManager` 字段：`"packageManager": "pnpm@10.32.1"`（本地实测版本）。
- `engines`：`"engines": { "node": ">=22 <23", "pnpm": ">=10 <11" }`。
- `.nvmrc`：`22.23.1`（与用户本机一致）。
- **理由**：`packageManager` 被 Corepack 与现代 pnpm 原生支持；`.nvmrc` 给 IDE / 人类读；`engines` 是 npm/pnpm 安装时的硬约束（pnpm 默认 strict，会因版本不符报错）。三层冗余换取"无论用 Corepack、nvm、还是直接 npx pnpm"都拿到一致版本。

### §10 用户侧凭据清单（M1 一次性提供）

> 用户（owner）需要准备的本地凭据，**不**进 git、不进 CI secret。M1 阶段这些凭据只用于本地 `terraform init/plan/apply` 与 `wrangler deploy`。

| 凭据 | 用途 | 范围 / 最小权限 |
|------|------|----------------|
| Cloudflare API Token | Terraform 管理 DNS + worker 路由 | 模板：Zone DNS Edit（zone: sankabox.com）+ Account Workers Routes: Edit + Account Workers Scripts: Read（创建 route 时 API 会校验 script 是否存在，故需 Read 权限读取 worker 列表）。**不要给 Account-level: Workers Scripts: Edit**——M1 阶段 worker script 由 wrangler 上传，不由 TF 管理 |
| Cloudflare Account ID | `TF_VAR_cloudflare_account_id` | 公开值，但走 env 不进 git |
| AWS Access Key ID + Secret（具备 S3 写权限） | Terraform S3 backend（state + lock file） | 最小权限：`s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`、`s3:ListBucket`，限定到 state bucket |
| S3 Bucket 名 + Region | Terraform backend 配置（`backend.hcl`） | 用户创建好空 bucket，启用 versioning（state 历史回滚） |

**GitHub Secrets**（M1 **不**需要）：M1 不做自动 apply，故 GH Actions 不持有上述凭据。M2 起 apply 进 CI 时再加 `CF_API_TOKEN` / `CF_ACCOUNT_ID` / AWS 凭据为 repo secret。

**首次拉取后用户需执行**（写进 `docs/getting-started.md`）：
0. （可选）VS Code 用户：安装推荐插件后直接用任务面板/F5 启动各组件
1. `pnpm install`（自动通过 packageManager 字段切到正确 pnpm）
2. `cp infra/backend.hcl.example infra/backend.hcl`，填 bucket / region（**该文件 `.gitignore`**）
3. `cd infra && terraform init`
4. 本地首次 `wrangler login` + `wrangler deploy`（hello worker 上线）
5. `terraform plan` 看 DNS + route 变更，`terraform apply` 生效

### §11 本地调试与一键启动（.vscode）

- **目标**：在 VS Code 里通过任务面板或 F5 一键启动任意组件做本地测试，三件套（bridge / worker / web）无需记忆命令、断点能命中。
- **`tasks.json` 四个后台任务**（均为 `isBackground: true`，出问题单独看 OUTPUT）：
  - `dev:bridge`：`pnpm --filter @remotepi/bridge dev`（即 `tsx watch src/index.ts`，cwd 自动落到 `packages/bridge`）。
  - `dev:worker`：`pnpm --filter worker dev`（即 `wrangler dev`）。
  - `dev:worker:inspector`：`pnpm --filter worker dev:inspector`（即 `wrangler dev --inspector-port=9229`）。
  - `dev:web`：`pnpm --filter @remotepi/web dev`（即 `vite`，监听 `http://localhost:5173`）。
- **`launch.json` 三个配置**：
  1. `bridge: debug (tsx)` — `type: node`，`runtimeExecutable` 指向仓库根 `${workspaceFolder}/node_modules/.bin/tsx`，`args: ["src/index.ts"]`，`cwd: ${workspaceFolder}/packages/bridge`，可打断点。
  2. `web: debug (chrome)` — `type: chrome`，`url: http://localhost:5173`，`preLaunchTask: dev:web`，配 `serverReadyAction: "openExternally"` 自动开浏览器，断点命中 vite 编译后的源码。
  3. `worker: attach inspector` — `type: node`，`request: attach`，`port: 9229`，`address: localhost`，`preLaunchTask: dev:worker:inspector`，`restart: true`（workerd 支持 inspector 协议，断点命中 worker 源码）。
- **`settings.json` 工作区配置**：
  - `editor.formatOnSave: true`、默认格式化器 `esbenp.prettier-vscode`。
  - `editor.codeActionsOnSave` 含 `{ "source.fixAll.eslint": "explicit" }`（eslint flat config 自动识别）。
  - `files.eol: "\n"`，避免 win/mac 行尾漂移。
- **`extensions.json` 推荐插件**：
  - `dbaeumer.vscode-eslint`、`esbenp.prettier-vscode`、`hashicorp.terraform`。
- **配套改动**（任务 01 落地）：`worker/package.json` 增加 `dev:inspector` script（`wrangler dev --inspector-port=9229`），三个 launch 配置的 `${workspaceFolder}` 引用都能解析到正确路径。
- **约束**：`.vscode/` 下文件**不**写机器相关绝对路径（macOS / WSL / 容器路径全不一样），全部用 `${workspaceFolder}` 变量或任务 cwd 自动推导；否则换机即坏。

## 验收标准

### 仓库与构建

- [ ] `pnpm install` 在仓库根一次成功，所有 workspace 包就绪（无 peer dep 错误）
- [ ] `pnpm -r build` 通过：shared typecheck、bridge tsc 出 `dist/`、web vite 出 `dist/`、worker wrangler dry-run 出 `dist/`
- [ ] `pnpm run lint` 通过（flat config 无 warning/error）
- [ ] `pnpm run typecheck` 通过（strict + noUncheckedIndexedAccess）
- [ ] `pnpm run test` 通过，至少 `envelope.test.ts` 三个用例全绿
- [ ] `pnpm run format:check` 通过
- [ ] `.nvmrc` 内容为 `22.23.1`；根 `package.json` 含 `packageManager` 与 `engines` 字段

### Shared 包

- [ ] `packages/shared/src/protocol/envelope.ts` 定义 Zod discriminated union（kind ∈ {hello, ping, echo}），顶层含 `v: 1` 字面量
- [ ] 所有消费者（bridge / web / worker）的 `package.json` 通过 `workspace:*` 引用 `@remotepi/shared`
- [ ] 三个消费者都能 `import { Envelope, PROTOCOL_VERSION } from '@remotepi/shared'` 拿到类型与 schema

### Worker

- [ ] `wrangler dev` 本地起 `worker/src/index.ts`，访问 `http://localhost:8787/` 返回 hello
- [ ] `wrangler deploy --dry-run` 产出 `dist/` 无错
- [ ] `worker/wrangler.toml` 的 `name = "remotepi-hello"` 与 Terraform 的 `cloudflare_worker_route` 引用的 worker 名一致

### Terraform

- [ ] `cd infra && terraform fmt -check -recursive` 通过
- [ ] `cd infra && terraform init -backend=false && terraform validate` 通过
- [ ] `infra/data.tf` 用 `data "cloudflare_zone"` 按 name 查 `sankabox.com`（不是硬编码 zone_id）
- [ ] `infra/worker_route.tf` 创建 `remote-pi.sankabox.com/*` 路由指向 `remotepi-hello`
- [ ] `infra/backend.tf` 是空 `backend "s3" {}` 块，无明文 bucket/region
- [ ] `infra/variables.tf` 声明 `cloudflare_api_token` 为 `sensitive = true`
- [ ] `required_version = "~> 1.15"`；S3 backend 使用 `use_lockfile = true`（在 init 时通过 `-backend-config` 注入）
- [ ] 用户本地首次 `terraform init`（带 `-backend-config=backend.hcl`）+ `plan` + `apply` 成功创建 DNS 记录 + worker 路由
- [ ] `.gitignore` 含 `backend.hcl`、`*.tfstate`、`*.tfstate.backup`、`.terraform/`

### CI

- [ ] `.github/workflows/ci.yml` 在 PR/push 上触发，依次跑 `install --frozen-lockfile`、`lint`、`typecheck`、`test`、`build`
- [ ] `.github/workflows/terraform.yml` 在 PR/push 上跑 `fmt -check` + `init -backend=false` + `validate`，**不**需要任何 secret
- [ ] CI 使用 `actions/setup-node@v4` 的 `node-version-file: .nvmrc` 锁 Node 22
- [ ] CI 使用 `pnpm/action-setup` 读根 `package.json` 的 `packageManager` 字段定位 pnpm 版本（不传 `version` 输入），与 `setup-node` 的 `cache: pnpm` 形成 pnpm 缓存命中
- [ ] 两个 workflow 在空仓库首推时全绿

### 本地调试（.vscode）

- [ ] `.vscode/tasks.json` 四个 dev 任务（`dev:bridge` / `dev:worker` / `dev:worker:inspector` / `dev:web`）均 `isBackground: true`，能从任务面板单独启动并各自有独立 OUTPUT
- [ ] `.vscode/launch.json` 三个配置全部可用：bridge 断点可命中 `packages/bridge/src/index.ts`；web 启动后自动开 chrome 并可断点命中；worker 经 inspector 附加后断点可命中 `worker/src/index.ts`
- [ ] `.vscode/settings.json` 保存触发 prettier + eslint autofix；`extensions.json` 含三个推荐插件（eslint / prettier / terraform）
- [ ] `.vscode/` 下所有文件**不含**机器相关绝对路径，全部用 `${workspaceFolder}` 变量引用
- [ ] `worker/package.json` 含 `dev:inspector` script（`wrangler dev --inspector-port=9229`），与 `launch.json` 中 worker attach 配置的 9229 端口一致

### 文档与起步

- [ ] `docs/getting-started.md` 写明：clone → `pnpm install` → 各包 dev 命令 → `wrangler dev` → `terraform init/plan/apply` 的本地完整步骤
- [ ] `docs/getting-started.md` 包含"运行 bridge 前需全局安装 pi v0.84.4+"的提示（与 §6 的 peerDependencies 声明呼应）
- [ ] `README.md`（仓库根）补一句"参见 `docs/getting-started.md` 开始本地开发"
- [ ] `docs/architecture/protocol/README.md` 的 envelope / 握手 / 版本化小节**保持占位文本不变**（M2 补齐；M1 不抢写规范）

### 协议雏形（最小可验）

- [ ] `pnpm --filter @remotepi/shared test` 跑通：合法 hello 通过、`v: 2` 拒绝、`kind: 'unknown'` 拒绝
- [ ] worker 的 `src/index.ts` 演示性 import `@remotepi/shared`（哪怕只是为了类型层面证明引用通）；M1 可以不真用 Envelope.parse（hello worker 只回字符串），但 import 不能报错

### 待决问题出 PR 前必须显式敲定（本 PRD 已完成）

- [x] monorepo 细节：`worker/` 与 `packages/` 平级（§1 给出理由）
- [x] shared 版本引用：`workspace:*`（§1 给出理由）
- [x] pi 版本依赖锁定：peerDependencies + optional（§6 给出理由）
- [ ] （defer）pi 兼容性承诺 → M3
- [ ] （defer）bridge 分发方式 → M2
- [ ] （defer）token 安全细节 → M2
- [ ] （defer）CF 套餐配额 → M2
- [ ] （defer）断线重连增量 → M3
- [ ] （defer）多 web 端并发语义 → M3
