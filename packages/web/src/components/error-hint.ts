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
