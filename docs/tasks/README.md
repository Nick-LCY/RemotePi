# 任务

需求拆分出的开发任务。**按 PRD 分组**：`tasks/<feature>/<NN>-<短名>.md`。每个 task 是一个可独立领取、独立完成的单元。

## Task 文件格式

```
---
prd: prds/<feature>.md
status: todo        # todo | doing | done | blocked
---
# 任务：<标题>

## 目标
（来自 PRD 的拆分项）

## 完成标准
- [ ] ...

## 依赖
- 无 / 或依赖其他 task
```

## 状态约定
- `todo` — 待领取
- `doing` — 正在执行中
- `done` — 完成
- `blocked` — 阻塞

## 任务索引

按里程碑分组，每行一个任务文件 wikilink + 短标题。**M1–M5 第一块共 37 个任务，全部 `done`**（M5 第一块 2026-09-11 实施收官，3/3 done，待用户 push + 线上手测验收）；**M5 第二块（侧边栏 + 手机适配）待另立批次**。里程碑汇总见 [[current-state.md]]。

### M1 — 基建（5/5 done）

- [[tasks/m1/01-monorepo-scaffold.md|01 — monorepo 脚手架]]
- [[tasks/m1/02-shared-envelope-prototype.md|02 — shared 隧道信封雏形]]
- [[tasks/m1/03-hello-worker.md|03 — hello worker + wrangler dev 起得来]]
- [[tasks/m1/04-terraform-cloudflare.md|04 — Terraform 管理 CF（DNS + worker 路由）]]
- [[tasks/m1/05-github-actions-ci.md|05 — GitHub Actions CI 骨架]]

### M2 — 单会话闭环（6/6 done）

- [[tasks/m2/01-shared-envelope-v1.md|01 — shared 协议 v1 重写]]
- [[tasks/m2/02-shared-tests-rewrite.md|02 — shared 测试重写（17 条）]]
- [[tasks/m2/03-bridge-client.md|03 — bridge 客户端（token / WSS / handshake / 心跳 / 重连）]]
- [[tasks/m2/04-worker-do-room.md|04 — worker + DO Room（路由 / 鉴权 / 广播 / 判死 / 错误码）]]
- [[tasks/m2/05-web-components.md|05 — web 四组件 + WsClient]]
- [[tasks/m2/06-deploy-and-validation.md|06 — CD（GitHub Actions）+ Worker Static Assets SPA + /healthz + 三端联调手测验收 + getting-started 更新]]

### M3 — 单会话健壮 + 测试基建 + E2E（13/13 done）

- [[tasks/m3/01-shared-protocol-v2.md|01 — shared 协议 v2（pi 家族 9 schema + control get_state + session_state blocked_on + extension_ui_response web wire）+ 文档同步 + ADR-0006 补全]]
- [[tasks/m3/02-shared-tests.md|02 — shared 测试扩展（25+ 条）]]
- [[tasks/m3/03-bridge-config-file.md|03 — bridge 配置加载（JSON 文件 + 校验）+ CLI/env 移除 + 未知 flag 静默忽略]]
- [[tasks/m3/04-bridge-pi-process.md|04 — bridge pi 子进程状态机 + session 目录扫描 + exited 语义]]
- [[tasks/m3/05-bridge-popup-core.md|05 — bridge 弹窗核心（blocked_on 维护 + wire 翻译 + 广播原则）+ bridge 测试扩展（30+ 条）]]
- [[tasks/m3/06-web-chat.md|06 — web 聊天界面（消息流 + 队列 + abort + 4 类弹窗组件 + 倒计时 + 关闭规则 + 提交失败处理）]]
- [[tasks/m3/07-web-recovery.md|07 — web 双查询恢复仪式 + F5 恢复 + phase / blocked_on / queue_update UI 接线]]
- [[tasks/m3/08-docs-and-validation.md|08 — ADR-0003 / ADR-0004 补注 + current-state TODO + getting-started 修订 + 三端联调手测验收]]
- [[tasks/m3/09-host-shared-agent-dir.md|09 — Bridge 复用宿主机 pi agent 目录（去隔离改造）]]
- [[tasks/m3/10-integration-test-infra.md|10 — 假 LLM server + 隔离 pi 集成测试基建]]
- [[tasks/m3/11-web-testid-hooks.md|11 — web 组件 `data-testid` 断言钩子（ADR-0009 §决策 4 前置改动）]]
- [[tasks/m3/12-e2e-harness.md|12 — `tests/e2e/` 骨架 + 四进程装配 + 场景 (a)（ADR-0009 §决策 1/2/5/6/7 + §开放点 3 落地）]]
- [[tasks/m3/13-e2e-scenarios.md|13 — E2E 场景 (b) F5 恢复 + (c) 多端弹窗先答者胜（ADR-0009 §决策 3 后半部）]]

