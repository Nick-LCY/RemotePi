// Minimal logger for the bridge daemon. Three levels (info / warn / error)
// with an ISO-8601 timestamp and a `[bridge]` tag so log lines are easy to
// grep when running under nohup or in a systemd journal. We deliberately
// avoid pino / winston — the bridge is a long-lived process whose only
// observability surface is stdout, and `console.*` is plenty for that.
//
// `info` and `warn` write to stdout (PRD §2: "stdout 输出"); `error`
// writes to stderr so log-aggregators + systemd journal can separate
// fatal signals from routine lifecycle chatter without parsing the
// `[bridge] error` token. The `[bridge] <level>` prefix is preserved
// across all three levels so grep filters keep working.
//
// `console.*` is acceptable in `packages/bridge/src/**` — see the ESLint
// flat config (`eslint.config.js`) which disables `no-console` there.
const PREFIX = '[bridge]';

function format(level: 'info' | 'warn' | 'error', args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  return `${ts} ${PREFIX} ${level} ${body}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  /** Routine lifecycle events — startup banner, connect / disconnect,
   *  reconnect scheduling. */
  info(...args: unknown[]): void {
    console.log(format('info', args));
  },
  /** Recoverable issues — invalid incoming envelope, send failure on a
   *  half-open socket, one-shot pong timeout. */
  warn(...args: unknown[]): void {
    console.log(format('warn', args));
  },
  /** Crashes + config load failures + rejected envelopes — anything a
   *  operator would page on. Routed to stderr so journald / log
   *  pipelines can split signal from noise without parsing the level
   *  token. */
  error(...args: unknown[]): void {
    console.error(format('error', args));
  },
};

/** Structural type for the bridge logger — accepts a function that
 *  emits an `info` line. Used by modules that need to log a
 *  one-shot lifecycle event (e.g. the M3→M4 work_dir migration
 *  notice in `state.ts`) and want to be testable without going
 *  through `console.log` directly. Mirrors the runtime shape of
 *  the `logger` const above; the `warn` and `error` levels are
 *  intentionally not part of the contract because the modules
 *  that accept a `Logger` only need `info` (and a future
 *  extension can broaden the type without breaking callers). */
export interface Logger {
  info(...args: unknown[]): void;
}
