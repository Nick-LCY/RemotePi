# 0005. 部署形态：主域统一 + Worker Static Assets + GitHub Actions CD

- 日期：2026-09-05
- 状态：已接受
- 背景：
  M1 收官时部署形态：worker `remotepi-hello` 跑在 `remote-pi.sankabox.com` 主域下（TF 管 DNS + worker route；wrangler deploy 上传 script）。M2 原计划延续此模式但加 web 独立子域 + Pages：worker `remotepi-worker` 仍跑主域；web `web.remote-pi.sankabox.com` 通过 Cloudflare Pages 托管；Pages 项目 + `web` CNAME 入 TF。

  实现到 M2 收官阶段时，用户重新审视部署形态，发现以下问题：
  1. **域名空窗风险高**：Pages 项目 + CNAME + worker route + wrangler pages deploy 几个动作互相依赖，顺序错了容易出现 `route 指向尚未 deploy 的 worker → 522` 或 `Pages 项目未创建 → wrangler pages deploy 失败`。
  2. **两套部署面增加运维心智**：worker 走 wrangler + TF route，web 走 wrangler pages deploy + Pages dashboard 自定义域；本地手动跑步骤多，CI 也得分别调两套工具链。
  3. **bridge share URL 多了子域**：原 `https://web.remote-pi.sankabox.com/#<token>`，用户粘到浏览器还要解释域名；主域路径更直接（`https://remote-pi.sankabox.com/#<token>`）。
  4. **M1 已实现的 hello 探活在合并后失效**：M1 阶段 `curl https://remote-pi.sankabox.com/` 返 `hello from remotepi worker v1` 作 ops smoke；M2 web 上主域后 `GET /` 让位给 web SPA，hello 文本无处安放。

