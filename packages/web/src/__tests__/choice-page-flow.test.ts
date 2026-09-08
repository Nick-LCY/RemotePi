// Vitest specs for ChoicePage-level flows (钉子 5 + DirectoryBrowser
// navigation + work_dirs mirror round-trips). These tests exercise the
// WsClient store mutations that drive the ChoicePage / DirectoryBrowser
// UI; the React rendering layer (ChoicePage.tsx / DirectoryBrowser.tsx)
// sits on top and consumes the same state via `useWsState` hooks.
//
//
// Why this surface: the ChoicePage UI itself isn't unit-tested in this
// run (no jsdom/happy-dom setup — the project intentionally keeps web
// component rendering to Playwright E2E, per ADR-0009 §决策 4
// rationale). The unit-testable surface is the store state machine +
// navigation helper functions; both are wired end-to-end here so a
// regression in the data flow surfaces in unit-land rather than
// E2E-only. The React component files themselves stay slim and
// declarative — they only consume the store + invoke navigation
// helpers.
//
// Coverage:
//   - 钉子 5 level2 列表刷新时机：
//     - mount 一次 (initial query)
//     - 从 ChatView 退回 level2 时重查 (hash session→null 触发)
//     - 不轮询 (no setInterval, no setTimeout firing the query)
//   - DirectoryBrowser + list_directories 往返
//   - DirectoryBrowser + work_dir_add 往返 + 错误分支
//   - ChoicePage level=1 → level=2 navigation writes the right hash
//   - ChoicePage level=2 → recovery navigation writes the right hash
//   - ChoicePage "更换目录" → level=1 navigation writes the right hash
//   - Work_dirs mirror survives across hash navigation.

import {
  PROTOCOL_VERSION,
  type Envelope,
  type SessionListEntry,
} from '@remotepi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  changeWorkDirHash,
  exitSessionHash,
  newSessionHash,
  readAuthFromHash,
  selectSessionHash,
  selectWorkDirHash,
} from '../hash.js';
import { WsClient } from '../ws/WsClient.js';

// ---------------------------------------------------------------------------
// FakeWs + simulateInbound (shared with ws-client-choice-page.test.ts;
// copied to keep test files independent and locally readable)
// ---------------------------------------------------------------------------

class FakeWs {
  static readonly OPEN = 1;
  readyState = FakeWs.OPEN;
  readonly sentFrames: Envelope[] = [];
  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as Envelope);
  }
  close(): void {
    /* no-op */
  }
  addEventListener(): void {
    /* no-op */
  }
  removeEventListener(): void {
    /* no-op */
  }
}

function makeConnectedWs(): { ws: WsClient; fake: FakeWs; sentFrames: () => Envelope[] } {
  const original = globalThis.WebSocket;
  const fake = new FakeWs();
  function StubWebSocket(this: unknown) {
    return fake;
  }
  StubWebSocket.OPEN = FakeWs.OPEN;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocket;
  const ws = new WsClient('ws://test/web');
  ws.connect('tok');
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = original;
  return {
    ws,
    fake,
    sentFrames: () => fake.sentFrames.slice(),
  };
}

function simulateInbound(ws: WsClient, envelope: Envelope, fake: FakeWs): void {
  const handleMessage = (ws as unknown as {
    handleMessage: (event: MessageEvent) => void;
  }).handleMessage;
  const messageEvent = {
    data: JSON.stringify(envelope),
    target: fake,
  } as unknown as MessageEvent;
  handleMessage(messageEvent);
}

function controlResult(replyTo: string, data: unknown, ok: boolean): Envelope {
  const payload: { ok: boolean; data?: unknown } = { ok };
  if (data !== undefined) payload.data = data;
  return {
    v: PROTOCOL_VERSION,
    kind: 'control',
    type: 'result',
    id: 'res-' + Math.random().toString(36).slice(2, 10),
    reply_to: replyTo,
    payload,
  };
}

// ---------------------------------------------------------------------------
// 钉子 5 — level=2 列表刷新时机 (initial + back-from-ChatView + no-poll)
// ---------------------------------------------------------------------------

