---
prd: prds/m1-infrastructure.md
status: done
---
# 任务：hello worker + wrangler dev 起得来

## 目标
实现 `worker/src/index.ts` 的 fetch handler：返回 `"hello from remotepi worker v{N}"`（N 取 `PROTOCOL_VERSION`），演示性 `import { PROTOCOL_VERSION } from '@remotepi/shared'`。保证 `wrangler dev` 本地起服务、`wrangler deploy --dry-run` 产出 `dist/` 无错。

## 完成标准
- [ ] `worker/src/index.ts` 实现 `export default { async fetch(req: Request): Promise<Response> }`，导入 `@remotepi/shared` 的 `PROTOCOL_VERSION`（证明 shared 链路通）
- [ ] `wrangler dev` 在本地起 `http://localhost:8787/`，curl 返回 `"hello from remotepi worker v1"`
- [ ] `wrangler deploy --dry-run --outdir=dist` 成功产出 `dist/`（CI 用这一步做构建校验）
- [ ] `worker/wrangler.toml` 含 `name = "remotepi-hello"`、`main = "src/index.ts"`、有效 `compatibility_date`（取 ≥ 2025-01-01）
- [ ] 在 `docs/getting-started.md` 加一行 "运行 `pnpm --filter worker dev` 启动本地 worker"

## 依赖
- 依赖 `01-monorepo-scaffold`（需要 workspace + wrangler.toml 初始化）
- 依赖 `02-shared-envelope-prototype`（worker 演示性 import PROTOCOL_VERSION；版本号需要先在 shared 落定）
