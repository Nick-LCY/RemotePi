---
prd: prds/m4-multi-session.md
status: done
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

## 完成情况

任务完成，2 笔本地 commit：**`b55c884`**（实施：`packages/bridge/src/list-directories.ts` 纯函数模块全集 + `pi-process.ts` `handleEnvelope` 加 `list_directories` 分支作为**临时宿主** + session 透传 + **+29 测试**）+ **`46de0df`**（review 修复轮：control.md §6.6 失败码段就地落档实际映射决策 / 测试清理删 15z no-op / 尾换行 / 尾斜杠边界测试 10c +1 / TOCTOU 注记 / dispatcher 窄校验）。reviewer 初审结论 **0 Critical / 4 Warning / 8 Suggestion**——**关键可达性疑点实证排除**：`manager` 由 `start()` 同步构造并立即绑定 `handleEnvelope`，无 spawn 时 `list_directories` 走纯 fs 路径可达，ChoicePage level1 首用场景 OK（任务 06 才把临时宿主迁入 `BridgeSessionLayer`）。测试 **417 → 446**（S2 +1 / W3 -1 净 0，**全绿**）。

### `b55c884` 实施（`list-directories.ts` 纯函数 + `handleEnvelope` 临时宿主 + +29 测试）

- **`packages/bridge/src/list-directories.ts` 新建**——`control/list_directories` 纯函数模块全集，与 `pi-process.ts` 解耦（任务 06 才迁入 `BridgeSessionLayer`）：
  - **`listDirectories(inputPath: string | undefined): ListDirectoriesOutcome`**——discriminated union 返回（`{ ok: true, data } | { ok: false, code, message }`），**不抛异常**走控制流；模块头注明"domain-level outcome 与 wire-level ErrorCode 严格分层：domain code 由 `listDirectories` 持有，wire code 由 dispatcher 单点映射"。
  - **`resolveOrHome(inputPath)`**——`undefined` → `os.homedir()`；提供时 → `path.resolve(inputPath)` 规范化（POSIX 语义内置处理 `..` / 多斜杠 / 相对路径；空串 → cwd 不报错，schema 已拒 null/non-string）。
  - **`preflight(resolvedPath)` 三件套独立分支**——复用 [[tasks/m4/04-bridge-state-json.md|任务 04 state.ts]] 思路（statSync + isDirectory + accessSync R_OK 三件套独立分支）：①`statSync` 失败 → ENOENT → `path_not_found` / EACCES 或 EPERM → `path_not_readable` / 其他（ELOOP/ENAMETOOLONG/EIO...）→ `internal`；②`!stat.isDirectory()` → `path_not_directory`（文件 / 符号链接到文件 / socket / 设备 一律拒；PRD §2.5 语义是"列子目录"，非目录无可枚举子）；③`accessSync(resolvedPath, constants.R_OK)` 失败 → `path_not_readable`（独立 syscall from stat：stat 成功但 mode 禁 R_OK 的场景显式表面化）。
  - **`readDirectoryEntries(resolvedPath)`**——`readdirSync(resolvedPath, { withFileTypes: true })` + `dirent.isDirectory()` 过滤（**不含文件**）；**dotfile 目录包含**（`.config` / `.cache` 等 dotfile 前缀目录照列，与 unix `ls -l` 默认行为一致——是否在 UI 层过滤属产品关注点，非 wire 契约）；字典序排序（`Array.sort` 不带 comparator 默认 code-point 比较，ECMAScript 2019+ 保证稳定性，省 locale-aware 复杂度）。
  - **TOCTOU 注记**——`preflight` 与 `readDirectoryEntries` 之间存在删除（readdir ENOENT）或替换（readdir ENOTDIR）竞态，catch 块**复用** `path_not_found` / `path_not_directory` 映射（与 preflight 阶段同一 message），保证操作员看到一致错误信息；**不**为这两个分支写单测（hermetic tmpdir 合成精确 TOCTOU 不实际，integration / e2e 是合适层）。
  - **`ListDirectoriesResultSchema.safeParse` 防御性重验**——构造完 `{ entries }` 后立即 `safeParse` 一次，catch 内 `logger.error` 输出 schema issue 详情，回 `internal`（"list_directories produced an invalid result shape"）；防止未来重构改了 `name` / `path` 字段名或类型让本函数产出不再 schema-valid 的 data，dispatcher 会把畸形 `result.data` 静默发出让 web 的 zod refine 失败而不知根因。
  - **`mapListDirectoriesDomainCodeToWire(domainCode): ErrorCode`**——单点映射函数：domain `internal` → wire `internal`；其余三个（`path_not_found` / `path_not_readable` / `path_not_directory`，用户输入路径在 fs 语义上不可列）→ 全部收敛到 wire `invalid_envelope`；**映射表是单点真理**，dispatcher 只调用不重新实现（详见下方「**错误码映射决策**」段）。