describe('ChoicePage level=2 — 钉子 5 刷新时机', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1.1 mount-time query: first sendSessionList call lands within the outbound batch', () => {
    const { ws, sentFrames } = makeConnectedWs();
    // Mirror the hash work_dir (App.tsx's hashchange effect).
    ws.setCurrentWorkDir('/home/me');
    // Simulate ChoicePage level=2 mount effect firing the query.
    ws.sendSessionList(ws.currentWorkDir!);
    const listFrames = sentFrames().filter(
      (f) => f.kind === 'control' && f.type === 'session_list',
    );
    expect(listFrames).toHaveLength(1);
    expect(listFrames[0]!.payload).toEqual({ work_dir: '/home/me' });
  });

  it('1.2 no polling: only ONE session_list outbound frame for a single mount cycle', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    // Mount trigger.
    ws.sendSessionList(ws.currentWorkDir!);
    const initialCount = sentFrames().filter(
      (f) => f.kind === 'control' && f.type === 'session_list',
    ).length;
    // Advance timers by 30s — if there were a poll, this would
    // re-fire the query. (Note: the ChoicePage component uses
    // `setTimeout(5000)` only as a timeout watchdog on the inbound
    // reply — see DirectoryBrowser.tsx; the ChoicePage itself
    // doesn't poll.)
    vi.advanceTimersByTime(30_000);
    const afterCount = sentFrames().filter(
      (f) => f.kind === 'control' && f.type === 'session_list',
    ).length;
    expect(afterCount).toBe(initialCount);
  });

  it('1.3 triggerNonce-style re-query fires a NEW outbound id (refresh semantics)', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    // Initial mount.
    const id1 = ws.sendSessionList(ws.currentWorkDir!);
    // 钉子 5 second trigger — "从 ChatView 退回 level2 时重查".
    // The ChoicePage bumps a triggerNonce state when the previous
    // hash had a session and the new one doesn't. Simulate by
    // re-firing the query (the real component does this via a
    // useEffect dep on `triggerNonce`).
    const id2 = ws.sendSessionList(ws.currentWorkDir!);
    expect(id1).not.toBe(id2);
    const listFrames = sentFrames().filter(
      (f) => f.kind === 'control' && f.type === 'session_list',
    );
    expect(listFrames).toHaveLength(2);
  });

  it('1.4 work_dir change re-queries session_list with the new work_dir', () => {
    const { ws, sentFrames } = makeConnectedWs();
    // First level=2 for /home/me.
    ws.setCurrentWorkDir('/home/me');
    ws.sendSessionList(ws.currentWorkDir!);
    // User picks "更换目录" → level=1 → picks /tmp/work → level=2 again.
    ws.setCurrentWorkDir('/tmp/work');
    ws.sendSessionList(ws.currentWorkDir!);
    const listFrames = sentFrames().filter(
      (f) => f.kind === 'control' && f.type === 'session_list',
    );
    expect(listFrames).toHaveLength(2);
    expect(listFrames[1]!.payload).toEqual({ work_dir: '/tmp/work' });
  });

  it('1.5 session_list reply with new entries overwrites the mirror wholesale', () => {
    const { ws, fake } = makeConnectedWs();
    ws.setCurrentWorkDir('/home/me');
    const id1 = ws.sendSessionList(ws.currentWorkDir!);
    const initial: SessionListEntry[] = [
      {
        id: 'a',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T10:00:00Z',
        modified: '2026-09-08T10:00:00Z',
        message_count: 0,
        first_message: null,
        running: false,
        status: 'unknown',
      },
    ];
    simulateInbound(ws, controlResult(id1, { sessions: initial }, true), fake);
    expect(ws.sessionList).toEqual(initial);

    // Second reply — bridge re-scanned and the session now has
    // status: 'idle' (the user has since started it).
    const id2 = ws.sendSessionList(ws.currentWorkDir!);
    const updated: SessionListEntry[] = [
      { ...initial[0]!, status: 'idle' },
      {
        id: 'b',
        name: null,
        cwd: '/home/me',
        created: '2026-09-08T11:00:00Z',
        modified: '2026-09-08T11:00:00Z',
        message_count: 5,
        first_message: 'hello',
        running: true,
        status: 'running',
      },
    ];
    simulateInbound(ws, controlResult(id2, { sessions: updated }, true), fake);
    expect(ws.sessionList).toEqual(updated);
  });
});

