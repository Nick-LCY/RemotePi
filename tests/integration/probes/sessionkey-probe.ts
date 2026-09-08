// One-off probe (M4 task 06 — PRD §1.5 实测验证点) — spawns a real
// `pi --mode rpc` subprocess and observes:
//   1. the ORDER of stdout events (event names in arrival sequence)
//   2. WHEN the `<agentDir>/sessions/--<token>--/<timestamp>_<uuid>.jsonl`
//      file appears on disk (relative to those events)
//
// The bridge needs to derive `sessionKey` from `agentStart`'s
// `sessionFile` field on the very first event after `agent_start`
// fires. The probe tests BOTH:
//   - "session file already exists when agent_start fires" (most common
//     case for resumed sessions — `--session` was passed, the file
//     was created at spawn time)
//   - "session file created lazily on first entry" (the case PRD §1.5
//     warns about — fresh `session: 'new'` with no `--session` flag,
//     pi defers the file creation until it has content to write)
//
// Run with:
//   pnpm tsx tests/integration/probes/sessionkey-probe.ts
//
// The probe writes a `probe-result.json` summary next to the fixture
// so the implementer can read off the timing data without parsing
// stdout.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { startFakeLlmServer, textReply } from '../helpers/fake-llm-server.js';
import { makeAgentDir } from '../helpers/make-fixture.js';

interface ProbeEvent {
  /** wall-clock ms since probe start */
  t: number;
  /** raw frame `type` discriminator */
  type: string;
  /** selected fields (best-effort) */
  fields: Record<string, unknown>;
}

interface ProbeResult {
  startTs: number;
  agentDir: string;
  workDir: string;
  case: 'with-session-flag' | 'without-session-flag';
  events: ProbeEvent[];
  sessionFile: string | null;
  sessionFileFirstSeen: number | null;
  agentStartEvent: ProbeEvent | null;
  firstEntryAppended: ProbeEvent | null;
  firstMessageStart: ProbeEvent | null;
  agentStartAt: number | null;
  spawnedAt: number;
  handshakeReceivedAt: number | null;
}

async function runProbe(
  caseName: 'with-session-flag' | 'without-session-flag',
): Promise<ProbeResult> {
  const fakeLlm = await startFakeLlmServer();
  fakeLlm.script([textReply('hello probe')]);
  const fixture = await makeAgentDir({ fakeLlmBaseUrl: fakeLlm.url, runTag: `probe-${caseName}` });

  const result: ProbeResult = {
    startTs: Date.now(),
    agentDir: fixture.agentDir,
    workDir: fixture.workDir,
    case: caseName,
    events: [],
    sessionFile: null,
    sessionFileFirstSeen: null,
    agentStartEvent: null,
    firstEntryAppended: null,
    firstMessageStart: null,
    agentStartAt: null,
    spawnedAt: 0,
    handshakeReceivedAt: null,
  };

  // Mirror the bridge's spawn command: `pi --mode rpc [--session <path>]`
  const args = ['--mode', 'rpc'];
  if (caseName === 'with-session-flag') {
    // Pre-create a session file so pi picks it up. Mimics "restart of
    // an existing session" — the file path is well-defined, the stem
    // becomes the sessionKey we'd feed `--session`.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionFile = path.join(
      fixture.agentDir,
      'sessions',
      `--${fixture.workDir.replace(/[/\\]/g, '-')}--`,
      `${stamp}_${randomUUID()}.jsonl`,
    );
    const sessionDir = path.dirname(sessionFile);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, '', 'utf8');
    args.push('--session', sessionFile);
  }

  const startTs = result.startTs;
  const child: ChildProcess = spawn('pi', args, {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: fixture.agentDir,
      PI_OFFLINE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: fixture.workDir,
  });
  result.spawnedAt = Date.now() - startTs;

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let nl = stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      handleFrame(line);
      nl = stdoutBuffer.indexOf('\n');
    }
  });

  // Periodic fs scan so we don't miss the jsonl if it appears between
  // stdout frames.
  const watcher = setInterval(() => {
    const sessionsRoot = path.join(fixture.agentDir, 'sessions');
    if (existsSync(sessionsRoot)) {
      walkForJsonl(sessionsRoot);
    }
  }, 50);

  function handleFrame(line: string): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '?';

    const fields: Record<string, unknown> = {};
    for (const k of ['command', 'event', 'id', 'sessionFile', 'session_file', 'message_id']) {
      if (k in obj) fields[k] = obj[k];
    }

    const event: ProbeEvent = { t: Date.now() - startTs, type, fields };
    result.events.push(event);

    if (type === 'agent_start') {
      result.agentStartEvent = event;
      result.agentStartAt = event.t;
      const sessionFile =
        (fields.sessionFile as string | undefined) ??
        (fields.session_file as string | undefined);
      if (typeof sessionFile === 'string') {
        result.sessionFile = sessionFile;
      }
    }
    if (type === 'message_start' && result.firstMessageStart === null) {
      result.firstMessageStart = event;
    }
    if (type === 'entry_appended' && result.firstEntryAppended === null) {
      result.firstEntryAppended = event;
    }
  }

  function walkForJsonl(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walkForJsonl(full);
      } else if (entry.endsWith('.jsonl') && result.sessionFile === null) {
        result.sessionFile = full;
        result.sessionFileFirstSeen = Date.now() - startTs;
      }
    }
  }

  // Write handshake so pi responds and the prompt fires.
  child.stdin.write(JSON.stringify({ type: 'get_state', id: 'probe-handshake' }) + '\n');

  // Wait a bit for the round-trip (prompt + reply + agent_settled).
  await new Promise<void>((resolve) => setTimeout(resolve, 8000));

  // Send a prompt so we can observe entry_appended / message_start.
  child.stdin.write(
    JSON.stringify({ type: 'prompt', id: 'probe-prompt', message: 'hello probe' }) + '\n',
  );

  // Wait for the reply + settlement.
  await new Promise<void>((resolve) => setTimeout(resolve, 5000));

  // Final scan in case the file appeared late.
  walkForJsonl(path.join(fixture.agentDir, 'sessions'));
  clearInterval(watcher);

  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));

  await fakeLlm.close();
  await fixture.cleanup();
  return result;
}

