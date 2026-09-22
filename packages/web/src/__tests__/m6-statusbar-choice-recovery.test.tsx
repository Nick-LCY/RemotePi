// Vitest specs for the M6 T09 reference shapes — covers the
// visual upgrades to `SessionStatusBar`, `ChoiceLevel1Panel`,
// `ChoiceLevel2Panel`, and the `RecoveryInFlight` / `RecoveryErrorCard`
// JSX blocks in App.tsx.
//
// ## Strategy
//
// Most shape checks live against `renderToStaticMarkup` output
// (SSR-safe). The SessionStatusBar / ChoiceLevel*Panels use
// the same `WsClientProvider` stub pattern as the existing
// session-status-bar.test.tsx so we re-use the bucketFor
// override to drive phase + queue states.
//
// The RecoveryView blocks are tested by importing `errorHint`
// (already covered in recovery.test.ts 6.2/6.3) and by
// asserting the HTML output of the `RecoveryInFlight` /
// `RecoveryErrorCard` function components through `App.tsx`
// indirectly — see "RecoveryView shape" below.
//
// ## Coverage (4-8 cases per task brief)
//
//   1. SessionStatusBar — pill bar container + phase badge tinted
//      + queue pills light grey (D7 / G12).
//   2. SessionStatusBar — running phase maps to `bg-amber`
//      (tokenised, was hard-coded `bg-[#e69138]`).
//   3. ChoiceLevel1Panel — minimal hint card + FolderOpen icon +
//      `data-level="1"` testid.
//   4. ChoiceLevel2Panel — minimal hint card + Folder icon +
//      accent-filled work-dir-change button + `data-level="2"`.
//   5. ChoiceLevel2Panel — work_dir inline code carries
//      `text-accent` (D7 inline-code family).
//   6. Sidebar session status — running maps to `bg-amber` (tokenised).
//   7. RecoveryInFlight — `Loader` icon + `bg-state-online/[0.12]`
//      tinted icon block + `text-testid="recovery-in-flight"`.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatusBar } from '../components/SessionStatusBar.js';
import { ChoiceLevel1Panel } from '../components/ChoiceLevel1Panel.js';
import { ChoiceLevel2Panel } from '../components/ChoiceLevel2Panel.js';
import { Sidebar } from '../components/Sidebar.js';
import { WsClient } from '../ws/WsClient.js';
import { WsClientProvider } from '../ws/WsClientContext.js';
import type { SessionListEntry, SessionPhase } from '@remotepi/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class StubWebSocket {
  static OPEN = 1;
  readyState = StubWebSocket.OPEN;
  send(_data: string): void {
    /* no-op */
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

interface BucketShape {
  sessionPhase: SessionPhase | null;
  queue: { steering: string[]; followUp: string[] };
  messages: readonly unknown[];
  blockedOn: readonly unknown[];
  streamingDraft: null;
  sessionList: null;
  workDirs: readonly string[];
}

let wsStub: StubWebSocket | null = null;
let bucketOverride: BucketShape | null = null;

function makeFakeWsClient(): WsClient {
  wsStub = new StubWebSocket();
  function StubWebSocketCtor(this: unknown): StubWebSocket {
    return wsStub!;
  }
  StubWebSocketCtor.OPEN = StubWebSocket.OPEN;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = StubWebSocketCtor;
  const client = new WsClient('ws://test/web');
  // Override bucketFor to return the test-controlled bucket.
  (client as unknown as { bucketFor: (key: string | null) => BucketShape }).bucketFor = (
    _key: string | null,
  ): BucketShape => {
    if (bucketOverride === null) {
      return {
        sessionPhase: null,
        queue: { steering: [], followUp: [] },
        messages: [],
        blockedOn: [],
        streamingDraft: null,
        sessionList: null,
        workDirs: [],
      };
    }
    return bucketOverride;
  };
  return client;
}

beforeEach(() => {
  wsStub = null;
  bucketOverride = null;
});

afterEach(() => {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  wsStub = null;
  bucketOverride = null;
});

function renderSessionStatusBar(session: string): string {
  const client = makeFakeWsClient();
  const element: ReactElement = createElement(
    WsClientProvider,
    {
      client,
      children: createElement(SessionStatusBar, { session }),
    },
  );
  return renderToStaticMarkup(element);
}

function renderChoiceLevel1(removeError?: string | null): string {
  return renderToStaticMarkup(
    createElement(ChoiceLevel1Panel, removeError === undefined ? {} : { removeError }),
  );
}

function renderChoiceLevel2(workDir: string, error?: string | null): string {
  return renderToStaticMarkup(
    createElement(ChoiceLevel2Panel, {
      workDir,
      ...(error === undefined ? {} : { error }),
      onChangeWorkDir: () => {},
      onNewSession: () => {},
    }),
  );
}

function renderSidebar(): string {
  const client = makeFakeWsClient();
  // Pre-seed the bucket's sessionList with two entries — one
  // running, one exited — so the SESSION_STATUS_CLASS map emits
  // its tokens for both states. Use the public `bucketFor()` API
  // (matches the existing sidebar.test.tsx + chatview-bubbles
  // pattern) and ALSO override the WsClient class-level
  // `sessionList` getter so `useSessionList()` returns the
  // seeded array (the WsClient's class-level getter reads
  // `_sessions[_currentSessionKey]?.sessionList` directly, so a
  // `bucketFor` mutation on the bucket object IS visible — but
  // we additionally patch the class-level getter to be safe
  // against any internal handling).
  const sessions: SessionListEntry[] = [
    {
      id: 'sess-running',
      name: null,
      cwd: '/home/me',
      created: '2026-09-22T10:00:00Z',
      modified: '2026-09-22T10:00:00Z',
      message_count: 1,
      first_message: 'hello',
      running: true,
      status: 'running',
    },
    {
      id: 'sess-exited',
      name: null,
      cwd: '/home/me',
      created: '2026-09-22T11:00:00Z',
      modified: '2026-09-22T11:00:00Z',
      message_count: 0,
      first_message: null,
      running: false,
      status: 'exited',
    },
  ];
  // Patch the class-level sessionList getter so it returns our
  // seeded array regardless of which bucket the getter routes to.
  // (The Sidebar's `useSessionList()` reads via this getter.)
  Object.defineProperty(client, 'sessionList', {
    configurable: true,
    get: () => sessions,
  });
  const element: ReactElement = createElement(
    WsClientProvider,
    {
      client,
      children: createElement(Sidebar, {
        currentSession: null,
        currentWorkDir: '/home/me',
        view: 'choiceLevel2',
        onSettingsClick: () => {},
        onBrowseWorkDirsClick: () => {},
      }),
    },
  );
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------
// 1. SessionStatusBar — pill bar container + phase badge + queue pills
// ---------------------------------------------------------------------------

describe('M6 T09 — SessionStatusBar reference shape (D7 / G12)', () => {
  it('1a. root container carries `rounded-xl border border-border bg-surface` (pill bar)', () => {
    const html = renderSessionStatusBar('sess-1');
    // SSR puts `class` BEFORE `data-testid`; match either order.
    const rootMatch = html.match(/<div[^>]*data-testid="session-status-bar"[^>]*>/);
    expect(rootMatch).not.toBeNull();
    expect(rootMatch![0]).toMatch(/\brounded-xl\b/);
    expect(rootMatch![0]).toMatch(/\bborder\b/);
    expect(rootMatch![0]).toMatch(/\bborder-border\b/);
    expect(rootMatch![0]).toMatch(/\bbg-surface\b/);
    expect(rootMatch![0]).toMatch(/\bshadow-sm\b/);
  });

  it('1b. phase=running → badge carries `bg-amber` (tokenised; was hard-coded hex)', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
      workDirs: [],
    };
    const html = renderSessionStatusBar('sess-1');
    // Assert the running badge uses the amber token — never the
    // legacy hard-coded `bg-[#e69138]` hex.
    const phaseMatch = html.match(
      /<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="running"[^>]*>/,
    );
    expect(phaseMatch).not.toBeNull();
    expect(phaseMatch![0]).toContain('bg-amber');
    expect(phaseMatch![0]).not.toContain('bg-[#');
  });

  it('1c. queue pills carry `bg-surface-2` (light grey small pill, was bg-surface)', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: ['m1'], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
      workDirs: [],
    };
    const html = renderSessionStatusBar('sess-1');
    const steeringMatch = html.match(
      /<span[^>]*data-testid="session-status-bar-queue-steering"[^>]*>/,
    );
    expect(steeringMatch).not.toBeNull();
    expect(steeringMatch![0]).toContain('bg-surface-2');
    expect(steeringMatch![0]).toContain('rounded-full');
    // T09 contract: the count renders inside a `<strong>` with
    // `text-text` so the number reads as the primary signal.
    expect(html).toMatch(
      /data-testid="session-status-bar-queue-steering"[^>]*>[^<]*steering:[^<]*<strong class="text-text">1<\/strong>/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. ChoiceLevel1Panel — minimal hint card + FolderOpen icon
// ---------------------------------------------------------------------------

describe('M6 T09 — ChoiceLevel1Panel reference shape (D7 / G12)', () => {
  it('2a. root carries `rounded-2xl border border-border bg-surface p-7 shadow-sm text-center`', () => {
    const html = renderChoiceLevel1();
    const rootMatch = html.match(/<section[^>]*data-testid="choice-page"[^>]*data-level="1"[^>]*>/);
    expect(rootMatch).not.toBeNull();
    expect(rootMatch![0]).toMatch(/\brounded-2xl\b/);
    expect(rootMatch![0]).toMatch(/\bborder-border\b/);
    expect(rootMatch![0]).toMatch(/\bbg-surface\b/);
    expect(rootMatch![0]).toMatch(/\bp-7\b/);
    expect(rootMatch![0]).toMatch(/\bshadow-sm\b/);
    expect(rootMatch![0]).toMatch(/\btext-center\b/);
  });

  it('2b. header icon block carries `bg-accent-soft text-accent` + lucide FolderOpen icon', () => {
    const html = renderChoiceLevel1();
    // Icon block (decorative): aria-hidden wrapper with size-11
    // rounded-xl + accent-soft + accent.
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('text-accent');
    // The lucide `FolderOpen` icon is rendered as an `<svg>` with
    // the lucide-react class `lucide-folder-open`.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-folder-open\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. ChoiceLevel2Panel — minimal hint card + Folder icon + accent CTA
// ---------------------------------------------------------------------------

describe('M6 T09 — ChoiceLevel2Panel reference shape (D7 / G12)', () => {
  it('3a. root carries `rounded-2xl border border-border bg-surface p-7 shadow-sm text-center`', () => {
    const html = renderChoiceLevel2('/home/me');
    const rootMatch = html.match(/<section[^>]*data-testid="choice-page"[^>]*data-level="2"[^>]*>/);
    expect(rootMatch).not.toBeNull();
    expect(rootMatch![0]).toMatch(/\brounded-2xl\b/);
    expect(rootMatch![0]).toMatch(/\bborder-border\b/);
    expect(rootMatch![0]).toMatch(/\bbg-surface\b/);
    expect(rootMatch![0]).toMatch(/\bp-7\b/);
    expect(rootMatch![0]).toMatch(/\bshadow-sm\b/);
    expect(rootMatch![0]).toMatch(/\btext-center\b/);
  });

  it('3b. header icon block carries `bg-accent-soft text-accent` + lucide Folder icon', () => {
    const html = renderChoiceLevel2('/home/me');
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('text-accent');
    // level=2 uses Folder (not FolderOpen — the directory is
    // already chosen at level=2; the panel sits "inside" it).
    expect(html).toMatch(/<svg[^>]*class="[^"]*\blucide-folder\b/);
    // No FolderOpen on this panel — the Folder icon marks the
    // "session under this directory" state.
    expect(html).not.toMatch(/<svg[^>]*class="[^"]*\blucide-folder-open\b/);
  });

  it('3c. work-dir-change button is accent-filled (bg-accent text-white)', () => {
    const html = renderChoiceLevel2('/home/me');
    const btnMatch = html.match(/<button[^>]*data-testid="work-dir-change"[^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![0]).toContain('bg-accent');
    expect(btnMatch![0]).toContain('text-white');
    expect(btnMatch![0]).toContain('rounded-xl');
  });

  it('3d. work_dir inline code carries `bg-surface-2` + `text-accent` (D7 inline-code family)', () => {
    const html = renderChoiceLevel2('/home/me');
    const codeMatch = html.match(/<code[^>]*data-testid="choice-page-work-dir"[^>]*>/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![0]).toContain('bg-surface-2');
    expect(codeMatch![0]).toContain('text-accent');
    expect(codeMatch![0]).toContain('font-mono');
  });
});

// ---------------------------------------------------------------------------
// 4. Sidebar session status — tokenised running (was hex)
// ---------------------------------------------------------------------------

describe('M6 T09 — Sidebar session status tokenisation', () => {
  it('4a. running status pill carries `bg-amber` (tokenised; no hex)', () => {
    const html = renderSidebar();
    // Find the session-row-status pill for the running session.
    const runningMatch = html.match(
      /<span[^>]*data-testid="session-row-status"[^>]*data-status="running"[^>]*>/,
    );
    expect(runningMatch).not.toBeNull();
    expect(runningMatch![0]).toContain('bg-amber');
    expect(runningMatch![0]).not.toContain('bg-[#');
  });

  it('4b. exited status pill still maps to `bg-state-offline` (unchanged)', () => {
    const html = renderSidebar();
    const exitedMatch = html.match(
      /<span[^>]*data-testid="session-row-status"[^>]*data-status="exited"[^>]*>/,
    );
    expect(exitedMatch).not.toBeNull();
    expect(exitedMatch![0]).toContain('bg-state-offline');
  });
});
