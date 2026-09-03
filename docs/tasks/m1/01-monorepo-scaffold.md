---
prd: prds/m1-infrastructure.md
status: todo
---
# 任务：monorepo 脚手架

## 目标
按 PRD §1 / §3 / §5 / §9 / §11 落地 pnpm workspaces 仓库骨架：根 `package.json`（含 `packageManager` / `engines`）、`pnpm-workspace.yaml`、`tsconfig.base.json`、eslint flat config、prettier 配置、`.nvmrc`、`.gitignore`。建出 `packages/{shared,bridge,web}` 与 `worker/` 四个空壳包（package.json + src/index.ts 占位 + tsconfig），同时落 `.vscode/` 四件套（launch.json / tasks.json / settings.json / extensions.json，定义见 PRD §11）。让 `pnpm install` 一次通过、`pnpm -r build` 在每个包都跑通（即使是空构建），VS Code 用户能直接 F5 / 任务面板调试三件套。

## 完成标准
- [ ] 根 `package.json` 含 `"packageManager": "pnpm@10.32.1"`、`"engines": { "node": ">=22 <23", "pnpm": ">=10 <11" }`、顶层 scripts（dev/build/lint/typecheck/test/format/format:check）
- [ ] `.nvmrc` 内容 `22.23.1`
- [ ] `pnpm-workspace.yaml` 声明 `packages: ['packages/*', 'worker']`
- [ ] `tsconfig.base.json` 含 strict + NodeNext + noUncheckedIndexedAccess + verbatimModuleSyntax
- [ ] `eslint.config.js`（flat）含 typescript-eslint + eslint-config-prettier
- [ ] `.prettierrc.json` 含 singleQuote/trailingComma/printWidth/semi
- [ ] `.gitignore` 含 node_modules、dist、.wrangler、.terraform、*.tfstate、*.tfstate.backup、backend.hcl
- [ ] `packages/shared/package.json`：`name: @remotepi/shared`、`type: module`、`main/exports` 指向 `./src/index.ts`，scripts 含 `typecheck`（`tsc --noEmit`）
- [ ] `packages/bridge/package.json`：含 `peerDependencies` + `peerDependenciesMeta.optional`（按 PRD §6 声明 pi），scripts 含 `build` (`tsc`) 与 `dev` (`tsx watch`)
- [ ] `packages/web/package.json`：含 `vite`、`react`、`@remotepi/shared` (workspace:*)，scripts 含 `dev` (`vite`) 与 `build` (`vite build`)
- [ ] `worker/package.json`：含 `wrangler`（dev）、`@remotepi/shared` (workspace:*)，`wrangler.toml` 含 `name = "remotepi-hello"`、`main = "src/index.ts"`、`compatibility_date`
- [ ] 四个包各自 `src/index.ts` 输出 hello（worker 是 fetch handler，其余是 console.log 占位）
- [ ] `pnpm install` 一次成功
- [ ] `pnpm -r build` 全绿
- [ ] `pnpm run lint` / `pnpm run typecheck` / `pnpm run format:check` 全绿
- [ ] `pnpm run test` 跑通（即便没有测试文件也应 exit 0）
- [ ] `worker/package.json` 含 `dev:inspector` script（`wrangler dev --inspector-port=9229`），与 PRD §11 worker attach 配置的 9229 端口对齐
- [ ] `.vscode/launch.json` 含三个配置：`bridge: debug (tsx)`（node + workspace 内 tsx）/ `web: debug (chrome)`（chrome + preLaunchTask dev:web）/ `worker: attach inspector`（node attach 9229 + preLaunchTask dev:worker:inspector），全部用 `${workspaceFolder}` 相对引用
- [ ] `.vscode/tasks.json` 含四个后台 dev 任务（`dev:bridge` / `dev:worker` / `dev:worker:inspector` / `dev:web`），均为 `isBackground: true`
- [ ] `.vscode/settings.json` 配 `editor.formatOnSave` + prettier 默认 + `editor.codeActionsOnSave.source.fixAll.eslint`
- [ ] `.vscode/extensions.json` 推荐三件套：`dbaeumer.vscode-eslint` / `esbenp.prettier-vscode` / `hashicorp.terraform`

## 依赖
- 无（root 任务）
