// BridgeStatusBar — the compact bridge status indicator for the
// sidebar footer (M5 §第二块 G5 / D8 / 任务 06 §d).
//
// The previous `<StatusBar>` component (which carried the bridge
// status at the top of the chat surface) has been split into two
// narrower components for the AppShell layout:
//
//   - **BridgeStatusBar (this file)** — compact variant for the
//     sidebar footer. Three conn-state badges (connecting /
//     online / offline) + the latest `bridge_status` reason
//     (collapsed to a single line; no timestamp / first-broadcast
//     placeholder text — the sidebar is dense already).
//
//   - **SessionStatusBar (separate file)** — the chat surface's
//     per-session status row (phase badge + queue pills +
//     session name). PhaseIndicator + QueueIndicator data sources
//     are reused (M4 task 08 / M5 task 01 chat-view surface) but
//     repackaged into a single horizontal bar at the top of the
//     chat panel.
//
// ## Three conn states map to three colour-coded badges
// (PRD §4 / docs/tasks/m2/05-web-components.md):
//
//   connecting → grey  (WebSocket is opening or handshake in flight)
//   online     → green (handshake accepted + heartbeat alive)
//   offline    → red   (close/error → reconnect scheduled)
//
// ## Why no "此 URL 含访问令牌" copy
//
// M5 §第二块 G6 / D9 — token moved out of the URL hash into
// localStorage. The old StatusBar's copy ("此 URL 含访问令牌")
// is gone, replaced with the bridge-side reachability rationale
// only ("Bridge <strong>reachable</strong> / <strong>gone</strong>
// · <reason>"). The `data-testid="bridge-status"` anchor stays
// for e2e 01 spec §6 (the spec polls `[data-testid="bridge-status"]
// [data-state="online"]` to wait for the WebSocket to be open
// before sending prompts — see tests/e2e/specs/01-first-turn.spec.ts).

import { useBridgeStatus, useConnState } from '../ws/WsClientContext.js';

const STATE_LABEL: Record<ReturnType<typeof useConnState>, string> = {
  connecting: 'Connecting',
  online: 'Online',
  offline: 'Offline',
};

/**
 * Compact bridge status indicator for the sidebar footer.
 *
 * The component is stateless — all data flows from the WsClient
 * store via `useConnState()` / `useBridgeStatus()`. The component
 * is intentionally small so the sidebar footer stays a single
 * horizontal row (BridgeStatusBar + settings button) — see
 * `Sidebar.tsx` for the layout.
 */
export function BridgeStatusBar(): JSX.Element {
  const state = useConnState();
  const bridge = useBridgeStatus();

  // M5 task 06 拆分——原 <StatusBar> 顶部的 `<header className="status-bar">`
  // 改成 sidebar 底部的紧凑徽章：保留 `data-testid="bridge-status"`
  // 锚点（e2e 01 spec §6 强依赖）+ `data-state` 属性（spec 按
  // state 过滤）；移除 wrap / 第一条 broadcast placeholder 文案
  // —— sidebar 已是密集布局，不再承载“等待首条 broadcast”提示。
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-3 py-1.5 text-xs"
      aria-label="Bridge status"
      data-testid="bridge-status"
    >
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.7rem] font-semibold text-white ${
          state === 'online'
            ? 'bg-state-online'
            : state === 'offline'
              ? 'bg-state-offline'
              : 'bg-state-connecting'
        }`}
        data-state={state}
      >
        {STATE_LABEL[state]}
      </span>
      <span className="text-muted">
        {bridge ? (
          <>
            Bridge <strong className="text-text">{bridge.online ? 'reachable' : 'gone'}</strong>
            {' · '}
            {bridge.reason}
          </>
        ) : (
          'Awaiting first bridge_status'
        )}
      </span>
    </div>
  );
}
