# 架构决策记录（ADR）

每个重要架构决策一个文件，命名 `NNNN-短标题.md`（如 `0001-采用文档驱动开发.md`）。

## 模板

```
# NNNN. 标题

- 日期：
- 状态：提议 | 已接受 | 已废弃
- 背景：（为什么需要这个决策）
- 决策：（决定了什么）
- 影响：（带来的后果）
```

## 清单

| 编号 | 标题 | 状态 | 日期 |
|------|------|------|------|
| [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|0001]] | 三组件拓扑 + Cloudflare Durable Object 中转 | 已接受 | 2026-09-03 |
| [[architecture/decisions/0002-monorepo-and-tech-stack.md\|0002]] | 采用 pnpm workspaces monorepo | 已接受 | 2026-09-03 |
| [[architecture/decisions/0003-session-lifecycle-and-history-source.md\|0003]] | DO 不持久化；session 生命周期与历史来源 | 已接受 | 2026-09-03 |
| [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|0004]] | 扩展 UI 对话框转发到 web 弹窗 | 已接受 | 2026-09-03 |
| [[architecture/decisions/0005-unified-domain-with-worker-static-assets-and-actions-cd.md\|0005]] | 部署形态：主域统一 + Worker Static Assets + GitHub Actions CD | 已接受 | 2026-09-05 |
| [[architecture/decisions/0006-protocol-v1-get-state-unlock.md\|0006]] | 协议 v1 control 家族破锁：新增 `get_state` | 已接受 | 2026-09-05 |
| [[architecture/decisions/0007-host-shared-pi-agent-dir.md\|0007]] | Bridge 复用宿主机 pi agent 目录 | 已接受 | 2026-09-05 |
| [[architecture/decisions/0008-fake-llm-isolated-pi-integration-tests.md\|0008]] | 假 LLM server + 隔离 pi 集成测试（bridge wire 层回归套件） | 已接受 | 2026-09-08 |
