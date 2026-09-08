# 约定

编码、提交、命名等规范（稳定层）。

## 内容
- （待补充，如 `coding-style.md`、`commit-message.md`）
- **data-testid 约定**（见下文 §data-testid 约定（packages/web + tests/e2e））—— 稳定层首条实体约定

## 文档链接约定

文档间相互引用具体文件时，统一使用 wikilink 语法，路径相对 docs/ 根目录（例如指向 `[[architecture/overview.md]]`，从任意位置都写完整路径）。仅引用 docs/ 内已存在的文件，不留死链。文件名模式或占位符（如 `<feature>.md`、`NNNN-短标题.md`）使用行内代码，不写为 wikilink。

> 写法示例：`\[\[architecture/overview.md\]\]` 渲染为可见的 `[[architecture/overview.md]]`，避免在示例文本里被误判为真实链接。

## 清单
- data-testid 约定（见下文）

## data-testid 约定（packages/web + tests/e2e）

**用途**：E2E 断言抓手与样式解耦——`className` 服务样式、`data-testid` 服务断言，**互不引用**。新 web 组件按本约定补 testid。

**命名规范**（2026-09-08 [[tasks/m3/11-web-testid-hooks.md|tasks/m3/11]] 落定，全栈一致）：

- **容器** = 组件语义 / 区域名 kebab-case：`chat-view` / `message-list` / `dialog-confirm` 等
- **按钮** = `xxx-<动作>`：`input-send` / `input-abort` / `recovery-retry` / `dialog-confirm-yes` / `dialog-cancel` / `dialog-decline`
- **字段** = `xxx-field`：`input-field` / `dialog-input-field` / `dialog-editor-field`
- **错误 banner** = `<所属>-error`：`input-error` / `dialog-error`
- **计数**用 `data-count` 附属属性（如 `queue-indicator-steering` / `queue-indicator-follow-up`），数字一并透出便于断言

**既有钩子不动**：`chat-view` 的 testid、`PhaseIndicator` 的 `data-phase`、`StatusBar` 的 `data-state`、`RecoveryErrorCard` 的 `data-error` 为先行存在，**命名沿用不迁移**。

**纪律**：只加 `data-testid` 属性，不动 `className` / DOM 结构 / 文案 / 样式 / 状态机 / 事件流。

完整落点清单（22 处 `data-testid` + 2 处 `data-count`）见 [[tasks/m3/11-web-testid-hooks.md|tasks/m3/11]]。