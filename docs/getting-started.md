# 本地起步

本指南面向要在本地把 RemotePi 跑起来的人：clone 完之后跟着下面的步骤逐条执行即可。完成全部步骤后你应该能在 `http://localhost:8787/`（worker）、`http://localhost:5173/`（web）拿到响应，并能把 worker 部署到 Cloudflare。

> 文档目录：[[README.md]] ｜ 路线图：[[roadmap.md]] ｜ M1 PRD：[[prds/m1-infrastructure.md]]

---

## 1. 前置依赖

| 工具 | 版本 | 说明 |
|------|------|------|
| Node.js | 22.x（精确到 `22.23.1`） | 仓库根的 `.nvmrc` 已锁，强烈建议用 nvm 安装 |
| pnpm | 10.x（精确到 `10.32.1`） | 根 `package.json` 的 `packageManager` 字段；通过 Corepack 自动切到正确版本 |
| Terraform | `~> 1.15`（实测 1.15.8） | 仅 Cloudflare 资源管理需要，**未做 CF 资源前可不装** |
| Cloudflare 账户 + 自有域名 | — | `wrangler login` 用 OAuth，CF API Token 用于 Terraform |

### 1.1 安装 Node 与 pnpm

```bash
# Node 22（推荐 nvm；其他方式如 asdf / volta 也行）
nvm install       # 读 .nvmrc 自动选 22.23.1
nvm use

# pnpm 10 — 推荐用仓库自带的 packageManager 字段配合 Corepack
corepack enable
corepack prepare pnpm@10.32.1 --activate

# 验证
node --version    # v22.23.1
pnpm --version    # 10.32.1
```

如果不想用 Corepack，也可以直接 `npm i -g pnpm@10.32.1`。**版本必须落在 `>=10 <11` 区间**，否则根 `engines` 会拒绝安装。

### 1.2 （可选）安装 Terraform

```bash
# macOS（推荐 tfenv，跨小版本无痛升级；或直接装官方 1.15.x 二进制二选一）
brew install tfenv
tfenv install 1.15.8
tfenv use 1.15.8

# 项目根可加 .terraform-version 文件写入 1.15.8 实现持久化
# （tfenv / asdf 等版本管理工具会自动切换目录级 Terraform 版本）

# 或直接下载官方 1.15.x 二进制
# https://developer.hashicorp.com/terraform/install
terraform version   # Terraform v1.15.x
```

只在「要把 CF 资源交由 Terraform 管」时才需要。

---

## 2. 克隆与安装

```bash
git clone <your-fork-url>RemotePi
pnpm install
```

`pnpm install` 会自动：

- 通过 `packageManager` 字段校验 pnpm 版本；
- 在 `packages/*` 与 `worker/` 之间建立 `workspace:*` 软链；
- 触发 `engines` 检查（Node ≥22 <23、pnpm ≥10 <11）。

成功标志：根 `node_modules/` 下有 `.pnpm/`、各包 `node_modules/` 下有 `@remotepi/shared` 软链。

---

## 3. 本地开发：每个包怎么跑

**首次本地联调建议按 §3.4 用三个终端分别起 worker / bridge / web**，各服务输出独立可见，便于看日志与排查；需要断点再按 §4 F5 调试。只想让所有 dev 一起跑也行：`pnpm dev`（根脚本即 `pnpm -r --parallel run dev`，但所有输出混在同一流）。

### 3.1 bridge — `tsx watch`

```bash
pnpm --filter @remotepi/bridge dev
```

M1 阶段是空壳，只 console.log 一行占位。**真正运行 bridge 前**请确保 `pi` v0.84.4+ 已全局安装并在 PATH：

```bash
npm i -g @earendil-works/pi-coding-agent
pi --version   # 应 ≥ 0.84.4
```

