// Standalone fake LLM server child process — see fake-llm-process.ts
// for the parent-side harness.
//
// Boots the same `startFakeLlmServer` from the integration suite but
// in a separate Node process so it survives Playwright's globalSetup
// teardown. The parent reads the listening URL from stdout's first
// line (`FAKE_LLM_URL=http://127.0.0.1:<port>`) and then leaves the
// child running for the rest of the test run; teardown sends SIGKILL.
//
// We print the banner BEFORE installing any signal handlers so a
// fast `await page.goto()` in the parent doesn't race the print.
// `process.stdout.write` is used (not `console.log`) so the line is
// flushed atomically with the URL — Node's `console.log` adds a
// trailing newline that we keep anyway, and the parent parses with
// a regex that's newline-tolerant.

import { startFakeLlmServer } from '../../integration/helpers/fake-llm-server.js';

async function main(): Promise<void> {
  const server = await startFakeLlmServer();
  // Print the banner as the FIRST stdout write so the parent's
  // parsing doesn't race with any future log lines.
  process.stdout.write(`FAKE_LLM_URL=${server.url}\n`);
  // Keep the process alive. `http.Server` itself keeps the event
  // loop busy (active socket listener), but we add a no-op interval
  // as a defensive "definitely-alive" anchor in case a future
  // refactor makes the server internally self-driving.
  const keepAlive = setInterval(() => undefined, 60_000);
  // SIGTERM is the graceful path; SIGKILL is also fine (parent uses
  // SIGKILL on the process group for fast teardown). We unref the
  // interval so a signal-driven exit doesn't have to wait for the
  // tick to elapse.
  keepAlive.unref();
  // We don't install a separate close() hook — the parent's
  // SIGKILL handles teardown.
}

void main().catch((err: Error) => {
  // Print a structured error on stderr so the parent's stderr tail
  // surfaces the cause. Exit non-zero so the parent's `child.on('exit')`
  // rejection fires.
  process.stderr.write(`fake-llm-standalone failed: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});