- 决策：
  **部署形态调整为：网页合并进主域，Worker Static Assets 托管 SPA，GitHub Actions 跑 CD（lint/typecheck/test/build → wrangler deploy → terraform apply）。**

  | 维度 | 调整前（M2 原计划） | 调整后 |
  |------|-------------------|--------|
  | web 域名 | `web.remote-pi.sankabox.com`（独立子域） | `remote-pi.sankabox.com`（主域） |
  | web 托管 | Cloudflare Pages（独立产品） | Worker Static Assets（同 worker 一起部署） |
  | Pages 项目 | TF `cloudflare_pages_project` 声明 | 删除（无需） |
  | `web` DNS | TF `cloudflare_dns_record` CNAME → `remotepi-web.pages.dev` | 删除（无需） |
  | SPA fallback | `public/_redirects`（Pages 特性） | `wrangler.toml` 的 `[assets]` 表 + 默认 SPA fallback |
  | WS 路由 | `/web` `/bridge` 走 worker | 同左 + 配 `run_worker_first`（与 SPA fallback 共存） |
  | 部署触发 | 用户本地手动（`wrangler deploy` / `wrangler pages deploy` / `terraform apply` 分步） | `git push origin main` → Actions 自动跑 `deploy.yml` |
  | 顺序保障 | 用户操作清单手工保证 | `deploy.yml` 编码（worker deploy 先于 terraform apply） |
  | `GET /` 行为 | M1 hello 文本 → M2 让位给 web SPA | web SPA（assets fallback） |
  | ops 探活 | `GET /`（hello） | `GET /healthz`（返 `ok`，走 worker，避开 SPA fallback 与 WS 路径） |
  | bridge share URL | `https://web.remote-pi.sankabox.com/#<token>` | `https://remote-pi.sankabox.com/#<token>` |

  **Worker Static Assets 选型理由**：
  - 2025 CF 推出 Workers Static Assets（取代 Pages + Workers 的双栈部署），天然支持 SPA fallback（无路径命中时返 `index.html`）+ 自定义路由优先级（`run_worker_first`）。
  - 与 worker 同仓同 wrangler.toml，单次 `wrangler deploy` 同时上传 script 与静态资源，避免 Pages / Workers 两套产品的不一致。
  - 免费版支持，无额外费用。

  **CD 选型理由（GitHub Actions）**：
  - 仓库已用 Actions（[[tasks/m1/05-github-actions-ci.md|tasks/05]] 落地），加 deploy job 比引入新 CI 系统轻量。
  - 顺序保障：deploy.yml 的 `needs:` 关系 + 步骤顺序保证 worker 先于 route 切换。
  - 凭据走 GitHub Secrets（`CLOUDFLARE_API_TOKEN` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`），用户配置一次即用。
  - 失败回滚：deploy.yml 失败则不进下一步；wrangler deploy 失败时 terraform apply 不会执行。

  **CF API Token 权限调整**：
  - 原 M1 裁定（[[getting-started.md|getting-started §6.1]]）：`Workers Scripts: Read`（TF 只验证 route 引用的 script 名，script 上传走 `wrangler login` OAuth）。
  - 现 M2 裁定：`Workers Scripts: Edit`（`wrangler deploy` 直接用 `CLOUDFLARE_API_TOKEN` 上传 script，OAuth 与 token 二选一即可；统一 token 减少配置面）。

- 影响：
  - **零迁移成本**：Pages 项目从未创建，`infra/pages.tf` 与 `infra/dns_web.tf` 未 commit 也未 apply；删除文件即彻底取消原计划，CF 上无残留资源。
  - **bridge token 默认 base 常量需改**：`packages/bridge/src/token.ts` 的 `shareUrl()` 默认 base 从 `https://web.remote-pi.sankabox.com` 改为 `https://remote-pi.sankabox.com`；对应单测断言同步（在 task 06 落地）。
  - **ops 探活路径变更**：监控 / healthcheck 脚本需从 `GET /`（hello 文本）改 `GET /healthz`（`ok`）；M1 阶段 hello 文本不再可访问——作为历史记录保留在 [[tasks/m1/03-hello-worker.md|tasks/03]] 与 [[getting-started.md|getting-started §3.3]] 备注中。
  - **CF Token 权限收紧到 M2 推荐值**：若用户在 M1 阶段沿用「Workers Scripts: Read」最小权限，需补「Workers Scripts: Edit」才能让 `wrangler deploy` 上传 script；本地手动部署与 CD 共用同一组凭据（task 06 完成标准有覆盖）。
  - **GitHub Secrets 配置依赖用户**：CD 首跑需用户在仓库配 3 项 Secrets；配错则 deploy step 失败但不影响 CI（lint/typecheck/test/build 仍跑）。见 [[current-state.md|current-state TODO / 阻塞]]。
  - **DO 探活 + run_worker_first 共存验证**：worker 实现时需核实 `[assets]` SPA fallback 与 `run_worker_first = ['/web', '/bridge', '/healthz']` 的优先级是否互斥/共存（CF 文档支持，但首次部署需实测）。
  - **本地手动部署路径保留为备选**：CD 失败 / 凭据失效时可本地手动跑——`pnpm --filter worker run deploy:cf`（会自动 build web 作为前置依赖）→ `cd infra && terraform apply`。
  - **历史 ADR 关系**：替代 M2 原计划的「web 独立子域 + Pages」方案；原 [[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]]（三组件拓扑，web 部署在 Pages）的 web 部署位置描述在 M2 范围内被本 ADR 推翻（但三组件拓扑本身不变——web 仍在 CF 边缘，只是托管介质从 Pages 换成 Worker Static Assets）。
  - 相关条目：[[architecture/overview.md]]、[[architecture/decisions/0001-three-component-topology-with-cf-do.md|ADR-0001]]、[[architecture/decisions/0002-monorepo-and-tech-stack.md|ADR-0002]]、[[prds/m2-tunnel.md|M2 PRD §方案修订注记]]、[[getting-started.md#10-m2-部署到-cloudflare|getting-started §10]]、[[tasks/m2/06-deploy-and-validation.md|tasks/06]]、[[current-state.md|current-state 最近变更]]。