- **`packages/bridge/src/pi-process.ts` `handleEnvelope` 加 `list_directories` 分支（**临时宿主**）**——本任务只把 list_directories 接线进 `handleEnvelope`（与 `get_state` 同级：list_directories 也不需要 pi 进程，handler 内同步调 `listDirectories(payload.path)` + `mapListDirectoriesDomainCodeToWire` + 组装 `result` envelope 通过现有 outbound 机制回 web）；session 字段**透传**（不触发 spawn、不查 manager.phase、不读 state.json——纯 fs 操作与 session 无关）；**注释明示迁移路径**：`// TODO(task 06): 迁移 list_directories handler 至 BridgeSessionLayer（与 work_dir_* + session_list 一并迁入，临时宿主到 06 关闭）`。
- **测试 +29 条**（`__tests__/list-directories.test.ts` 新建）：home 起点（不传 path → 返回 `$HOME` 子目录）/ 任意路径（`/home/sankabox/code` → 返回 code 子目录）/ 不存在路径（ENOENT → `path_not_found`）/ 不是目录（ENOTDIR → `path_not_directory`）/ 不可读（EACCES → `path_not_readable`，mock fs）/ dotfile 目录包含 / 字典序排序 / `path.resolve` 规范化（相对路径 / `..` / 多斜杠）+ 15a-15e 接线测试（dispatcher `handleEnvelope` 收到 `list_directories` envelope → 调 `listDirectories` → 映射 → 组装 `result` 回 web envelope 形状 / 不触发 spawn / session 字段透传 / 失败回执 envelope 形状 / message 透传）等。

### `46de0df` review 修复轮（**0C / 4W 处置 / 8S 处置**，关键可达性疑点实证排除）

