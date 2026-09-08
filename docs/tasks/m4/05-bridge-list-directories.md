---
prd: prds/m4-multi-session.md
status: todo
---
# 任务：bridge 目录浏览 control/list_directories（home 起点 + 路径规范化 + 三件套校验 + 错误码）

## 目标
按 [[prds/m4-multi-session.md|PRD §2.5 + §9.2 list_directories 测试项]] 实现 `control/list_directories` 命令：web → bridge 端调此命令浏览文件系统（起点 `$HOME`，逐层下钻）。新增 type 已由 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]] 在 shared 协议层落盘；本任务负责 bridge 端命令处理 + 状态持久化依赖 [[tasks/m4/04-bridge-state-json.md|04-bridge-state-json]]。

关键要点：

- **协议形态**：
  - web → bridge：`{ "v": 1, "kind": "control", "type": "list_directories", "id": "...", "payload": { "path": "/home/sankabox" } }`
  - bridge → web：`result.ok=true, data = { entries: [{"name": "code", "path": "/home/sankabox/code"}, ...] }`
- **`path` 缺省 = `$HOME`**（即 `os.homedir()`）；不传 path 视为列 home；web UI 提供"上到 home"按钮调 `path = $HOME`
- **`path` 提供时 → `path.resolve(path)` 规范化**（处理 `..` / 多斜杠 / 相对路径转绝对）
- **不设范围限制**（对齐业务共识 2 "起点 home，不设范围限制"）：任何合法路径都可列；单用户自用，无 traversal 安全顾虑
- **列子目录**（`withFileTypes: true` →过滤 `dirent.isDirectory()`），**不含文件**（"添加手段"场景下文件无意义）
- **错误码**：
  - 路径不存在 / 不可读 / 不是目录 → `result.ok = false` + `error.code: 'invalid_path'`（沿用 control.md §8 6 个 code 集合；选 `internal` 兜底，或复用 `invalid_envelope`——实施期选最贴切的）
  - ENOENT / EACCES / ENOTDIR 各分支错误码独立（M3 §2.1 配置校验的同类做法）
- **测试**（PRD §9.2）：
  - home 起点（不传 path → 返回 home 子目录）
  - 任意路径（`/home/sankabox/code` → 返回 code 子目录）
  - 不存在路径（ENOENT → 错误码）
  - 不是目录（ENOTDIR → 错误码）
  - 不可读（EACCES → 错误码，mock fs）
  - entries 不含文件（验证只列目录）
  - `path.resolve` 规范化（相对路径 / `..` / 多斜杠）

## 完成标准
- [ ] `packages/bridge/src/list-directories.ts` 新建：`listDirectories(path?: string)` 实现（`path.resolve` 规范化 + 三件套校验 + `dirent.isDirectory()` 过滤）
- [ ] `BridgeSessionLayer`（在 06-bridge-session-layer 任务落地）注册 `list_directories` 命令处理：payload 校验 → `listDirectories(payload.path)` → 组装 `result.data.entries` 广播回执
- [ ] 错误码 6 个分支独立：合法 / ENOENT / EACCES / ENOTDIR / 非法类型 / 内部错误
- [ ] entries 不含文件（验证 isDirectory 过滤生效）
- [ ] `path.resolve` 规范化（相对路径 / `..` / 多斜杠 都正确展开为绝对路径）
- [ ] 测试（PRD §9.2）：home 起点 / 任意路径 / 不存在 / 不是目录 / 不可读 / entries 不含文件 / path.resolve 规范化（≥ 7 条）
- [ ] `pnpm --filter @remotepi/bridge build` / `pnpm --filter @remotepi/bridge typecheck` / `pnpm --filter @remotepi/bridge test` 全绿

## 依赖
- 依赖 [[tasks/m4/02-shared-protocol-v3.md|02-shared-protocol-v3]]（`list_directories` type 已落 schema）
- 依赖 [[tasks/m4/03-shared-tests.md|03-shared-tests]]（协议测试已覆盖，bridge 端按 schema 消费）
- 依赖 [[tasks/m4/04-bridge-state-json.md|04-bridge-state-json]]（state.json 读写基建就绪，目录浏览结果可不写盘但 schema 路径共享）

## 参考
- [[prds/m4-multi-session.md|PRD §2.5 目录浏览]]
- [[prds/m4-multi-session.md|PRD §9.2 list_directories 测试项]]
- [[architecture/protocol/control.md|protocol/control.md]] §8 错误码集合