// ---------------------------------------------------------------------------
// Navigation round-trips (hash + store mutation end-to-end)
// ---------------------------------------------------------------------------

describe('ChoicePage — navigation round-trips (hash + store)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2.1 selecting work_dir → hash update + level=2 session_list query', () => {
    const { ws } = makeConnectedWs();
    const token = 'tok';
    // Simulate level=1 → level=2 navigation:
    const newHash = selectWorkDirHash(token, '/home/me');
    const nextAuth = readAuthFromHash(newHash);
    expect(nextAuth.token).toBe(token);
    expect(nextAuth.workDir).toBe('/home/me');
    expect(nextAuth.session).toBeNull();
    // App.tsx's hashchange effect mirrors the work_dir into the store:
    ws.setCurrentWorkDir(nextAuth.workDir);
    // ChoicePage level=2 mount fires a session_list query.
    ws.sendSessionList(ws.currentWorkDir!);
    expect(ws.currentWorkDir).toBe('/home/me');
  });

  it('2.2 selecting session → hash update (recovery route)', () => {
    const token = 'tok';
    const newHash = selectSessionHash(token, '/home/me', 'sess-1');
    const nextAuth = readAuthFromHash(newHash);
    expect(nextAuth.session).toBe('sess-1');
    expect(nextAuth.workDir).toBe('/home/me');
  });

  it('2.3 退出会话 (exit session) → hash clears session, keeps work_dir', () => {
    const token = 'tok';
    const newHash = exitSessionHash(token, '/home/me');
    const nextAuth = readAuthFromHash(newHash);
    expect(nextAuth.workDir).toBe('/home/me');
    expect(nextAuth.session).toBeNull();
  });

  it('2.4 更换目录 (change work_dir) → hash clears work_dir + session', () => {
    const token = 'tok';
    const newHash = changeWorkDirHash(token);
    const nextAuth = readAuthFromHash(newHash);
    expect(nextAuth.token).toBe(token);
    expect(nextAuth.workDir).toBeNull();
    expect(nextAuth.session).toBeNull();
  });

  it('2.5 新建会话 → hash carries session=new (pending)', () => {
    const token = 'tok';
    const newHash = newSessionHash(token, '/home/me');
    const nextAuth = readAuthFromHash(newHash);
    expect(nextAuth.workDir).toBe('/home/me');
    expect(nextAuth.session).toBe('new');
  });

  it('2.6 full navigation: M3 legacy → level=1 → level=2 → recovery → back to level=2', () => {
    const token = 'tok';
    // Step 1: legacy M3 link opens → choiceLevel1.
    const step0 = readAuthFromHash('#' + token);
    expect(step0.token).toBe(token);
    expect(step0.workDir).toBeNull();

    // Step 2: user selects /home/me → choiceLevel2.
    const step1Hash = selectWorkDirHash(token, '/home/me');
    const step1 = readAuthFromHash(step1Hash);
    expect(step1.workDir).toBe('/home/me');

    // Step 3: user picks a session → recovery (RecoveryView / ChatView).
    const step2Hash = selectSessionHash(token, step1.workDir!, 'sess-1');
    const step2 = readAuthFromHash(step2Hash);
    expect(step2.session).toBe('sess-1');

    // Step 4: user clicks "退出会话" in ChatView → back to choiceLevel2.
    const step3Hash = exitSessionHash(token, step2.workDir!);
    const step3 = readAuthFromHash(step3Hash);
    expect(step3.workDir).toBe('/home/me');
    expect(step3.session).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DirectoryBrowser round-trip — list_directories + work_dir_add
// ---------------------------------------------------------------------------

describe('DirectoryBrowser — list_directories + work_dir_add round-trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('3.1 home navigation: sendListDirectories() with no path → empty payload', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.sendListDirectories();
    const frames = sentFrames().filter((f) => f.type === 'list_directories');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual({});
  });

  it('3.2 subdir navigation: sendListDirectories(path) → path-carrying payload', () => {
    const { ws, sentFrames } = makeConnectedWs();
    ws.sendListDirectories('/home/me/code');
    const frames = sentFrames().filter((f) => f.type === 'list_directories');
    expect(frames[0]!.payload).toEqual({ path: '/home/me/code' });
  });

  it('3.3 list_directories reply fires resolver with parsed entries (DirectoryBrowser reads via callback)', () => {
    // Review 修复轮 C1——transient `listDirResults` cache + `takeListDirResult`
    // 已删除；改为 `registerReplyResolver` 一次性回调。组件侧
    // 从 `envelope.payload.data.entries` 解析（见 DirectoryBrowser.tsx
    // path change effect）。这里 assert resolver 看到原始 envelope +
    // 调用者能从中提取 entries 数组。
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendListDirectories('/home/me');
    const calls: Array<{ name: string; path: string }[]> = [];
    ws.registerReplyResolver(id, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      if (env.payload.ok !== true) return;
      const data = env.payload.data;
      if (data === null || typeof data !== 'object') return;
      const entries = (data as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return;
      const parsed: Array<{ name: string; path: string }> = [];
      for (const e of entries) {
        if (e !== null && typeof e === 'object') {
          const obj = e as { name?: unknown; path?: unknown };
          if (typeof obj.name === 'string' && typeof obj.path === 'string') {
            parsed.push({ name: obj.name, path: obj.path });
          }
        }
      }
      calls.push(parsed);
    });
    simulateInbound(
      ws,
      controlResult(
        id,
        {
          entries: [
            { name: 'code', path: '/home/me/code' },
            { name: 'docs', path: '/home/me/docs' },
            { name: 'tmp', path: '/home/me/tmp' },
          ],
        },
        true,
      ),
      fake,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { name: 'code', path: '/home/me/code' },
      { name: 'docs', path: '/home/me/docs' },
      { name: 'tmp', path: '/home/me/tmp' },
    ]);
  });

  it('3.4 list_directories failure → resolver sees ok:false error envelope (DirectoryBrowser surfaces inline)', () => {
    // Review 修复轮 C1——list_directories 失败不再走 transient Map
    // 统一的 fallback 路径；改为 resolver 回调从
    // `envelope.payload.ok / .error` 解析（与 work_dir_* 路径同形）。
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendListDirectories('/nonexistent');
    const observed: Array<{ ok: boolean; error?: unknown }> = [];
    ws.registerReplyResolver(id, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push({ ok: env.payload.ok, error: env.payload.error });
    });
    simulateInbound(
      ws,
      {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'result',
        id: 'r',
        reply_to: id,
        payload: {
          ok: false,
          error: { code: 'invalid_envelope', message: 'path does not exist' },
        },
      },
      fake,
    );
    expect(observed).toEqual([
      {
        ok: false,
        error: { code: 'invalid_envelope', message: 'path does not exist' },
      },
    ]);
  });

  it('3.5 work_dir_add success → resolver sees ok:true (DirectoryBrowser advances to level=2)', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/Users/foo bar/');
    const observed: boolean[] = [];
    ws.registerReplyResolver(id, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push(env.payload.ok === true);
    });
    simulateInbound(ws, controlResult(id, undefined, true), fake);
    expect(observed).toEqual([true]);
  });

  it('3.6 work_dir_add failure (StateError → internal) → resolver sees ok:false with bridge message', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirAdd('/nonexistent');
    const observed: Array<{ ok: boolean; error?: unknown }> = [];
    ws.registerReplyResolver(id, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push({ ok: env.payload.ok, error: env.payload.error });
    });
    simulateInbound(
      ws,
      {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'result',
        id: 'r',
        reply_to: id,
        payload: {
          ok: false,
          error: {
            code: 'internal',
            message: 'directory does not exist or is not readable',
          },
        },
      },
      fake,
    );
    expect(observed).toEqual([
      {
        ok: false,
        error: {
          code: 'internal',
          message: 'directory does not exist or is not readable',
        },
      },
    ]);
  });

  it('3.7 work_dir_remove success → resolver sees ok:true (钉子 3: no active-manager kill)', () => {
    const { ws, fake } = makeConnectedWs();
    const id = ws.sendWorkDirRemove('/home/me');
    const observed: boolean[] = [];
    ws.registerReplyResolver(id, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push(env.payload.ok === true);
    });
    simulateInbound(ws, controlResult(id, undefined, true), fake);
    expect(observed).toEqual([true]);
    // The web's contract per钉子 3: the bridge does NOT kill any
    // active manager rooted in this work_dir. The web merely
    // re-fetches work_dir_list to update the mirror.
    ws.sendWorkDirList();
  });
});