- **关键可达性疑点实证排除（reviewer 早期疑虑）**——`BridgeClient` 收 envelope → `manager.handleEnvelope` 路由 → list_directories 走 `handleListDirectories` 分支。疑虑：`manager` 由 `start()` 同步构造并立即绑定 `handleEnvelope`，**但** ChoicePage level1 首用场景在用户尚未与任何会话交互时触发 list_directories（添加新 work_dir 入口），此时 map 可能为空 → 是否有 manager 可路由？**实证**：任务 05 把 handler 直接装进 `pi-process.ts` 的 `handleEnvelope`（与 `get_state` 同级），`get_state` 历来无 manager 时返回内存默认 phase / blocked_on 而不报错（bridge client 现有 inbound 路径经 `manager` 构造函数注入即绑定，不需要 map 也不需要 spawn）。list_directories 同形态：**纯 fs 操作与 manager 无关**，handler 内不依赖 `managers` map、不查 phase、不读 state.json；临时宿主位置已具备"无 spawn 可达"性质。**结论**：ChoicePage level1 首用场景 OK；任务 06 迁入 `BridgeSessionLayer` 时维持该不依赖（`listDirectories` 仍纯函数 + handler 仍只调 `listDirectories` + 映射 + 组装回执）。
- **review 修复轮落地项**（4W + 8S 总 12 项）：
  - **W1 control.md §6.6 失败码段就地落档实际映射决策**——控制.md §6.6 原"回执失败"段仅一句"复用 §8 已锁版的 6 个 code 集合（不新增——ADR-0010 §决策.8）"，实施期映射决策未落档。本轮把决策就地写入控制.md §6.6：ENOENT / EACCES / EPERM / ENOTDIR → wire `invalid_envelope` + `error.message` 携带 domain 区分（`path_not_found` / `path_not_readable` / `path_not_directory`）便于运维定位；EIO / ELOOP / 其他非预期 fs 错误（stat / accessSync / readdir 三处任一抛出未分类 errno）→ wire `internal`；映射表是单点真理 + 语义注记（`invalid_envelope` 在 list_directories 上下文中扩展为"envelope payload 指向不可用的 fs 实体"——并非 envelope 结构本身错误，结构错误仍走 M3 §8 原义；domain code 落在 message 字段，wire code 统一收敛）。控制.md §6.6 dotfile 行为段一并补"列出所有子目录（含 dotfile 前缀目录，如 `.config` / `.cache`），UI 层可选择性过滤——属产品 UI 关注点，非 wire 契约"（实施行为 vs PRD §2.5 隐含约定的钉桩）。
  - **W2 dispatcher 窄校验**——`handleListDirectories` 接到 envelope 后只校验三件事：①`payload.path` 是 `string | undefined`（其他类型拒，schema 应已在 dispatcher 入口先走 zod refine 失败，但作为防御性兜底——dispatcher 假设 schema 已通过，本层不重复 zod refine，只对 runtime shape 兜底）；②结果 envelope 形状按 schema 构造（避免 `result` 字段错位）；③`id` / `reply_to` 严格透传（不读不写）。reviewer 早期提"dispatcher 边界过宽可能误处理其他 type"——本轮收窄到三步校验 + 单一出口（成功回执 / 失败回执 / 解析失败 internal 三态），无 fall-through 风险。
  - **W3 测试清理（删 15z no-op，-1 测试）**——原 15z 用例是"session 字段为 `undefined` 时 handler 行为"——既不触发 spawn 也透传 undefined，等价于"无 session 字段"；删除以免与已有"无 session"用例重复（任务 04 教训：naming 一致性 + 无意义边界 stub 早删优于保留做"覆盖率虚荣"）。
  - **W4 关键可达性疑点实证排除 + 实现确认**（见上段）——非"修复"而是 reviewer 早期疑问的"实证答卷"，落档于 `pi-process.ts` `handleListDirectories` 注释 + 任务评审纪要。
  - **S1-S8** 含：尾换行修正 / 尾斜杠边界测试（10c，+1 测试——`path.resolve('/home/sankabox/')` 与 `'/home/sankabox'` 等价语义，尾斜杠不引发 ENOTDIR）+ TOCTOU 注记（模块头 + dispatcher 注释）+ `mapListDirectoriesDomainCodeToWire` 单点映射提取（避免 dispatcher 重复 switch）+ dotfile 行为落档控制.md §6.6 + `preflight` 与 `readDirectoryEntries` 函数级注释（domain-level outcome vs wire-level 翻译分层）+ 错误 message 含原始 errno（运维定位）+ 测试用例命名统一（如"home-default" / "explicit-path" / "path-not-found" / "path-not-readable" / "path-not-directory" / "dotfile-included" / "lexicographic-sort" / "resolve-normalization" 等）；**净 0 测试数变化**（S2 尾斜杠边界 +1 / W3 删 15z -1 = 净 0）。

### 错误码映射决策（重要，需记录）

- **PRD §2.5 字面 vs 实施裁决**——PRD §2.5 字面写"路径不存在 / 不可读 / 不是目录 → `result.ok = false` + `error.code: 'invalid_path'`（沿用 control.md §8 6 个 code 集合；选 `internal` 兜底，或复用 `invalid_envelope`——实施期选最贴切的）" + 紧接"ENOENT / EACCES / ENOTDIR 各分支错误码独立（M3 §2.1 配置校验的同类做法）"——**两条字面表述存在张力**：
  - 字面要求 wire code 独立（M3 §2.1 配置校验的 ENOENT / EACCES / ENOTDIR **确实是各自不同的 wire code**——但 M3 那三支分别回 `result.ok = false` 无 envelope 回执的 *配置校验* path，不走 list_directories 这条 control 命令，**两者语义不同**）。
  - 控制.md §8 / [[architecture/decisions/0010-protocol-v3-multi-session-unlock.md|ADR-0010 §决策.8]] 强约束："复用既有 6 code 集合不新增；按实施期最贴切选 invalid_envelope / internal"——**与 PRD 字面"独立 code"冲突**（PRD 字面"独立"≠ 6 code 集合字面"6 个"——独立也可能是"独立 semantic"而非"独立 wire enum value"）。
  - **实施裁决**（与控制.md §6.6 同步落档）：**wire 级合并**——ENOENT / EACCES / EPERM / ENOTDIR 四类 fs 失败 → 统一 wire `invalid_envelope`，`error.message` 携带 domain 区分（`path_not_found` / `path_not_readable` / `path_not_directory`）；EIO / ELOOP / 未分类 errno → wire `internal`。**domain 级独立、wire 级收敛**——既满足 PRD §2.5"独立"意图（每类失败有独立 message，运维可定位），又严守 ADR-0010 §决策.8"不新增 wire code"约束。