### M4 — 多会话 + 入口选择（10/10 done）

- [[tasks/m4/01-web-recovery-timeout.md|01 — web 恢复仪式 5s 修复（snapshot 无进度超时 + bridgeStatus 离线秒失败 + RecoveryInFlight 接 phase）]]
- [[tasks/m4/02-shared-protocol-v3.md|02 — shared 协议 v3（control 4 新 type + envelope (a) 增字段 + pi/prompt.payload.work_dir 仅 session:'new' 携带 + session_list.status）+ worker default 兜底 + ADR-0010]]
- [[tasks/m4/03-shared-tests.md|03 — shared 测试扩展（4 新 payload schema + envelope (a) 增字段 + session_list.status + CONTROL_TYPES 13 项 + pi/prompt.work_dir 携带语义）]]
- [[tasks/m4/04-bridge-state-json.md|04 — bridge state.json 持久化（独立文件 + atomic write + 写入失败回滚）+ M3 bridge.json work_dir 自动迁移]]
- [[tasks/m4/05-bridge-list-directories.md|05 — bridge 目录浏览 control/list_directories（home 起点 + 路径规范化 + 三件套校验 + 错误码）]]
- [[tasks/m4/06-bridge-session-layer.md|06 — bridge BridgeSessionLayer 多 PiProcessManager Map 复数化（钉子 2 pending 键控 + 钉子 4 SPAWN_TIMEOUT_MS + 裁定 C ready 5min idle + 钉子 3 work_dir_remove 不 kill 活 manager）+ sessionKey 路由 + 真 pi 探针验证]]
- [[tasks/m4/07-web-choice-page.md|07 — web readAuthFromHash 三字段（钉子 1）+ URL hash token/work_dir/session + ChoicePage 三态分派（钉子 6）+ DirectoryBrowser 组件 + level2 列表刷新时机（钉子 5）]]
- [[tasks/m4/08-web-multi-session-store.md|08 — web WebState 按 session 分桶 + 入站按 session 路由 + 出站自动带 session（裁定 A：session_list 自动带 currentWorkDir）+ ChatView per-session + RecoveryGate per-session + 跨会话 blocked_on 隔离]]
- [[tasks/m4/09-docs-sync.md|09 — docs 同步（envelope/control/pi 四文档 + ADR-0003 补注裁定 C + 钉子 4 + ADR-0007 关闭占用检测 + ADR-0010 校对 + current-state + getting-started「URL hash 三字段示例」）+ RECOVERY_TIMEOUT_MS 漂移更正（6 处文档常量名统一更正，grep 实证零残留）]]
- [[tasks/m4/10-e2e-and-validation.md|10 — E2E 场景 (d) 目录浏览 + (e) 多端各看各的 + (f) 跨会话 blocked_on 隔离 + (g) 钉子 3 work_dir_remove 活会话 + (h) 钉子 2 pending 键控 + 既有 (a)(b)(c) retry 容错断言简化 + 三端联调手测清单]]

### M5 — UIUX 优化轮第一块（3/3 done，2026-09-11 待用户 push + 线上手测验收）

- [[tasks/m5/01-web-markdown-render.md|01 — web 渲染层结构化 + markdown 渲染 + thinking/tool 可折叠（含流式分段存储）]] ✅ done
- [[tasks/m5/02-web-input-textarea.md|02 — InputBar textarea 升级（换行 + 自动增高 + IME 守卫）]] ✅ done
- [[tasks/m5/03-e2e-and-validation.md|03 — E2E × 2 + 全量验证 + 文档收尾]] ✅ done
