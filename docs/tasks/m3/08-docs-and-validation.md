---
prd: prds/m3-single-session.md
status: todo
---
# 任务：ADR-0003 / ADR-0004 补注 + current-state TODO + getting-started 修订 + 三端联调手测验收

## 目标
按 [[prds/m3-single-session.md|M3 PRD §7 + §验收清单]] 完成文档收尾 + 三端联调手测验收：补注 ADR-0003（恢复措辞 / 自主 kill 标记 / exited spawn 触发集）+ ADR-0004（弹窗模型升级为状态帧驱动 / 无乐观 UI / 多端先答者胜 / extension_ui_response wire 形状）；更新 `docs/current-state.md` 活跃需求 + 任务看板 + TODO + 最近变更；修订 `docs/getting-started.md` bridge 启动命令为 `--config` + 新增配置 JSON 字段说明 + 删除旧 `--worker-url` / `REMOTEPI_WORKER_URL` 段落；按 §验收清单"浏览器闭环"逐条手测三端（bridge + worker + web）。**worker 零代码改动**——只在联调验收中验证转发含新 type（handshake 后 get_state 到达、session_state 广播含 blocked_on、pi 家族 9 type 透传）；不单独立任务。

关键要点：

- **ADR-0003 末尾追加 4 段补注**（`docs/architecture/decisions/0003-session-lifecycle-and-history-source.md`）：
  - 恢复措辞与"双查询恢复仪式"对齐（任务 07）
  - 明确 idle 计时不会被阻塞弹窗误触发（与 ADR-0004 协同；`agent_settled` 是判据）
  - 自主 kill 标记规则注记（先置位再发信号；exit 回调三路径）
  - exited 状态 spawn 触发集注记（prompt / steer / follow_up / get_messages；get_state 永由内存作答）
- **ADR-0004 末尾追加 4 段补注**（`docs/architecture/decisions/0004-extension-ui-dialog-forwarding.md`）：
  - 弹窗模型升级为状态帧驱动（session_state.blocked_on 是真相源）
  - 无乐观 UI 规则（H 决策）
  - 并发多端"先答者胜"语义落地（迟到者收 `request_expired`）
  - extension_ui_response web wire 形状（value: string | boolean，confirm 走 boolean）
- **`docs/current-state.md` 4 处更新**：
  - 活跃需求节追加 M3 行（一行，含 PRD 链接与任务拆分说明）
  - 任务看板表追加 8 行（状态全 todo，备注列写一句话范围 + 关键修正点提示）
  - TODO / 阻塞节追加条目："（暂缓，用户裁定 2026-09-05）bridge 配置迁移后将来重新加回 CLI 参数与环境变量支持（M3 仅保留 --config）"
  - 最近变更节置顶新增条目（2026-09-05：M3 PRD 定稿落盘 + 拆任务，概括本轮敲定的关键决策）
- **`docs/getting-started.md` 修订**：
  - §3.1 bridge 启动命令改为 `bridge --config <path>`（默认 `~/.config/remotepi/bridge.json`）
  - §3.4 三端齐起：bridge 终端命令删 `--worker-url` 与 `REMOTEPI_WORKER_URL=`（注释说明改 `--config` 路径）
  - **新增 §3.5「配置文件 JSON 字段说明」**：worker_url / web_base_url / work_dir / token 四个字段、是否必填、默认 token 生成策略、XDG 路径解析（`XDG_CONFIG_HOME` → `~/.config/remotepi/bridge.json`）
  - **删除**旧 §3.1 / §3.4 中 `--worker-url` / `REMOTEPI_WORKER_URL` 相关段落
  - §10 M2 部署到 Cloudflare 节末尾追加一行"M3 起 bridge 用 `--config` 启动；详见 §3.5"
- **三端联调手测验收**（PRD §验收清单"浏览器闭环"逐条 + worker 零代码改动验证）：
  - 发消息→流式→完成 / F5 刷新恢复 / abort 生效（running + exited 两种）/ 空闲 5 分钟 kill（自主 kill 不重启）/ 意外崩溃重启（spawn 计数 +1）/ exited 后拉历史（idle kill 后 F5 → get_messages 触发带 `--session` 的 spawn）/ exited 后写操作唤醒（spawning → ready → running）/ exited 时 get_state 零成本（内存回答，不 spawn）/ 4 类弹窗可交互（select / confirm 确认与拒绝 / input / editor；超时倒计时；提交后弹窗收起）/ timeout 自答 + 迟到回应（pi 侧 stdout 零输出；迟到提交收 `request_expired`）/ fire-and-forget 5 类本地消化（bridge 日志含，web 端零弹窗）/ 多 web 端（双 tab 同 token；先答者胜；后续答者收 `request_expired`）/ bridge 重启自愈（5 秒内 offline → 重启后重连 + 恢复仪式拉回 history；不发命令时 pi 子进程不 spawn）/ 双查询恢复仪式（mock 两条都到 / 任意一条超时失败显示重试）
  - **worker 零代码改动验证**：wscat 验证 worker 转发含新 type——handshake 后 web 发 `control/get_state` 到达 bridge / bridge 回 `result` 经 worker 到达 web；session_state 广播含 blocked_on 字段经 worker 透传；pi 家族 9 type 透传（不解析）
- **交付约定**（与 M2 一致）：本地 commit 不 push；用户手动 `git push origin main` → Actions CD 沿用 M2 deploy.yml（无新增 deploy 资源）

## 完成标准
- [ ] ADR-0003 末尾追加 4 段补注（恢复措辞对齐双查询 / idle 计时不被阻塞弹窗误触发 / 自主 kill 标记 / exited spawn 触发集），与 envelope.md / ADR-0006 形成三角引用
- [ ] ADR-0004 末尾追加 4 段补注（弹窗模型状态帧驱动 / 无乐观 UI / 多端先答者胜 / extension_ui_response wire 形状）
- [ ] `docs/current-state.md` 4 处更新全部到位：活跃需求追加 M3 行 / 任务看板追加 8 行（状态 todo）/ TODO 追加"将来恢复 CLI/env"条目 / 最近变更置顶 M3 PRD 定稿条目
- [ ] `docs/getting-started.md` §3.1 / §3.4 bridge 启动命令改 `--config`；新增 §3.5 配置 JSON 字段说明；旧 `--worker-url` / `REMOTEPI_WORKER_URL` 段落全部删除（grep 验证）
- [ ] 三端联调手测验收清单 14 条全部走过（PRD §验收清单"浏览器闭环" + worker 零代码改动验证），结果记录在任务评审纪要
- [ ] `pnpm -r build` / `pnpm run lint` / `pnpm run typecheck` / `pnpm run test` 全绿
- [ ] 仓库根 `git status` 干净（本地 commit 已落，未 push）；准备用户手动 `git push origin main` 触发 CD
- [ ] `grep "REMOTEPI_WORKER_URL\|--worker-url" docs/getting-started.md` 零结果（M3 配置迁移后已无相关段）

## 依赖
- 依赖 [[tasks/m3/03-bridge-config-file.md|03-bridge-config-file]]
- 依赖 [[tasks/m3/04-bridge-pi-process.md|04-bridge-pi-process]]
- 依赖 [[tasks/m3/05-bridge-popup-core.md|05-bridge-popup-core]]
- 依赖 [[tasks/m3/06-web-chat.md|06-web-chat]]
- 依赖 [[tasks/m3/07-web-recovery.md|07-web-recovery]]