async function main(): Promise<void> {
  const withFlag = await runProbe('with-session-flag');
  const withoutFlag = await runProbe('without-session-flag');
  const out = path.join(process.cwd(), 'tests/integration/probes/probe-result.json');
  writeFileSync(
    out,
    JSON.stringify({ withFlag, withoutFlag }, null, 2),
    'utf8',
  );
  // eslint-disable-next-line no-console
  console.log(`probe results written to ${out}`);
  // eslint-disable-next-line no-console
  console.log('--- summary ---');
  // eslint-disable-next-line no-console
  console.log(`with-session-flag:`);
  // eslint-disable-next-line no-console
  console.log(`  events: ${withFlag.events.map((e) => e.type).join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  agent_start at: ${withFlag.agentStartAt} ms`);
  // eslint-disable-next-line no-console
  console.log(`  sessionFile: ${withFlag.sessionFile}`);
  // eslint-disable-next-line no-console
  console.log(`  firstSeen:   ${withFlag.sessionFileFirstSeen} ms`);
  // eslint-disable-next-line no-console
  console.log(`  firstEntryAppended at: ${withFlag.firstEntryAppended?.t} ms`);
  // eslint-disable-next-line no-console
  console.log(`without-session-flag:`);
  // eslint-disable-next-line no-console
  console.log(`  events: ${withoutFlag.events.map((e) => e.type).join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  agent_start at: ${withoutFlag.agentStartAt} ms`);
  // eslint-disable-next-line no-console
  console.log(`  sessionFile: ${withoutFlag.sessionFile}`);
  // eslint-disable-next-line no-console
  console.log(`  firstSeen:   ${withoutFlag.sessionFileFirstSeen} ms`);
  // eslint-disable-next-line no-console
  console.log(`  firstEntryAppended at: ${withoutFlag.firstEntryAppended?.t} ms`);
  // eslint-disable-next-line no-console
  console.log(`  firstMessageStart at: ${withoutFlag.firstMessageStart?.t} ms`);
}

// Run if executed directly via `tsx`. Vitest imports this as a module
// too (in which case `main()` shouldn't auto-fire).
const argv1 = process.argv[1];
if (argv1 !== undefined) {
  let resolvedArgv1: string;
  try {
    resolvedArgv1 = fileURLToPath(import.meta.url);
  } catch {
    resolvedArgv1 = '';
  }
  const argvBase = argv1.endsWith('.ts') ? argv1.replace(/\.ts$/, '.js') : argv1;
  if (argvBase === resolvedArgv1 || argv1 === resolvedArgv1) {
    void main();
  }
}

export { runProbe };
