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

仓库顶层有 `pnpm -r --parallel run dev`，会并行起四个 dev 任务（bridge / worker / web / 任一后台 inspector）。**首次本地联调建议从 VS Code 任务面板逐个启动**（见 §4），便于独立看 OUTPUT。

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

默认 `http://localhost:8787/`，返回 `hello from remotepi worker v{N}`（N = `PROTOCOL_VERSION`）。

需要 workerd inspector（VS Code 调试或 `chrome://inspect` 抓 worker 源码）：

```bash
pnpm --filter worker dev:inspector
# 即 wrangler dev --inspector-port=9229
```

> **端口被占用**：`wrangler dev` 默认绑 8787，被占用就报 `EADDRINUSE`。换端口：把 worker `package.json` 的 `dev` script 改成 `wrangler dev --port 8788`（或直接 `wrangler dev --port 8788` 一次性用）；验证完改回默认配置即可。

---

## 4. VS Code 一键启动（推荐）

`.vscode/` 下挂了四件套（`tasks.json` / `launch.json` / `settings.json` / `extensions.json`），路径全部用 `${workspaceFolder}` 变量引用，**没有机器相关绝对路径**，换机直接 `pnpm install` 后就能跑。

### 4.1 一次性的插件安装

打开 `.vscode/extensions.json`，VS Code 会推荐三个插件：

- `dbaeumer.vscode-eslint`
- `esbenp.prettier-vscode`
- `hashicorp.terraform`

点「Install Workspace Recommended Extensions」一键装。装完后保存 `.ts` 自动 prettier + eslint autofix。

### 4.2 任务面板起 dev 服务

`Ctrl+Shift+P` → `Tasks: Run Task` → 选一个：

- `dev:bridge` — `pnpm --filter @remotepi/bridge dev`
- `dev:worker` — `pnpm --filter worker dev`
- `dev:worker:inspector` — `pnpm --filter worker dev:inspector`
- `dev:web` — `pnpm --filter @remotepi/web dev`

四个任务都是 `isBackground: true`，各占独立 OUTPUT 面板（`presentation.group = "dev"`），可同时启。

### 4.3 F5 调试

| 配置 | 用途 | 前置条件 |
|------|------|---------|
| `bridge: debug (tsx)` | 断点命中 `packages/bridge/src/index.ts` | 直接 F5，无需 dev 任务 |
| `web: debug (chrome)` | 断点命中 vite 编译后的 web 源码 | 自动 `preLaunchTask: dev:web`，自动开浏览器 |
| `worker: attach inspector` | 断点命中 `worker/src/index.ts` | 自动 `preLaunchTask: dev:worker:inspector`（workerd inspector 端口 9229） |

---

## 5. 部署 worker 到 Cloudflare

```bash
# 一次性登录（OAuth；会开浏览器）
pnpm --filter worker exec wrangler login

# 部署 hello worker
pnpm --filter worker deploy
# 等价于 wrangler deploy，部署名取 worker/wrangler.toml 的 name = "remotepi-hello"
```

部署成功后 wrangler 会打 worker URL（`https://remotepi-hello.<your-subdomain>.workers.dev`），curl 一下确认：

```bash
curl https://remotepi-hello.<your-subdomain>.workers.dev/
# hello from remotepi worker v1
```

M1 阶段 worker 只回 hello，没有业务逻辑；M2 起会换成 WebSocket / DO 路由。

---

## 6. Terraform：管理 Cloudflare 资源（DNS + worker 路由）

> 任务 04（[[tasks/m1/04-terraform-cloudflare.md]]）已落地——`infra/` 目录、backend.hcl.example、`cloudflare_dns_record` / `cloudflare_workers_route` 资源已就位。本节可执行；步骤与 `infra/` 实际文件一致（`cp infra/backend.hcl.example infra/backend.hcl` → `terraform init -backend-config=backend.hcl` → `plan`/`apply`）。

### 6.1 你需要准备的凭据

| 凭据 | 用途 | 最低权限 / 说明 |
|------|------|---------------|
| Cloudflare API Token | TF 管理 DNS + worker 路由 | 模板：Edit zone DNS（zone: sankabox.com）+ Account-level: Workers Routes: Edit + **Workers Scripts: Read**。**不要给 Account-level: Workers Scripts: Edit**——M1 阶段 worker script 由 wrangler 上传，不由 TF 管理 |
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
```

### 6.3 注入凭据

```bash
# Cloudflare
export TF_VAR_cloudflare_api_token="<cf-token>"
export TF_VAR_cloudflare_account_id="<cf-account-id>"

# AWS — 任选一种：环境变量、~/.aws/credentials、instance profile 都行
export AWS_ACCESS_KEY_ID="<aws-key>"
export AWS_SECRET_ACCESS_KEY="<aws-secret>"
```

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