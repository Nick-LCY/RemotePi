// M4 tasks/m4/01 §新错误文案 — 抽离到独立模块以便单元测试。
//
// PRD §6.2 + tasks/m4/01 §关键要点：
//  - `bridge_offline` 优先级最高（`bridgeStatus.online === false` 被
//    ceremony 第一时间检测，错误态独立区分"bridge 离线"）。
//  - `both_failed` 文案改明示"bridge 离线可能"——不是 snapshot/state
//    同时超时就是 bridge 离线，不再误引导到网络层面。
//  - `snapshot_failed` / `state_failed` 保留 M3 原文（任务 06/07）。
//
// 抽离动机：App.tsx 含 JSX/React 依赖，纯函数不适合混入 React 模块
// 渲染上下文（vitest 默认 node 环境跑纯 TS 测试）。本模块只依赖
// `RecoveryError` 联合类型，运行时 0 副作用，可直接 `import` 进测试。
//
// 用户可见性：消费方为 `App.tsx` 的 `RecoveryErrorCard`（`p` 元素
// 内嵌）；返回字符串为静态文案，PRD 锁定不变。

import type { RecoveryError } from '../ws/recovery.js';

/** Map a `RecoveryError` discriminator to the user-visible hint.
 *  Pure function — see file JSDoc for the rationale behind each
 *  string and the extraction to its own module. */
export function errorHint(error: RecoveryError): string {
  switch (error) {
    case 'bridge_offline':
      return 'bridge 当前离线。请检查 bridge 进程是否运行后重试。';
    case 'snapshot_failed':
      return '无法拉取历史消息（超时或返回失败）。请检查网络后重试。';
    case 'state_failed':
      return '无法拉取会话状态（超时或返回失败）。请检查网络后重试。';
    case 'both_failed':
      return 'bridge 离线或无法拉取会话状态与历史消息。请刷新页面或检查 bridge 状态后重试。';
    default:
      return '恢复失败，请重试。';
  }
}