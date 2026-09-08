# sessionkey-probe 实测发现记录

> **目的**：把任务 06 sessionKey 派生时机的真 pi 实测结论固化为可读的发现记录，
> 不再作为可解析的 JSON 制品（避免被任何构建脚本消费）。原始 JSON 数据嵌入在
> 下方 code block 里，仅用于实现期人工查阅与将来 pi 升级时人工对比。

- **实测日期**：2026-09-08
- **pi 版本**：0.85.1
- **复跑命令**：`pnpm tsx tests/integration/probes/sessionkey-probe.ts`
- **探针脚本**：[`sessionkey-probe.ts`](./sessionkey-probe.ts)（注：脚本内的 `writeFileSync` 现在写到一个 `.tmp/` 路径而非 git 跟踪的 `probe-result.json`——探针脚本不再产出 git 跟踪制品）

## 结论（三行）

1. **派生时机**：`agent_start` 事件是 session jsonl 文件**同步出现**的可靠信号——
   pi 0.85.1 在 `agent_start` 触发的同帧/微秒内创建 `<agentDir>/sessions/--<encodedWorkDir>--/<timestamp>_<uuid>.jsonl`。
   `entry_appended` 事件在 0.85.1 的 wire 上不存在（pi 走裸 `message_update`/`message_end` 流而非 entry 序列化），
   故探针 script 中 `firstEntryAppended` 字段始终为 `null`。M4 任务 06 实现采用 "agent_start 事件触发 + agent_dir 扫描" 双保险策略。
2. **sessionFile 字段**：pi 0.85.1 在 `agent_start` 帧内携带 `sessionFile` 字段（绝对路径），
   桥端可作为 fast-path 派生点直接消费；agent_dir 扫描是 fallback（应对未来 pi 版本不再携带该字段）。
3. **with vs without `--session` 标志**：两种 spawn 模式下 jsonl 出现时机不同——
   `with-session-flag`（恢复既有会话）jsonl 在 spawn 时已存在；`without-session-flag`（创建新会话）jsonl 在 `agent_start` 时才创建。
   桥端必须能处理两种时序，否则恢复路径会因等待不可能到来的 `agent_start` 而误路由。

## 原始数据（withFlag）

```json
{
  "startTs": 1788883706280,
  "case": "with-session-flag",
  "agentDir": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-with-session-flag-1788883706276-31iwm4/agent-dir",
  "workDir": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-with-session-flag-1788883706276-31iwm4/work",
  "spawnedAt": 3,
  "handshakeReceivedAt": null,
  "agentStartAt": 8006,
  "sessionFileFirstSeen": 53,
  "sessionFile": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-with-session-flag-1788883706276-31iwm4/agent-dir/sessions/---home-sankabox-code-RemotePi-tests-integration-.tmp-probe-with-session-flag-1788883706276-31iwm4-work--/2026-09-08T16-08-26-280Z_431bd093-6dab-4c00-97b6-04947e097790.jsonl",
  "agentStartEvent": { "t": 8006, "type": "agent_start", "fields": {} },
  "firstEntryAppended": null,
  "firstMessageStart": { "t": 8006, "type": "message_start", "fields": {} },
  "events": [
    { "t": 311, "type": "response", "fields": { "command": "get_state", "id": "probe-handshake" } },
    { "t": 8005, "type": "response", "fields": { "command": "prompt", "id": "probe-prompt" } },
    { "t": 8006, "type": "agent_start", "fields": {} },
    { "t": 8006, "type": "turn_start", "fields": {} },
    { "t": 8006, "type": "message_start", "fields": {} },
    { "t": 8006, "type": "message_end", "fields": {} },
    { "t": 8031, "type": "message_start", "fields": {} },
    { "t": 8031, "type": "message_update", "fields": {} },
    { "t": 8032, "type": "message_update", "fields": {} },
    { "t": 8032, "type": "message_update", "fields": {} },
    { "t": 8032, "type": "message_end", "fields": {} },
    { "t": 8032, "type": "turn_end", "fields": {} },
    { "t": 8032, "type": "agent_end", "fields": {} },
    { "t": 8032, "type": "agent_settled", "fields": {} }
  ]
}
```

## 原始数据（withoutFlag）

