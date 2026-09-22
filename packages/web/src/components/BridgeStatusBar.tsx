// BridgeStatusBar — 「远端连接」卡 in the sidebar footer.
//
// ## M6 T04 reference 重做 (D7)
//
// Replaces the M5 compact 2-line indicator with the reference
// three-node card:
//
//   ┌─ 远端连接 ──────────┐
//   │    网页   worker   pi      │  ← three size-7 rounded-lg
//   │    ────●──── ●───●── │     ← connector lines + dot
//   │   ● 链路正常           │     ← animate-ping heartbeat
//   └────────────────────────┘
//
// State-driven paint:
//   - online: emerald-300 connector line + emerald-500 dots +
//     animate-ping heartbeat + 「链路正常」 copy
//   - offline: grey-200 connector + grey-400 dots + no heartbeat
//     + 「链路断开」 copy
//   - connecting: grey-200 connector + grey-400 dots + grey
//     copy + 「连接中…」 copy
//
// Note: the reference uses raw Tailwind colour literals for the
// emerald-300 / emerald-500 palette because the project token
// system has no emerald variants (--state-online is the closest,
// but at the contrast ratio we want on this small surface the
// raw literal is more readable). Same rationale as the
// pre-existing `--state-online: #1f9d55` token: the state colour
// token is used for the "you have a problem" red + "this works"
// green, but the much-finer connector + dot palette lives at the
// emerald-300 / emerald-500 level — adding two more `--state-
// online-2 / -3` tokens would be over-tokenisation for what is
// effectively a 3-state indicator.
//
// ## testid 契约 (e2e 01 / 05 / 07 强依赖)
//
// `[data-testid="bridge-status"] [data-state="online"]` is the
// e2e anchor that polls until the WebSocket is open. The
// descendant-selector form survives the inner structure
// reshuffling (the `data-state` attribute is now on an inner
// span, same as M5). All previous testids (`bridge-status`) +
// data-attributes (`data-state`) preserved verbatim — D6
// zero-add / zero-delete.

import { useMemo } from 'react';

import { Bot, Globe2, Server } from 'lucide-react';

import { useBridgeStatus, useConnState } from '../ws/WsClientContext.js';

type ConnState = ReturnType<typeof useConnState>;

interface NodeSpec {
  /** Visible label under the node. */
  label: string;
  /** lucide icon component. */
  Icon: typeof Globe2;
  /** Text colour class when online (text-emerald-600 in the
   *  reference). Empty string means the node uses the muted
   *  inactive colour instead. */
  activeTextClass: string;
  /** True for the bridge node (animate-ping heartbeat attaches
   *  here, mirroring the reference). */
  isBridge: boolean;
}

const NODES: readonly NodeSpec[] = [
  { label: '网页', Icon: Globe2, activeTextClass: '', isBridge: true },
  { label: 'worker', Icon: Server, activeTextClass: 'text-accent', isBridge: false },
  { label: 'pi', Icon: Bot, activeTextClass: 'text-state-online', isBridge: false },
];

