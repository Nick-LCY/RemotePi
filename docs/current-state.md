# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- [[roadmap.md]] — 路线图已定稿（**2026-09-04 用户定稿 M1–M4 四步走**：基建 → 通路 → 单 session 闭环 → 多 session 管理；含已确认决策 + pi RPC 协议要点 + 待决问题已按里程碑归属），下一步逐里程碑拆 [[prds/README.md|PRD]]。新建 [[architecture/protocol/README.md|architecture/protocol/]] 作为 RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源（骨架已立，待 M1/M2 PRD 填充）。

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| （暂无，PRD 拆分后开） | — | — |

## TODO / 阻塞
- [ ] 把 M1（基础设施基座）拆为 [[prds/README.md|PRD]]，再拆为 [[tasks/README.md|任务]] 领取。（roadmap §6 的待决问题已按归属里程碑在 §6 表中标好。）

## 最近变更
- 2026-09-04（定稿） — 用户定稿路线图：从早先 M0–M5 六段草案改为 **M1–M4 四步走**（基建 → 通路 → 单 session 闭环 → 多 session 管理）；同步更新 [[roadmap.md]] §5 里程碑表与 §6 待决问题（加归属列）；新建 [[architecture/protocol/README.md|architecture/protocol/]] 作为 RemotePi 隧道协议（envelope / 握手 / token 配对 / 业务消息 / 错误码 / 版本化）的唯一真相源；[[architecture/README.md]] / [[architecture/overview.md]] / [[README.md]] 地图补 protocol 入口；扩展 UI 对话框桥接并入 M3。
- 2026-09-04 — 修正 [[roadmap.md]] / [[architecture/overview.md]] 三处事实性错误：§4.2 线路协议改用物理方向（stdin / stdout）表述并校正事件名与 `extension_ui_request` 方法清单；§4.6 SessionManager 包名更正为 `@earendil-works/pi-coding-agent` 并补 `SessionInfo[]` 字段；§2 拓扑图重画为 web—CF—bridge 三段式（bridge 本地 spawn pi 子进程）。
- 2026-09-03 — 初始化文档：新增 [[roadmap.md]]（路线图 + 架构总览 + pi RPC 协议要点 + M0–M5 里程碑 + 待决问题）；新增 [[architecture/decisions/0001-three-component-topology-with-cf-do.md\|ADR-0001]] ~ [[architecture/decisions/0004-extension-ui-dialog-forwarding.md\|ADR-0004]]（关键设计决策）；[[architecture/overview.md]] 替换占位内容为真实系统总览；[[glossary.md]] 补核心术语；[[README.md]] 地图加上路线图入口。