bridge 在 M1 通过 `peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.4" }` + `optional: true` 声明外部依赖——它**不会**自带 pi，宿主全局安装是事实约束。M2 起 bridge 才会 spawn 子进程调用 pi。

### 3.2 web — Vite

```bash
pnpm --filter @remotepi/web dev
```

默认 `http://localhost:5173/`，M1 是空 `<App />`。

### 3.3 worker — `wrangler dev`

```bash
pnpm --filter worker dev
```

默认 `http://localhost:8787/`：
- `GET /` 返回 web SPA（M2 修订：网页合并进主域后由 Worker Static Assets 接管，`GET /` 让位网页首页）
- `/healthz` 返回 `ok`（ops 探活，替代 M1 hello）
- `/web` `/bridge` `/healthz` 是 WS upgrade / 探活入口（`run_worker_first = ["/web", "/bridge", "/healthz"]`，数组形式，强制先进 worker）
- `PROTOCOL_VERSION` 仍是 `@remotepi/shared` 导出的锁版协议号

> M1 期间 `GET /` 返回 `hello from remotepi worker v{N}`（N = `PROTOCOL_VERSION`）；M2 修订后变 web 首页与 `/healthz`。M1 的 hello 文案在代码仓库历史里可查（任务 [[tasks/m1/03-hello-worker.md|03]]），不回改。

需要 workerd inspector（VS Code 调试或 `chrome://inspect` 抓 worker 源码）：

```bash
pnpm --filter worker dev:inspector
# 即 wrangler dev --inspector-port=9229
```

> **端口被占用**：`wrangler dev` 默认绑 8787，被占用就报 `EADDRINUSE`。换端口：把 worker `package.json` 的 `dev` script 改成 `wrangler dev --port 8788`（或直接 `wrangler dev --port 8788` 一次性用）；验证完改回默认配置即可。

### 3.4 M2 三端齐起（本地联调 / 验收准备）

M2 三端联调（web ↔ worker ↔ bridge）需要三个终端各起一个 dev 服务。**worker 先起**（触发 DO `new_sqlite_classes` migration），再起 bridge（生成 token），最后起 web（粘 token 进 URL）。

**终端 A — worker**

```bash
pnpm --filter worker dev
# 首次起会触发 new_sqlite_classes migration，wrangler 打 "Applying migrations" 后就绪
# 默认 http://localhost:8787/；`GET /` 返回 web SPA（M2 修订：hello 让位网页首页，探活挪到 `/healthz`）；`/web` `/bridge` 是 WS upgrade 入口（run_worker_first 走 worker）
```

**终端 B — bridge**

> ⚠️ **不带参数时 bridge 默认连生产域 `wss://remote-pi.sankabox.com/bridge`**——生产 route 已在 M2 部署 `remotepi-worker`，bridge 会连生产 DO 房间（与本机 worker 隔离；web 端表现为 `online:false`、手动 ping 全部超时）。本地联调务必显式指定 worker URL（下面两条命令任选其一，效果相同）：

```bash
pnpm --filter @remotepi/bridge dev -- --worker-url ws://localhost:8787/bridge
REMOTEPI_WORKER_URL=ws://localhost:8787/bridge pnpm --filter @remotepi/bridge dev
```

**期望 stdout**（与实机一致，逐字）：

- 指定本地 URL（两条任一）时打三行：
  ```
  [bridge] info token: xCwytpk-…
  [bridge] info share URL: https://remote-pi.sankabox.com/#xCwytpk-…
  [bridge] info worker URL: ws://localhost:8787/bridge
  ```
- 不带参数（生产默认）时第三行变为：
  ```
  [bridge] info worker URL: wss://remote-pi.sankabox.com/bridge
  ```
  并额外多一行 hint：
  ```
  [bridge] info hint: this is the production default — for local dev pass -- --worker-url ws://localhost:8787/bridge
  ```
- 连接成功后会再打 `connected to <url>`；断连重连日志格式为 `disconnected from <url> (code=<n>, reason='<r>') — reconnecting in <ms>ms (attempt <n>)`。