const STATE_COPY: Record<ConnState, string> = {
  online: '链路正常',
  offline: '链路断开',
  connecting: '连接中…',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BridgeStatusBar(): JSX.Element {
  const state = useConnState();
  const bridge = useBridgeStatus();

  // Compose the link-class strings once per state change so the
  // three connectors (web ↔ worker + worker ↔ pi) and the
  // three dots share a single source of truth. emerald when
  // online, slate when not — kept literal because (a) the
  // reference palette is fixed, (b) task 11 (dark contrast)
  // would rather see a literal here than a token with a dark
  // override that nobody else consumes.
  const linkClass = useMemo(() => {
    return state === 'online' ? 'bg-emerald-300' : 'bg-border-2';
  }, [state]);

  const dotClass = useMemo(() => {
    return state === 'online' ? 'bg-emerald-500' : 'bg-muted-4';
  }, [state]);

  const nodeTextColorClass = state === 'online' ? 'text-muted' : 'text-muted';
  // ^ The reference uses `text-[#687482]` for inactive labels.
  //   We tokenise via `text-muted` (same hex: `--muted: #687482`).

  return (
    <div
      // Outer container — reference 卡: rounded-xl bg-bg (the
      // sidebar surface already paints `--surface`, so we use
      // `--bg` as the slightly weaker nested card surface —
      // mirrors reference's `bg-[#f7f9fb]` which is the same
      // family as our `--bg` light mode value).
      className="rounded-xl bg-bg p-3"
      data-testid="bridge-status"
    >
      {/* Header row — small uppercase label on the left, optional
          ping latency on the right (left empty when no
          bridge_status message has arrived yet — matches
          reference's `24ms` place). */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-4">
          远端连接
        </span>
        <span className="text-[10px] text-muted-4">
          {bridge !== null && bridge.online ? 'online' : bridge !== null ? '离线' : ''}
        </span>
      </div>

      {/* Three-node link. flex items-center + equal flex-1
          connector gaps so the line spans the full width
          between the size-7 nodes. min-w-0 on each node
          prevents the label from forcing the node wider than
          size-7 (truncate would otherwise never fire). */}
      <div className="flex items-center justify-between gap-1">
        {NODES.map((node, idx) => (
          <NodeRow
            key={node.label}
            spec={node}
            state={state}
            linkClass={linkClass}
            dotClass={dotClass}
            textColorClass={nodeTextColorClass}
            showLeftConnector={idx > 0}
          />
        ))}
      </div>

      {/* State footer — caption row + (online-only) heartbeat.
          The `data-state` attribute is on this span to keep the
          e2e descendant selector working
          (`[data-testid="bridge-status"] [data-state="online"]`).
          The element is always present so the selector hits a
          visible node regardless of state. */}
      <div className="mt-2 flex items-center justify-center gap-1 text-[10px]">
        {state === 'online' ? (
          // Heartbeat dot — outer ping animation + inner solid
          // dot. `relative` on the outer span, `absolute` on
          // the ping layer so it expands from the inner dot's
          // centre. `inline-flex` for the row layout; the dot
          // itself is `inline-block` so the absolute ping layer
          // doesn't disturb the text baseline.
          <span className="relative inline-flex items-center" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-block size-1.5 rounded-full bg-emerald-500" />
          </span>
        ) : null}
        <span
          className={
            state === 'online'
              ? 'font-medium text-emerald-600'
              : state === 'offline'
                ? 'font-medium text-state-offline'
                : 'font-medium text-muted'
          }
          data-state={state}
        >
          {STATE_COPY[state]}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeRow — single size-7 rounded-lg icon block + 9px label.
// ---------------------------------------------------------------------------

interface NodeRowProps {
  spec: NodeSpec;
  state: ConnState;
  linkClass: string;
  dotClass: string;
  textColorClass: string;
  showLeftConnector: boolean;
}

function NodeRow({
  spec,
  state,
  linkClass,
  dotClass,
  textColorClass,
  showLeftConnector,
}: NodeRowProps): JSX.Element {
  const isActive = state === 'online';
  // Icon block paint: white surface + shadow + the spec's
  // text colour. Reference paints the active state with
  // `text-[#245bc4]` (accent blue) for the worker node +
  // `text-emerald-600` for the pi node; we tokenise the
  // accent blue to `text-accent` and keep the emerald literal
  // because we don't have an emerald-text token.
  const nodeIconClass = isActive
    ? `bg-surface shadow-sm ${spec.activeTextClass || textColorClass}`
    : `bg-surface shadow-sm ${textColorClass}`;

  return (
    <>
      {showLeftConnector ? (
        // Connector between two nodes — 1px horizontal line
        // plus a small dot at the centre. `flex-1` makes the
        // connector fill the available space between the two
        // nodes. `min-w-3` prevents the connector from
        // collapsing below the node width on tight viewports.
        <span
          className="flex min-w-3 flex-1 items-center"
          aria-hidden="true"
        >
          <span className={`h-px w-full ${linkClass}`} />
          <span className={`mx-1 inline-block size-1.5 rounded-full ${dotClass}`} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col items-center gap-1 text-[9px]">
        <span
          className={`flex size-7 items-center justify-center rounded-lg ${nodeIconClass}`}
        >
          <spec.Icon className="size-3.5" aria-hidden="true" focusable="false" />
        </span>
        <span className="truncate text-muted">{spec.label}</span>
      </span>
    </>
  );
}