- **控制.md §6.6 落档去向**——本次 review 修复轮（W1）已**就地**在 [[architecture/protocol/control.md#6.6-list_directories|控制.md §6.6]] 写入映射表 + 语义注记（`invalid_envelope` 在 list_directories 上下文扩展义）+ dotfile 行为注记；任务 [[tasks/m4/09-docs-sync.md|09 docs-sync]] 仅需校对"控制.md §6.6 与 PRD §2.5 表述差异"作为破锁依据引用（沿用 ADR-0010 §决策.8 风格），无需重写。
- **完成标准第 3 条「6 个分支独立」按本口径理解**——任务 05 完成标准原写"错误码 6 个分支独立：合法 / ENOENT / EACCES / ENOTDIR / 非法类型 / 内部错误"——按上述裁决理解为"**domain 级独立、wire 级收敛**"：domain 6 分支（合法 / ENOENT / EACCES / EPERM / ENOTDIR / 内部）由 `listDirectories` 暴露为 `ListDirectoriesDomainCode` 五枚举值（合并 EPERM 入 EACCES 同 bucket）；wire 6 code 集合（控制.md §8）不破锁，落地为两类 wire code（`invalid_envelope` / `internal`）由 `mapListDirectoriesDomainCodeToWire` 单点翻译。**完成标准第 3 条与 PRD §2.5 + 控制.md §8 三方字面张力按本裁决闭环**。

### 5 项边界决策要点

1. **纯函数 + dispatcher 分离**——`list-directories.ts` 是 pure function 模块（不依赖 `manager` / `state.json` / `client` / `logger` 之外的任何运行时状态），可独立测试；dispatcher（`handleListDirectories`）只做 envelope 形状处理 + 调纯函数 + 映射 + 组装回执——这种分离让任务 06 迁入 `BridgeSessionLayer` 时只需把 dispatcher 从 `pi-process.ts` 搬到 `session-layer.ts`，纯函数原样搬。
2. **discriminated union 而非 throw**——`listDirectories` 返回 `{ ok, ... }` 而非抛异常：dispatcher 的三分支（成功 / domain-error / revalidation-fail）用 case 处理比 try/catch 嵌套更清晰；纯函数可单测，无须 mock 异常路径。
3. **dotfile 目录包含**——`dirent.isDirectory()` 一律放行，dotfile 前缀目录（`.config` / `.cache`）照列；web UI 层是否过滤属产品关注点（部分用户想看 `.ssh` / `.aws` 等隐藏目录，部分想过滤），不是 wire 契约层。控制.md §6.6 已就此明文钉桩——避免任务 07 / 任务 08 UI 落地时争议"是不是 wire 层应过滤 dotfile"。
4. **TOCTOU 不单测、不引入锁**——`preflight` 与 `readDirectoryEntries` 间的 TOCTOU 竞态（路径被删 / 被替换为文件）由 catch 块复用 domain code 兜底，**不**做锁（路径列子目录是单步操作、并发冲突窗口极窄、不持有任何共享资源、bridge 进程单实例——引入文件锁得不偿失）；**不**为这两个分支写单测（hermetic tmpdir 合成精确 TOCTOU 不实际）——模块头注释 + dispatcher 注释明示"竞态存在但接受"，integration / e2e 套件是合适验证层。
5. **`path.resolve` 而非自实现规范化**——POSIX `path.resolve` 已正确处理 `..` / 多斜杠 / 相对路径 → 绝对路径 / 尾斜杠，跨平台语义稳定（POSIX 下行为一致）；不引入 `path-clean` / `normalize-path` 等三方依赖换"自以为更严格"的语义——任何偏离 `path.resolve` 的实现都会引入"与 Node 标准库行为不一致"的隐藏 bug。

### S1 移交义务（任务 [[tasks/m4/06-bridge-session-layer.md|06]] 接收）

- **`list-directories.test.ts` 的 15a-15e 接线测试随迁**——任务 06 把 `list_directories` handler（连同 `work_dir_*` + `session_list` control）从 `pi-process.ts` 临时宿主迁入 `BridgeSessionLayer` 时，`list-directories.test.ts` 的 15a-15e 五条接线测试（dispatcher 接到 envelope → 调 `listDirectories` → 映射 → 组装 `result` 回 web envelope 形状 / 不触发 spawn / session 字段透传 / 失败回执 envelope 形状 / message 透传）应**随 handler 一起迁移到 session-layer 测试**（如 `__tests__/session-layer-list-directories.test.ts` 或并入 `session-layer.test.ts` 的 list_directories 段），避免删 `pi-process.ts` 的 `handleListDirectories` 分支后这五项测试因 mock target 失效而误报。
- **纯函数测试（happy-path / 错误码 / dotfile / 排序 / 规范化等约 24 条）保持不动**——`list-directories.ts` 纯函数模块不变，pure-function 测试继续在 `__tests__/list-directories.test.ts`；迁移动作只影响 dispatcher 接线层的 5 条（15a-15e）。
- **控制.md §6.6 + dotfile 行为钉桩**——任务 06 实施期不必重写 §6.6（已经按本任务 review 修复轮 W1 落档到位）；任务 [[tasks/m4/09-docs-sync.md|09 docs-sync]] 校对"控制.md §6.6 与 PRD §2.5 表述差异"作为破锁依据引用即可。

### 测试 / 构建基线

- 全仓 **417 → 446 全绿**（+29 净新增；S2 +1 / W3 -1 净 0；既有 417 测试零回归——M3 / M4 任务 01-04 测试基线未被 `list_directories` 引入回归）。
- bridge 包单测基线：**254 → 283**（state +49 任务 04 落地后 → list_directories +29 任务 05 落地后）；bridge 包零既有测试删除（15z no-op 删除对应 -1 在 +29 净增内消化）。
- `typecheck` / `lint` / `build` 全绿；`packages/bridge` 仅 `src/list-directories.ts`（新建）+ `src/pi-process.ts`（handleEnvelope 加 list_directories 分支 + 临时宿主 TODO 注释）+ `__tests__/list-directories.test.ts`（新建 29），共 1 文件新建 + 2 文件改；`packages/shared` / `packages/web` / `packages/worker` 零改动（任务 02 协议层已锁版，本任务纯消费侧）。

### 与 [[tasks/m4/04-bridge-state-json.md|任务 04]] / [[tasks/m4/02-shared-protocol-v3.md|任务 02]] 对照

| 维度 | M4 任务 [[tasks/m4/02-shared-protocol-v3.md\|02]] | M4 任务 [[tasks/m4/04-bridge-state-json.md\|04]] | M4 任务 05（本任务） |
|------|---------------------------------|---------------------------------|---------------------|
| 测试基线 | shared 308 不变（schema 任务零回归）| bridge 154 → 201 → 254（+100；state +49 + index +5 + 早启迁移校验 +6 + review 修复补 +40）| bridge 254 → 283（+29 净；dispatcher 接线 +5 + 纯函数 +24；S2 +1 / W3 -1 净 0）|
| 新建文件 | `control.ts` / `work-dirs.ts` / `session-list.ts` 等 schema 模块 | `state.ts` + `__tests__/state.test.ts` | `list-directories.ts` + `__tests__/list-directories.test.ts` |
| 关键 seam | envelope `session` 启用规则（schema 仍 optional）+ 4 新 type + ADR-0010 | `statePath` 构造参数 + `WorkDirStore` 类 + `StateError` class | 纯函数 `listDirectories` + `mapListDirectoriesDomainCodeToWire` 单点映射 + dispatcher 临时宿主 |
| review 结论 | 0C / 4W / 7S（6 项落地 + S1/S3/S5 三项递延任务 09）| **1C 闭合 / 6W 全修 / 4S 处置**（S2 转任务 06 义务：StateError→internal 映射）| **0C / 4W / 8S**（4W 全处置 + 8S 全处置；关键可达性疑点实证排除 + S1 移交任务 06：list_directories 接线测试随迁）|
| 教训承接 | M3 `1c86aca` worker 转发链教训（破锁同步补 default）| M3 `config.ts` 三件套模式延伸 + atomic write POSIX 语义钉桩 + 规格级 fail-fast 补漏 | M3 §2.1 三件套校验模式（preflight）/ M3 `normalizeCommandError` 同类"domain-level outcome + wire-level 翻译"分层 / 关键可达性疑点实证排除（与 [[tasks/m3/04-bridge-pi-process.md\|m3/04]] 教训一类：handler 边界早期疑问应在实施期直接实证）|