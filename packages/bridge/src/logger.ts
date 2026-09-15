// Minimal logger for the bridge daemon. Three levels (info / warn / error)
// with an ISO-8601 timestamp and a `[bridge]` tag so log lines are easy to
// grep when running under nohup or in a systemd journal.
//
// `info` and `warn` write to stdout (PRD §2: "stdout 输出"); `error`
// writes to stderr so log-aggregators + systemd journal can separate
// fatal signals from routine lifecycle chatter without parsing the
// `[bridge] error` token. The `[bridge] <level>` prefix is preserved
// across all three levels so grep filters keep working.
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
  info(...args: unknown[]): void {
    console.log(format('info', args));
  },
  warn(...args: unknown[]): void {
    console.log(format('warn', args));
  },
  error(...args: unknown[]): void {
    console.error(format('error', args));
  },
};

/** Structural type for the bridge logger — accepts a function that
 *  emits an `info` line. The `warn` and `error` levels are
 *  intentionally not part of the contract because the modules
 *  that accept a `Logger` only need `info` (a future extension can
 *  broaden the type without breaking callers). */
export interface Logger {
  info(...args: unknown[]): void;
}