> **bridge 每次重启都会生成新 token**——网页端要用新打印的 `share URL`（或 token）。把旧 URL 粘进新启动的 browser 等于连一个不存在的 token，handshake 会失败。
>
> **share URL 现在指向主域 `https://remote-pi.sankabox.com/#<token>`**（2026-09-05 起改主域，原 `web.remote-pi.sankabox.com` 已作废；网页与 worker 现合并到主域的 Worker Static Assets）。

**终端 C — web**

```bash
pnpm --filter @remotepi/web dev
# 默认 http://localhost:5173/
```

把终端 B 的 `share URL` 复制出来（dev 用 `http://localhost:5173/#<token>` 替换域名也行），浏览器开：

```
http://localhost:5173/#<token>
```

**验证要点**（按 [[prds/m2-tunnel.md#验收清单|M2 PRD 验收清单]]）：

- **StatusBar 绿** — 状态条出现 `online` + `bridge_status.reason='connected'`，表示 handshake 通过。
- **PingTester 往返** — 点 PingTester 发 `control/ping`，收到 `control/pong` 显示 nonce 与 RTT（ms）。
- **双 tab 广播** — 开两个 tab 都粘同一 token，两边 `<BroadcastLog />` 互收对方/bridge 消息。
- **杀 bridge 变离线** — 在终端 B 按 `Ctrl+C`，两 tab 5 秒内 StatusBar 变 `offline` + `reason='closed'`。
- **心跳判死** — 在终端 B `kill -STOP $(pgrep -f '@remotepi/bridge')`，两 tab 90 秒内 `reason='stale'`；再 `kill -CONT` → 自动重连恢复 `connected`。

> bridge 端 PID 取法：`pgrep -f 'remotepi/bridge'` 或 `ps aux | grep bridge` 都行；`tsx watch` 起的进程组是同一棵，`kill -- -<pgid>` 可一并清掉子进程。

---

## 4. VS Code 调试（launch.json）

`.vscode/` 下只保留调试入口三件套：`launch.json`（三个 F5 配置）/ `settings.json` / `extensions.json`。**不再有 `tasks.json`** —— Run Task / 任务面板一键起 dev 的路径已裁掉（不需要「一按全起」和「三端全起」）。所有 dev 服务一律按 §3 / §3.4 用终端手动起：

| 服务 | 命令（终端手动起） | 见 |
|------|-------------------|----|
| bridge | `pnpm --filter @remotepi/bridge dev` | §3.1 |
| web | `pnpm --filter @remotepi/web dev` | §3.2 |
| worker（普通） | `pnpm --filter worker dev` | §3.3 |
| worker（带 inspector，断点用） | `pnpm --filter worker run dev:inspector` | §3.3 |

### 4.1 一次性的插件安装

打开 `.vscode/extensions.json`，VS Code 会推荐三个插件：

- `dbaeumer.vscode-eslint`
- `esbenp.prettier-vscode`
- `hashicorp.terraform`

点「Install Workspace Recommended Extensions」一键装。装完后保存 `.ts` 自动 prettier + eslint autofix。

### 4.2 F5 三个配置

F5 前确保**对应的 dev 服务已经在终端里起好**（命令看上表）；F5 本身不 `preLaunchTask`、不自动开服务，**不会和终端里手起的服务抢端口**。

| 配置 | 用法 | 前置（必须先在终端起好） | 备注 |
|------|------|--------------------------|------|
| `bridge: debug (tsx)` | 直接 F5 由 tsx 调试器拉起 bridge，输出落在 VS Code `integratedTerminal` | 无（不需要先起 bridge） | 调试器启动的 bridge 与终端 `pnpm --filter @remotepi/bridge dev` 手起的 bridge **不要双开** —— 会争同一个 bridge slot |
| `web: debug (chrome)` | F5 只负责打开 Chrome 并接断点，vite 服务由前置命令提供 | 先起 `pnpm --filter @remotepi/web dev`（`http://localhost:5173/`） | 断点命中 vite 编译后的 web 源码 |
| `worker: attach inspector` | F5 attach 到 workerd inspector（端口 9229），断点命中 `worker/src/index.ts` | 先起 `pnpm --filter worker run dev:inspector`（即 `wrangler dev --inspector-port=9229`） | 端口 9229 与前置命令必须对齐 |

---

## 5. 部署 worker 到 Cloudflare

```bash
# 一次性登录（OAuth；会开浏览器）
pnpm --filter worker exec wrangler login

# 部署 worker（M1 名 remotepi-hello / M2 起名 remotepi-worker，由 worker/wrangler.toml 的 name 决定）
pnpm --filter worker run deploy:cf
# 等价于 wrangler deploy，会先 build web（M2 阶段 web 构建作为前置依赖，供 Static Assets 托管）
```

部署成功后 wrangler 会打 worker URL（`https://remotepi-worker.<your-subdomain>.workers.dev`），curl 一下确认（M2 起需走主域验证，详见 §10）：

```bash
# M1 阶段
curl https://remotepi-hello.<your-subdomain>.workers.dev/
# hello from remotepi worker v1

# M2 阶段（主域 route 切换后）
curl https://remote-pi.sankabox.com/healthz
# ok
```

M1 阶段 worker 只回 hello，没有业务逻辑；M2 起换成 WebSocket / DO 路由 + Worker Static Assets 托管 SPA（网页合并进主域，详见 §10）。M1 的 hello worker `remotepi-hello` 在 M2 部署后不再被 route 引用，可在 CF Dashboard 手动删除。**生产部署建议走 CD**（§10），本地手动部署保留为备选。

---

## 6. Terraform：管理 Cloudflare 资源（DNS + worker 路由）

> 任务 04（[[tasks/m1/04-terraform-cloudflare.md]]）已落地——`infra/` 目录、backend.hcl.example、`cloudflare_dns_record` / `cloudflare_workers_route` 资源已就位。本节可执行；步骤与 `infra/` 实际文件一致（`cp infra/backend.hcl.example infra/backend.hcl` → `terraform init -backend-config=backend.hcl` → `plan`/`apply`）。

### 6.1 你需要准备的凭据

| 凭据 | 用途 | 最低权限 / 说明 |
|------|------|---------------|
| Cloudflare API Token | TF 管理 DNS + worker 路由；M2 起还要供 `wrangler deploy` 上传 worker script | **M2（推荐）**：Edit zone DNS（zone: sankabox.com）+ Account-level: Workers Routes: Edit + Account-level: **Workers Scripts: Edit**——`wrangler deploy` 在 M2 需 Write 权限上传 script；参见 §10。**M1 严格细分**：TF 只需 Workers Scripts: Read（仅验证 route 引用的 script 名存在；script 上传走 `wrangler login` OAuth）；如纯 TF 使用可保留该限制 |
| Cloudflare Account ID | `TF_VAR_cloudflare_account_id` | 公开值，走 env 不进 git |
| AWS Access Key ID + Secret | TF S3 backend（state + lock file） | 最小权限：`s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` / `s3:ListBucket`，限定到 state bucket |
| 自备 S3 Bucket | state 落地 | 用户自建空 bucket，**启用 versioning**（state 历史回滚） |
| S3 Region | backend 配置 | bucket 所在区域（如 `us-east-1`） |

### 6.2 配置 backend

```bash
# 1. 复制示例
cp infra/backend.hcl.example infra/backend.hcl

# 2. 编辑 infra/backend.hcl，填 bucket / region / key / use_lockfile
#    真实 backend.hcl 已加入 .gitignore，不会被提交
#    模板里含 AWS 凭据占位（access_key / secret_key），一并填掉即可，无需另设环境变量；
#    想继续走 env / ~/.aws/credentials 默认链也行，把这两行留空或删掉即可。
```

### 6.3 注入凭据

**（a）推荐——AWS 写进 backend.hcl，CF token 走 env 或 terraform.tfvars：**

```bash
# AWS：填进 infra/backend.hcl 的 access_key / secret_key（见 §6.2）
#      该文件已被 .gitignore 排除（backend.hcl + *.tfvars 两条规则），不入库。

# Cloudflare token：二选一
#   方案 1：环境变量
export TF_VAR_cloudflare_api_token="cf-token"
export TF_VAR_cloudflare_account_id="cf-account-id"

#   方案 2：infra/terraform.tfvars（推荐，从模板复制后填值）
cp infra/terraform.tfvars.example infra/terraform.tfvars
# 然后编辑 infra/terraform.tfvars：
#   cloudflare_api_token  = "你的token"
#   cloudflare_account_id = "你的account id"
# terraform.tfvars 已被 .gitignore（*.tfvars 规则）排除，不入库。
```

**（b）全环境变量路线（备选，与原写法等价）：**

```bash
# Cloudflare
export TF_VAR_cloudflare_api_token="cf-token"
export TF_VAR_cloudflare_account_id="cf-account-id"

# AWS 也可走 ~/.aws/credentials 的 [default] / 自定义 profile，无需任何环境变量。
```

> AWS key/secret 的优先级（Terraform 文档）：`backend.hcl` 的 `access_key` / `secret_key` > 环境变量 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` > `~/.aws/credentials` profile > EC2 instance / ECS task profile。

### 6.4 初始化 / 计划 / 应用

```bash
cd infra
terraform init -backend-config=backend.hcl   # 首次：下载 provider + 连 S3 backend
terraform plan                              # 看 DNS 记录 + worker route 变更
terraform apply                            # 用户自跑，CI 不 apply
```

M1 阶段 CI 只跑 `terraform fmt -check` + `terraform init -backend=false` + `terraform validate`，**不**做自动 apply——避免任何凭据进 GitHub Secrets。

---

## 7. 自验（M1 阶段一次性跑）

仓库自带顶层脚本，`pnpm install` 之后可以一键串跑：

```bash
pnpm -r build         # 各包 build（worker 走 wrangler deploy --dry-run）
pnpm run lint         # eslint flat config
pnpm run typecheck    # pnpm -r run typecheck（strict + noUncheckedIndexedAccess）
pnpm run test         # vitest run
pnpm run format:check # prettier --check
```

全绿代表 M1 的静态校验链路打通；CI（任务 05）会跑同一组命令。

---

## 8. 常见问题

- **`wrangler dev` 报 `EADDRINUSE` on :8787** → 换端口（见 §3.3）或杀掉占用的进程。
- **`pnpm install` 报 `EBADENGINE`** → 检查 `node --version` 是否在 22.x、pnpm 是否在 10.x（`engines` 硬约束）。
- **`@remotepi/shared` import 报模块未找到** → `pnpm install` 重跑一次（workspace 软链未建立）。
- **`wrangler login` 一直跳转浏览器无响应** → CI / 无头环境不支持 OAuth；用 `CLOUDFLARE_API_TOKEN` 环境变量走 Token 登录，详见 wrangler 文档。
- **bridge 起不来 / `pi` 找不到** → M1 阶段 bridge 是空壳，不真正调用 pi；如果你在 M3+ 已经接入，确保 `which pi` 在 PATH 里、`pi --version` ≥ 0.84.4。

---

## 9. 下一步

- 想了解项目蓝图？→ [[roadmap.md]]
- 想看 M1 PRD 的设计细节？→ [[prds/m1-infrastructure.md]]
- 想理解 RemotePi 隧道协议？→ [[architecture/protocol/README.md]]

---

## 10. M2 部署到 Cloudflare

M1 hello worker `remotepi-hello` 已不再被 route 引用（M2 业务切到 `remotepi-worker`）；网页合并进主域 `remote-pi.sankabox.com`，由 **Worker Static Assets** 托管 SPA（`wrangler.toml` 的 `[assets]` 表 + `run_worker_first` 路由 `/web` `/bridge` `/healthz`）。**首选 CD（GitHub Actions）**——`git push origin main` 自动跑 `deploy.yml`（lint/typecheck/test/build → `wrangler deploy` → `terraform apply`）；**本地手动部署**保留为备选。**部署顺序已编码进 deploy.yml**，worker 先行（避免 route 切到尚未 deploy 的 worker 触发 522）。

### 10.1 前置：GitHub 仓库 Secrets

CD 与本地手动共用同一组凭据。在仓库 **Settings → Secrets and variables → Actions** 配 **4 项** Secrets：

| Secret | 用途 | 来源与最低权限 |
|--------|------|---------------|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` 上传 worker script + 静态资源（直接读 `CLOUDFLARE_API_TOKEN` env）；`terraform apply` 管 DNS / route（通过 `TF_VAR_cloudflare_api_token` 注入 `infra/providers.tf` 的 `var.cloudflare_api_token`） | CF Dashboard → My Profile → API Tokens → Create Token → Custom：Account-level **Workers Scripts: Edit** + Account-level **Workers Routes: Edit** + Zone-level **DNS: Edit**（zone: `sankabox.com`）。**注意**：M1 §6.1 原裁定的「Workers Scripts: Read」不再适用——M2 由 `wrangler deploy` 直接上传 worker script，需 Write 权限 |
| `CLOUDFLARE_ACCOUNT_ID` | `terraform apply` 解析 `data.cloudflare_zone` 的 `filter.account.id`（5.x schema 无默认值，必须显式传入；`infra/data.tf` / `infra/variables.tf`） | CF Dashboard 右侧栏 → Account ID；公开值 |
| `AWS_ACCESS_KEY_ID` | Terraform S3 backend（state + lock file），由 TF S3 backend 的标准凭据链直接消费 | 见 M1 §6.1；最小权限：`s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` / `s3:ListBucket`，限定到 state bucket |
| `AWS_SECRET_ACCESS_KEY` | 同上（同 IAM user 的 secret key） | 同上 |

**`infra/backend.hcl` 已入库**——只含 S3 backend 的非敏感字段（`bucket` / `region` / `key` / `use_lockfile` / `encrypt`）。AWS 凭据**不**在该文件，走上述 4 个 Secrets（或本地 `aws login` / 环境变量）。`deploy.yml` 的 `terraform init` 直接用 `-backend-config=backend.hcl` 读取——无须额外的 `TF_STATE_BUCKET` 等 Secrets。这是把 6 个 Secrets 收敛到 4 个的关键。`infra/terraform.tfvars` 仍由 `.gitignore` 排除，但已不再被 CD 引用（TF 凭据走 `TF_VAR_*` env），本地手跑按 §6.3 自取。

### 10.2 部署 = push main 触发 Actions

```bash
# 本地验证全绿后
pnpm -r build && pnpm run lint && pnpm run typecheck && pnpm run test   # 一条串跑
git add -A
git commit -m "..."
git push origin main
# ↑ push 后 Actions 跑 deploy.yml：
#   1. lint / typecheck / test / build（任何一步红则不进部署）
#   2. pnpm --filter worker run deploy:cf（Worker + Static Assets 上传）
#   3. cd infra && terraform apply（route 切换 + 其它基础设施）
# 顺序已编码，worker 先行（避免空窗）
```

**首次 apply** 会做：

- `cloudflare_workers_route.script`：`remotepi-hello` → `remotepi-worker`（route 切到新 worker）
- 其它基础设施资源（与 M1 一致）

**不会**再创建 Pages 项目或 `web.` 子域 CNAME——这两项原计划已作废。

### 10.3 本地手动部署（备选）

凭据失效 / 想本地跳过一次 Actions 时：

```bash
# ① 先 build web（worker deploy 会读 packages/web/dist 作为 Static Assets）
pnpm -r build

# ② deploy worker + 静态资源（会自动 build web 作为前置依赖）
pnpm --filter worker run deploy:cf

# ③ 切 route
cd infra
terraform apply
cd ..
```

### 10.4 验证

```bash
# ops 探活（替代原 GET / 的 hello）
curl https://remote-pi.sankabox.com/healthz
# Expected: ok from remotepi worker v1

# 网页首页
# 浏览器开 https://remote-pi.sankabox.com/ —— 应看到 web SPA（TokenPrompt 或上次的 StatusBar）

# bridge 直连生产
pnpm --filter @remotepi/bridge dev   # 不带 --worker-url，默认连 wss://remote-pi.sankabox.com/bridge
# stdout 打印 share URL：https://remote-pi.sankabox.com/#<token>
# 粘到生产网页 https://remote-pi.sankabox.com/ 的 URL fragment → StatusBar 应 online
```

> **`/healthz` 文案不是裸 `ok`，而是 `ok from remotepi worker v${PROTOCOL_VERSION}`**（当前 v1）。`PROTOCOL_VERSION` 来自 `@remotepi/shared`，worker bundle 与协议号同源——任何时候有人 bump 协议而忘了 deploy 新 bundle，探活会显式报旧版本号（fail-loud 设计；比起「返 ok」更难漏检）。M1 阶段 `GET /` 返同形式的 `hello from remotepi worker v1`；M2 合并主域后 `GET /` 让位给 web SPA（assets fallback），探活路径挪到 `/healthz` 并以 `run_worker_first` 强制走 worker 脚本（避开 SPA fallback）。

### 10.5 旧 M1 hello worker 清理

remotepi-hello 已于 2026-09-05 由用户经 CF Dashboard 删除；如需重建同名 worker 可随时 wrangler deploy。

### 10.6 wscat 冒烟（不打开网页也能验 worker 路由）

[wscat](https://github.com/websockets/wscat) 是 Node 的 WS REPL（`npm i -g wscat`）。没有 browser、没有 web bundle 也能直接打 worker 验握手与错误码——所有错误码矩阵的「wscat」验收路径都走这里：

```bash
# (a) 不带 subprotocol → 401
wscat -c ws://remote-pi.sankabox.com/bridge
# Expected：拒绝连接（worker index.ts 在 upgrade 阶段 token 缺失返 401）

# (b) 带 ["remotepi.v1", token] 完成 handshake
#     token 必须由 bridge 启动生成；这里以占位 token 演示请求格式
wscat -c ws://remote-pi.sankabox.com/bridge -s "remotepi.v1,REPLACE_WITH_BRIDGE_TOKEN"
# Connected；服务端 5 秒内等 handshake，首帧发：
#   {"v":1,"kind":"control","type":"handshake","id":"h1","payload":{"role":"bridge","token":"REPLACE_WITH_BRIDGE_TOKEN"}}
# 校验通过后无 error 帧 = handshake 成功；bridge 端 keep-alive 即视为握手通过（不等待 ack）
```

> `-s "remotepi.v1,token"` 是 wscat 传 subprotocol 数组的语法（逗号分隔）；位置 0 是版本号、位置 1 是 token，详见 [[architecture/protocol/envelope.md#锁版承诺v1-存续期内不可变]]。其他错误码路径（5s 无 handshake → `auth_failed` + close 1008；role 与路径不符 → `auth_failed`；畸形帧 → `invalid_envelope`；`v=2` → `unsupported_version` + close 1008；第二 bridge → `duplicate_bridge` + close 1008）同样用 wscat 触发。
