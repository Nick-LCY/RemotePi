// Minimal logger for the bridge daemon. Three levels (info / warn / error)
// with an ISO-8601 timestamp and a `[bridge]` tag so log lines are easy to
// grep when running under nohup or in a systemd journal. We deliberately
// avoid pino / winston — the bridge is a long-lived process whose only
// observability surface is stdout, and `console.*` is plenty for that.
//
// All three levels write to stdout (PRD §2: "stdout 输出"). The `error`
// label is purely visual — the underlying stream is still stdout so the
// startup banner (token + share URL, printed by index.ts) and any later
// error log sit on the same stream that tests can capture.
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
  /** Reserved for future use; the bridge has no truly fatal conditions in
   *  M2 (everything is reconnect-friendly). Kept here for symmetry. */
  error(...args: unknown[]): void {
    console.log(format('error', args));
  },
};