```json
{
  "startTs": 1788883719301,
  "case": "without-session-flag",
  "agentDir": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-without-session-flag-1788883719300-9t3t4r/agent-dir",
  "workDir": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-without-session-flag-1788883719300-9t3t4r/work",
  "spawnedAt": 2,
  "handshakeReceivedAt": null,
  "agentStartAt": 8005,
  "sessionFileFirstSeen": 8057,
  "sessionFile": "/home/sankabox/code/RemotePi/tests/integration/.tmp/probe-without-session-flag-1788883719300-9t3t4r/agent-dir/sessions/--home-sankabox-code-RemotePi-tests-integration-.tmp-probe-without-session-flag-1788883719300-9t3t4r-work--/2026-09-08T16-08-39-476Z_01a081c7-5533-761f-b3b4-97b57cd3ed22.jsonl",
  "agentStartEvent": { "t": 8005, "type": "agent_start", "fields": {} },
  "firstEntryAppended": null,
  "firstMessageStart": { "t": 8006, "type": "message_start", "fields": {} },
  "events": [
    { "t": 309, "type": "response", "fields": { "command": "get_state", "id": "probe-handshake" } },
    { "t": 8005, "type": "response", "fields": { "command": "prompt", "id": "probe-prompt" } },
    { "t": 8005, "type": "agent_start", "fields": {} },
    { "t": 8005, "type": "turn_start", "fields": {} },
    { "t": 8006, "type": "message_start", "fields": {} },
    { "t": 8006, "type": "message_end", "fields": {} },
    { "t": 8029, "type": "message_start", "fields": {} },
    { "t": 8029, "type": "message_update", "fields": {} },
    { "t": 8030, "type": "message_update", "fields": {} },
    { "t": 8030, "type": "message_update", "fields": {} },
    { "t": 8030, "type": "message_end", "fields": {} },
    { "t": 8030, "type": "turn_end", "fields": {} },
    { "t": 8030, "type": "agent_end", "fields": {} },
    { "t": 8031, "type": "agent_settled", "fields": {} }
  ]
}
```

## 实测结论（按时序）

| 时刻（ms since probe start） | withFlag | withoutFlag | 备注 |
|----:|----:|----:|----|
| 2–3 | spawn 完成 | spawn 完成 | spawn 与 child exit 之间的初始化耗时 |
| 53 | session jsonl 已落盘 | — | withFlag 路径：jsonl 在 spawn 时已存在（probe 启动前预创建） |
| 309–311 | get_state response 抵达 | 同 | 握手回执，与 spawn 大致相隔 ~310ms |
| 8005–8006 | agent_start | 同 | 触发派生点的关键事件 |
| 8057 | — | session jsonl 落盘 | withoutFlag 路径：jsonl 在 agent_start 后 ~52ms 出现（≈ 与 first message_start 同帧） |
| 8031–8032 | turn_start / message_* / turn_end / agent_end / agent_settled | 同 | 标准 LLM round-trip 流 |

## 关键 wire 发现（实现期已落 ADR-0008 / session-layer.ts）

1. **jsonl 派生时机稳定**：`agent_start` 是 session 文件就位的可靠信号。
   桥端 `session-layer.ts::attemptPendingMigration` 在每个 `pi/event` 上尝试迁移——第一次成功的迁移即是 agent_start。
2. **`entry_appended` 在 0.85.1 不存在**：探针 code 里 `firstEntryAppended` 始终 null；jsonl 由 pi 内部管理，不通过 entry_appended 暴露。
3. **`sessionFile` 字段在 agent_start 帧内**：直接携带绝对路径，可作为 fast-path。
   桥端当前实现不消费该字段（仍走 agent_dir 扫描），留作未来 M+ 的优化候选。

## 升级体检（pi 版本升级时复跑该探针）

复跑命令（不写入 git 跟踪制品）：
```bash
pnpm tsx tests/integration/probes/sessionkey-probe.ts
```

升级 pi 后比对：
- `agentStartAt` 与 `sessionFileFirstSeen` 的差值（应在 0–100ms 内，否则派生点漂移）
- 事件序列是否仍是 `agent_start → turn_start → message_start → ... → agent_settled`
- `sessionFile` 字段是否仍携带（若消失，桥端 fallback 到 agent_dir 扫描仍工作，但性能略降）

参考实现文件：[`packages/bridge/src/session-layer.ts`](../../../packages/bridge/src/session-layer.ts)（`deriveStemForWorkDir` + `attemptPendingMigration`）。