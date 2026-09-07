---
prd: prds/m3-single-session.md
status: doing
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

## 用户手测交接

三端联调手测验收由用户在浏览器手动执行，**不在编排者范围**——任务状态保持 `doing` 待用户全部勾完后由编排者改 `done`。下面 14 条原文来自 [[prds/m3-single-session.md#验收清单|M3 PRD §验收清单「浏览器闭环」]] + [[tasks/m3/08-docs-and-validation.md#完成标准|本任务完成标准]]，**不勾选**、仅留验收记录表格。

> ⚠ **本修复改变了 bridge 行为**（commit `52557fb`，2026-09-07）——若此前测试中 bridge 已处于卡死 spawning 状态，需 **重启 bridge 进程** 后再测。详见 [[current-state.md|current-state 2026-09-07 条目]] 与 [[architecture/decisions/0003-session-lifecycle-and-history-source.md#补注child-error-事件处理策略2026-09-07|ADR-0003 child error 补注]]。

### 前置准备（5 步）

1. **写 `bridge.json`**：参考 [[getting-started.md#3.5 配置文件 JSON 字段说明|getting-started §3.5]]；最小三字段 `worker_url`（本地 `ws://localhost:8787/bridge`）+ `web_base_url`（`https://remote-pi.sankabox.com`，与主域对齐）+ `work_dir`（本地任意项目绝对路径，bridge 不会 mkdir——路径必须已存在且可读）。路径：`~/.config/remotepi/bridge.json`（默认 XDG）或 `--config <path>` 指定。
2. **认证 pi（写入 `auth.json`）**：bridge 启动会 stderr warn 但不退出；首次未认证则所有 pi 家族命令失败。两种方式二选一：
   - **方式 ②（推荐，最快）**：复制本机已有的 `~/.pi/agent/auth.json` 到 `<configDir>/pi-agent/auth.json`，权限 `0600`。
   - **方式 ①**：进 TUI 走 `/login`——`PI_CODING_AGENT_DIR=<configDir>/pi-agent pi`，TUI 内输入 `/login` 或 `/login <provider>`，跟着提示完成 OAuth。
   - **注意**：pi **没有** `pi login` 顶层命令（pi 0.85.1 子命令仅 `install` / `remove` / `uninstall` / `update` / `list` / `config` / `auth`，其中 `auth` 只读）；登录入口是 TUI 内斜杠命令 `/login`。完成后可用 `pi auth check`（只读子命令）验证凭证可用性。详见 [[getting-started.md#3.5 配置文件 JSON 字段说明|getting-started §3.5]] `pi 凭据与 auth.json` 小节。
3. **启动 bridge**：`pnpm --filter @remotepi/bridge dev`（默认读 §1 配置），stdout 打印三行——`token` / `share URL` / `worker URL`；记下 `share URL`（含 token）。**bridge 重启会换 token**，每次重启重做 §3-§4。
4. **浏览器开主域带 token**：浏览器新开 tab 粘 `share URL`（如 `https://remote-pi.sankabox.com/#<token>`）→ StatusBar 出现 `online` + `bridge_status.reason='connected'` 表示 handshake 通过。
5. **（可选）切本地 dev**：本机 worker 在 `http://localhost:8787/`，本地 dev 把 `bridge.json.worker_url` 改 `ws://localhost:8787/bridge` 重启 bridge 即可。bridge 当前只连一个 worker URL，**不能同时**连本机 + 生产——手测要么全本地、要么全生产（推荐全生产，因为网页合并到主域 `https://remote-pi.sankabox.com/`，手测与真实环境同源）。

### 三端联调手测验收 14 条（PRD §验收清单 浏览器闭环）

| # | 用例 | 验收点 |
|---|------|--------|
| 1 | **发消息→流式→完成** | web 发 prompt → `message_update` 打字机暂显 + `message_end` 收敛 → `agent_settled` 后 phase 转 idle + 输入框可用 + 提示"5 分钟自动休眠" |
| 2 | **F5 刷新恢复** | 刷新后聊天记录 / phase / blocked_on 全部恢复（web 端无 localStorage） |
| 3 | **abort 生效（running + exited 两种）** | (a) `phase=running` 时点 abort → pi 终止 + phase 转 idle；(b) `phase=exited` 时点 abort → 无状态变化 + 回 `command_result{success:true}` |
| 4 | **空闲 5 分钟 kill（自主 kill 不重启）** | `agent_settled` 后等 5 分钟 → SIGTERM→1s→SIGKILL → phase 转 exited；**不**触发崩溃重启（自主 kill 标记路径） |
| 5 | **意外崩溃重启（spawn 计数 +1）** | `kill -9 $(pgrep -f 'pi --mode rpc')`（**不**走 bridge 自管） → 子进程 exit≠0 + 标记不在 → spawn 计数 +1 → 新子进程 |
| 6 | **exited 后拉历史** | idle kill 后 F5 → `get_messages` 触发带 `--session` 的 spawn → 历史完整恢复 |
| 7 | **exited 后写操作唤醒** | exited 时发 prompt / steer / follow_up → 触发 spawn → UI 显示 `exited → spawning → ready → running` |
| 8 | **exited 时 get_state 零成本** | exited 时开 DevTools Network / bridge 日志确认 `control/get_state` → 内存即时回执，**不**触发新 spawn（无 `pi --mode rpc` 子进程拉起） |
| 9 | **4 类弹窗可交互** | select 选项返回字符串 / confirm Yes（`value:true`）与 No（`value:false`）都正确改 pi 分支 / input / editor；超时倒计时显示（editor 无超时除外）；提交后弹窗自动收起（`session_state.blocked_on` 不含该 id） |
| 10 | **timeout 自答 + 迟到回应** | 弹窗 timeout 触发 → bridge 镜像触发 → `session_state.blocked_on` 移除该 id → 弹窗自动收起（pi 侧 stdout 零输出）；迟到提交收 `command_result{success:false, error.code:'request_expired'}` |
| 11 | **fire-and-forget 5 类本地消化** | notify / setStatus / setWidget / setTitle / set_editor_text 任一触发 → bridge 日志含该事件，web 端**零弹窗**（不渲染成阻塞弹窗） |
| 12 | **多 web 端先答者胜** | 双 tab 同 token；弹窗两端都弹出；先答者提交后两端同步收起；后续答者 toast "已过期" + 自动收起 |
| 13 | **bridge 重启 / 崩溃自愈** | bridge `Ctrl+C` → 两 web 端 5 秒内 StatusBar `offline` + `reason='closed'` → 重启 bridge（**新 token**）→ 两 tab 用新 share URL 重连 + 恢复仪式拉回 history；bridge 启动后**不**发命令时 pi 子进程**不** spawn（延迟到首任务触发） |
| 14 | **双查询恢复仪式** | 打开 DevTools 看 ws 帧：handshake 后**无 ack**即并行发 `pi/get_messages`（id=m1）+ `control/get_state`（id=g1）→ 等两条都到才渲染聊天视图；任一条失败（5s 超时 / `ok:false`）→ 显示"恢复失败，请重试"按钮，点重发双查询 |

### 补充：worker 零代码改动验证（wscat）

worker 包在 M3 零代码改动，验证**只**确认转发含新 type——不解析包内容、不做业务路由。用 [wscat](https://github.com/websockets/wscat) 起 4 类 WS 帧验收（每项一条命令即可）：

```bash
wscat -c wss://remote-pi.sankabox.com/bridge -s "remotepi.v1,REPLACE_WITH_BRIDGE_TOKEN"
# 依次发：
# 1. handshake {role:'web', token:'<bridge-token>'}             → 收到 bridge_status{online:true}
# 2. control/get_state {id:'g1'}                                 → 收到 result{reply_to:'g1', ok:true, data:{phase, blocked_on?}}
# 3. （等 bridge 端 session_state 广播）                          → 收到 session_state{payload.blocked_on: [...]} 形状合法
# 4. pi/prompt {id:'p1', content:'hello'} / pi/steer / pi/follow_up / pi/abort / pi/get_messages / pi/extension_ui_response  9 type 透传 → web 端收齐 frame
```

> 与 [[getting-started.md#10.6 wscat 冒烟（不打开网页也能验 worker 路由）|getting-started §10.6]] 的错误码矩阵验收共用同一 wscat 通道——握手通过后两条收齐即视为 worker 透传正确。

### 验收记录（用户填写）

| # | 用例 | 通过 | 不通过 | 备注（现象 / 日志 / commit 等） |
|---|------|------|--------|----------------------------------|
| 1 | 发消息→流式→完成 | ☐ | ☐ |  |
| 2 | F5 刷新恢复 | ☐ | ☐ |  |
| 3 | abort 生效（running + exited 两种） | ☐ | ☐ |  |
| 4 | 空闲 5 分钟 kill（自主 kill 不重启） | ☐ | ☐ |  |
| 5 | 意外崩溃重启（spawn 计数 +1） | ☐ | ☐ |  |
| 6 | exited 后拉历史 | ☐ | ☐ |  |
| 7 | exited 后写操作唤醒 | ☐ | ☐ |  |
| 8 | exited 时 get_state 零成本 | ☐ | ☐ |  |
| 9 | 4 类弹窗可交互 | ☐ | ☐ |  |
| 10 | timeout 自答 + 迟到回应 | ☐ | ☐ |  |
| 11 | fire-and-forget 5 类本地消化 | ☐ | ☐ |  |
| 12 | 多 web 端先答者胜 | ☐ | ☐ |  |
| 13 | bridge 重启 / 崩溃自愈 | ☐ | ☐ |  |
| 14 | 双查询恢复仪式 | ☐ | ☐ |  |
| 补 | worker 零代码改动验证（wscat） | ☐ | ☐ |  |

> 全部勾完"通过"后，把本页结果贴回本任务文档 / [[current-state.md]] 最近变更 / 推 `git commit` → 用户手动 `git push origin main` 触发 Actions CD（沿用 M2 deploy.yml）。