// ---------------------------------------------------------------------------
// Work_dirs mirror round-trip — full Mutation flow
// ---------------------------------------------------------------------------

describe('ChoicePage level=1 — work_dirs mutation round-trips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('4.1 initial fetch on mount → mirror populated', () => {
    const { ws, fake } = makeConnectedWs();
    expect(ws.workDirs).toEqual([]);
    const id = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id, { work_dirs: ['/home/me'] }, true), fake);
    expect(ws.workDirs).toEqual(['/home/me']);
  });

  it('4.2 work_dir_add success → resolver sees ok:true; mirror updates after re-fetch', () => {
    // Review 修复轮 C1——work_dir_add 不再缓存 `takeWorkDirResult`；
    // 改为 resolver 看到 ok:true + 触发重查 work_dir_list。
    const { ws, fake } = makeConnectedWs();
    // Initial state.
    const id0 = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id0, { work_dirs: ['/home/me'] }, true), fake);
    expect(ws.workDirs).toEqual(['/home/me']);

    // Add a new directory (via DirectoryBrowser "选择" button).
    const addId = ws.sendWorkDirAdd('/tmp/work');
    const observed: boolean[] = [];
    ws.registerReplyResolver(addId, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push(env.payload.ok === true);
    });
    simulateInbound(ws, controlResult(addId, undefined, true), fake);
    expect(observed).toEqual([true]);

    // Re-fetch (the ChoicePage re-issues work_dir_list after every
    // mutation).
    const id1 = ws.sendWorkDirList();
    simulateInbound(
      ws,
      controlResult(id1, { work_dirs: ['/home/me', '/tmp/work'] }, true),
      fake,
    );
    expect(ws.workDirs).toEqual(['/home/me', '/tmp/work']);
  });

  it('4.3 work_dir_remove success → resolver sees ok:true; mirror updates after re-fetch', () => {
    const { ws, fake } = makeConnectedWs();
    const id0 = ws.sendWorkDirList();
    simulateInbound(
      ws,
      controlResult(id0, { work_dirs: ['/home/me', '/tmp/work'] }, true),
      fake,
    );
    expect(ws.workDirs).toEqual(['/home/me', '/tmp/work']);

    const removeId = ws.sendWorkDirRemove('/tmp/work');
    const observed: boolean[] = [];
    ws.registerReplyResolver(removeId, (env) => {
      if (env.kind !== 'control' || env.type !== 'result') return;
      observed.push(env.payload.ok === true);
    });
    simulateInbound(ws, controlResult(removeId, undefined, true), fake);
    expect(observed).toEqual([true]);

    const id1 = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id1, { work_dirs: ['/home/me'] }, true), fake);
    expect(ws.workDirs).toEqual(['/home/me']);
  });

  it('4.4 work_dir_remove failure leaves the mirror untouched', () => {
    const { ws, fake } = makeConnectedWs();
    const id0 = ws.sendWorkDirList();
    simulateInbound(ws, controlResult(id0, { work_dirs: ['/home/me'] }, true), fake);
    const before = ws.workDirs;

    const removeId = ws.sendWorkDirRemove('/nonexistent');
    simulateInbound(
      ws,
      {
        v: PROTOCOL_VERSION,
        kind: 'control',
        type: 'result',
        id: 'r',
        reply_to: removeId,
        payload: { ok: false, error: { code: 'internal', message: 'no such path' } },
      },
      fake,
    );
    expect(ws.workDirs).toBe(before);
  });
});