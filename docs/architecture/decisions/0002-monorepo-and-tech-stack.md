# 0002. 采用 pnpm workspaces monorepo

- 日期：2026-09-03
- 状态：已接受
- 背景：
  RemotePi 包含三个运行时组件（bridge / worker / web），加上一份需要在三个组件之间共享的协议类型（RemotePi 隧道信封 + pi RPC 类型转译）。如果按"三个独立仓库 + 手动同步协议"的方式组织，会出现协议漂移、跨组件重构困难、CI 配置重复等问题。需要一个能同时表达"运行时隔离"与"类型共享"的仓库拓扑。
- 决策：
  采用 **pnpm workspaces** monorepo，目录布局：

  ```
  RemotePi/
  ├── packages/
  │   ├── bridge/      # Node.js + TypeScript 守护进程（systemd）
  │   ├── web/         # React + Vite 纯 SPA
  │   └── shared/      # 协议类型（隧道信封 + pi RPC 转译），纯类型/常量包
  ├── worker/          # Cloudflare Worker + Durable Object + wrangler.toml
  ├── infra/           # Terraform：Cloudflare 域名、Pages、Worker 路由
  └── .github/workflows # CI/CD：lint / test / 部署 web / 部署 worker / 构建 bridge
  ```

  技术选型一览：

  | 关注点 | 选型 |
  |--------|------|
  | 包管理 | pnpm workspaces |
  | 语言 | TypeScript（strict） |
  | bridge 运行时 | Node.js（≥20 LTS） |
  | web 前端 | React + Vite |
  | web 部署 | Cloudflare Pages |
  | worker 框架 | Cloudflare Workers + Durable Objects |
  | worker 工具链 | wrangler |
  | 基础设施即代码 | Terraform（Cloudflare provider） |
  | CI/CD | GitHub Actions |
  | 测试 | vitest（共享）；worker 用 wrangler 的 `--test` 或 miniflare |

  `packages/shared` 是单一协议真相源：bridge / web / worker 都依赖它，类型不一致在编译期就被发现。

- 影响：
  - 任何对 `shared` 的破坏性改动会同时阻塞三个组件的构建；CI 需对 `shared` 的变更跑全 monorepo 校验。
  - bridge 不进入 CF 边缘，但通过 shared 与 worker/web 共享类型 → 桥接层与转发层的协议版本天然一致。
  - Terraform 把 CF 域名、Pages、Worker 路由统一管理；本地开发用 wrangler 的本地模式即可。
  - monorepo 内的具体细节（worker 与 packages 的目录归属、shared 的版本引用方式——workspace 协议 vs 固定版本——）留待 PRD 阶段敲定。
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md]]、[[architecture/decisions/0003-session-lifecycle-and-history-source.md]]。