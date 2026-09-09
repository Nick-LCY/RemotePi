# 0007. Bridge 复用宿主机 pi agent 目录

- 日期：2026-09-05
- 状态：已接受
- 背景：
  M3 原设计为 bridge 托管的 pi 使用 `<configDir>/pi-agent/` 隔离目录，并复制 `auth.json`；这会把 bridge 与宿主机 pi 的认证、session 历史人为分开。用户于 2026-09-05 裁定：bridge 应完整复用宿主机 pi 环境，让 web 端接管 `work_dir` 最近的会话，也包括用户此前或同时在终端中使用 pi 产生的会话。代码已在 commit `1985fbd` 落地。

  本决策修订 [[prds/m3-single-session.md|M3 PRD]] §2.3 / §2.5 及用户操作清单中关于隔离目录和复制认证文件的历史设计；正文保留作为历史记录，由本 ADR 作为当前行为的真相源。它延续 [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] 的“session 历史来自本地文件”原则，并沿用 [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] 所体现的 M3 协议锁步修订方式。

- 决策：
  1. **pi 环境完全共享**：bridge spawn pi 时不再注入 `PI_CODING_AGENT_DIR`；子进程继承 bridge 的环境，因此保留用户自行设置该变量的覆盖能力。
  2. **session 扫描基准与 pi 对齐**：bridge 使用 `resolvePiAgentDir()` 解析扫描根目录，语义与 pi `getAgentDir()` 一致：`PI_CODING_AGENT_DIR` 优先、展开 tilde，否则默认 `~/.pi/agent`。以该目录下对应 `work_dir` 的 session 共享池扫描文件名时间戳并取最新。
  3. **废除 auth.json 复制流程**：bridge 不创建隔离目录，也不复制认证文件。若解析出的宿主机 agent 目录缺少 `auth.json`，只向 stderr 输出 warn，不阻止启动，并提示用户在 pi TUI 中使用 `/login` 或设置 `*_API_KEY` 环境变量。
  4. **共享池的“取最新”语义**：web 连接恢复的是共享池中该 `work_dir` 最近的 session；它可能正是用户在终端里正在聊的 session。
  5. **同会话双写是 M3 已接受后果**：若 bridge pi 正在运行，用户又在终端启动交互 pi 并写同一 session，两个进程可能同时写同一份 jsonl。M3 单用户场景以行为约定规避。**M4 裁定**（2026-09-08 用户裁定，[[prds/m4-multi-session.md|M4 PRD §修订注记业务共识 3]]）：**会话占用完全不检测**——无检测、无提示、无特殊处理（对齐 pi TUI 行为）。本条 "M3 已接受后果" 不变；M4 不引入"会话被外部占用检测"。
  6. **已知布局局限**：bridge 只支持官方 pi 发行版的默认 agent 目录布局。包级改名 `configDir` 或 fork 改用其他环境变量的发行版不在支持范围内；用户需要自行设置 `PI_CODING_AGENT_DIR`，使 bridge 与实际 pi agent 目录对齐。

- 影响：
  - bridge、web、宿主 TUI 共享认证与 session 历史，不再需要额外初始化或复制 `auth.json`；缺少认证时降级为警告，实际命令仍可能因无凭据失败。
  - “目录扫描找最新”不再是 bridge 私有池语义，而是宿主机共享池语义；web 恢复可能接管终端正在使用的最近会话。
  - 同一 session 的并发写入可能造成 jsonl 双写风险。M3 接受该风险并依靠单用户行为约定；**M4 裁定**（2026-09-08 用户裁定）——不引入占用检测，无提示、无特殊处理，对齐 pi TUI 行为。详见 [[prds/m4-multi-session.md|M4 PRD §修订注记业务共识 3]]。
  - 非官方布局 / 非标准 env 名称不会被自动识别；`PI_CODING_AGENT_DIR` 是用户对齐自定义布局的覆盖手段。
  - 代码验证：双环境密封测试全绿，共 243 条测试；实现涉及 `pi-cwd-encoder.ts`、`pi-process.ts`、`index.ts` 及两份测试文件，commit `1985fbd`。

## 双向引用

- [[architecture/decisions/0003-session-lifecycle-and-history-source.md|ADR-0003]] —— session 历史仍来自本地 pi 文件；本 ADR 将其扫描基准从历史隔离目录修订为宿主机 agent 目录。
- [[architecture/decisions/0006-protocol-v1-get-state-unlock.md|ADR-0006]] —— M3 在协议锁步条件下接受必要设计修订的先例；共享 session 仍通过既有恢复仪式接入。
- [[tasks/m3/09-host-shared-agent-dir.md|tasks/09]] —— 本次去隔离改造的事后补录任务（commit `1985fbd` + 文档链）。
- [[prds/m3-single-session.md|M3 PRD]] —— §2.3 / §2.5 与用户操作清单保留原隔离设计作为历史，修订注记指向本 ADR。

## 验证与后续

- commit `1985fbd` 已落地 spawn 不注入 env、`resolvePiAgentDir()` 语义对齐、共享目录扫描、auth 缺失 warn 及双环境密封测试。
- ~~M4 候选：检测共享模式下 session 是否被外部进程占用，以降低同会话双写风险。~~ **正式关闭**（2026-09-08 用户裁定 / [[tasks/m4/09-docs-sync.md|任务 09 docs-sync]]）：M4 不实施"会话被外部占用检测"（PRD §修订注记业务共识 3：会话占用完全不检测，无检测、无提示、无特殊处理，对齐 pi TUI 行为）。同会话双写后果由用户行为约定规避（与 M3 同口径）。
