---
prd: prds/m4-multi-session.md
status: todo
---
# 任务：bridge state.json 持久化（独立文件 + atomic write + 写入失败回滚）+ M3 bridge.json work_dir 自动迁移

## 目标
按 [[prds/m4-multi-session.md|PRD §2.1 + §2.2 + §9.2 相关测试项]] 实现 bridge 运行时独立持久化文件 `state.json`（与用户手编的 `bridge.json` 分离）：记录用户保存的工作目录列表（增 / 删 / 列三动作）；M3 单 `work_dir` 配置自动迁移为清单第一项；启动时严格校验。沿用 M3 §2.1 三件套校验（存在 + 是目录 + 可读）+ XDG 路径解析。不新增 CLI 参数（state.json 路径沿用 XDG 默认，不暴露）。

关键要点：

- **文件分离**：`~/.config/remotepi/state.json`（bridge 运行时写，**用户手编会丢**）+ `~/.config/remotepi/bridge.json`（用户手编，仅 bridge 启动读）
- **state.json 格式**：
  ```jsonc
  {
    "schema_version": 1,
    "work_dirs": ["/abs/path/a", "/abs/path/b"]
  }
  ```
- **读写时机**：
  - **读**：bridge 启动时一次性加载到内存 `workDirs: string[]`；后续 `work_dir_list` / `work_dir_add` / `work_dir_remove` 命令操作这份内存（具体命令实现见 06-bridge-session-layer）
  - **写**：每次 `work_dir_add` / `work_dir_remove` 成功后**同步**写回 state.json（`fs.writeFileSync` + atomic rename：先写 `state.json.tmp` → `rename`覆盖，防并发写半截）
  - **失败处理**：写失败 → 回滚内存 + log error + 回 `result.ok = false` + `error.code: 'state_write_failed'`（沿用 control.md §8 6 个 code 集合，不新增；用 `internal` 兜底）
- **M3 迁移**：bridge 启动时若 state.json 不存在但 bridge.json 有 `work_dir` 字段 → 自动把该字段写入 state.json 作为第一项，**不回写** bridge.json（用户手编配置不被运行时污染）；一次性迁移，迁移完成后打印日志 "migrated work_dir from bridge.json → state.json"
- **文件路径解析**（沿用 M3 §2.1）：XDG `XDG_CONFIG_HOME` 优先，否则 `~/.config/remotepi/state.json`
- **CLI / env 不新增**：沿用 M3 §2.2 — CLI 仅 `--config <path>`，未知 flag 静默忽略；state.json 路径不暴露 CLI / env 参数
- **测试**（PRD §9.2）：
  - state.json 加载：合法 / JSON 错 / 缺 schema_version / 缺 work_dirs
  - state.json 写入：atomic rename 验证（模拟并发写）
  - M3 迁移：bridge.json 有 work_dir + state.json 不存在 → 迁移到 state.json
  - 写入失败回滚（mock `fs.writeFileSync` throw）
  - 重复添加幂等（no-op + ok:true）

## 完成标准
- [ ] `packages/bridge/src/state.ts` 新建：state.json 读写逻辑（zod schema 校验 `schema_version: z.literal(1)` + `work_dirs: z.array(z.string())`）+ atomic rename（先写 `state.json.tmp` → `rename`覆盖）
- [ ] `packages/bridge/src/config.ts` 扩展：启动时一次性加载 state.json 到内存 `workDirs: string[]`；M3 迁移逻辑（bridge.json 有 work_dir + state.json 不存在 → 写入 state.json 第一项 + 不回写 bridge.json + 日志提示）
- [ ] XDG 路径解析：`XDG_CONFIG_HOME` 优先 → `~/.config/remotepi/state.json`
- [ ] 写入失败回滚：mock `fs.writeFileSync` throw → 回滚内存 + log error + 不污染磁盘
- [ ] 错误码：`state_write_failed` 沿用 control.md §8 6 个 code 集合（不新增，用 `internal` 兜底）
- [ ] 重复添加幂等：no-op + `ok: true`
- [ ] 测试（PRD §9.2）：state.json 加载合法 / JSON 错拒 / 缺 schema_version 拒 / 缺 work_dirs 拒 / atomic rename 验证 / M3 迁移 / 写入失败回滚 / 重复添加幂等（≥ 8 条）
- [ ] `pnpm --filter @remotepi/bridge build` / `pnpm --filter @remotepi/bridge typecheck` / `pnpm --filter @remotepi/bridge test` / `pnpm run lint` 全绿
- [ ] `grep -R "peerDep\|REMOTEPI_WORKER_URL\|--worker-url" packages/bridge/src` 零结果（M3 已清理，本任务不回归）

## 依赖
- 无（持久化形态独立确定）

## 参考
- [[prds/m4-multi-session.md|PRD §2.1 独立 state.json]]
- [[prds/m4-multi-session.md|PRD §2.2 CLI / env 移除清单]]
- [[prds/m4-multi-session.md|PRD §9.2 相关测试项]]
- [[tasks/m3/03-bridge-config-file.md|tasks/m3/03]] config.ts + XDG 路径解析基线
- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 历史来源（state.json 路径策略协同）