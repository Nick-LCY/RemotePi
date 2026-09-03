# RemotePi

在网页上远程使用自有服务器上的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)。

RemotePi 把浏览器、Cloudflare 边缘与本地 pi 守护进程串成一条 RemotePi 隧道协议通道（envelope-based message bus），让你在没有 SSH 的前提下用网页驱动本地服务器上跑的 pi。

## 起步

- [docs/getting-started.md](docs/getting-started.md) — clone → 安装 → 各包 dev → VS Code 一键启动 → Cloudflare 部署 → Terraform 管理 CF 资源的完整本地步骤。
- [docs/README.md](docs/README.md) — 项目文档库入口（路线图 / 架构 / PRD / 任务 / 约定）。
- [docs/roadmap.md](docs/roadmap.md) — M1–M4 里程碑路线图。

## 仓库结构（极简版）

```
RemotePi/
├── packages/
│   ├── shared/   # @remotepi/shared — 隧道信封类型 + Zod schemas
│   ├── bridge/   # @remotepi/bridge — 本机守护进程（spawn pi 子进程）
│   └── web/      # @remotepi/web   — React + Vite 前端
├── worker/       # Cloudflare Worker（边缘入口 + DO 状态）
├── infra/        # Terraform（CF zone / DNS / worker 路由；S3 backend）
├── docs/         # 项目文档库（路线图、PRD、任务、架构）
├── .vscode/      # 本地调试四件套（tasks / launch / settings / extensions）
└── pnpm-workspace.yaml  # 顶层 packageManager + scripts
```

其余三个包（bridge / web / worker）通过 `workspace:*` 协议引用 `@remotepi/shared`，`pnpm -r build` 能一次性构建全栈。`worker/` 与 `packages/` 平级，分别走 wrangler 与 tsc/vite 两条不同的工具链——参见 [docs/prds/m1-infrastructure.md §1](docs/prds/m1-infrastructure.md) 的拓扑决策。

## 状态

M1（基础设施基座）进行中；详见 [docs/current-state.md](docs/current-state.md) 任务看板。
