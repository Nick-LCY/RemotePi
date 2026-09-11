// Vitest specs for `SessionStatusBar.tsx` — M5 task 06 §a
// SessionStatusBar 行为（M5 §第二块 G5 / D8）。
//
// ## Strategy
//
// SessionStatusBar uses `useWsState` (via WsClientContext). We
// render via `renderToStaticMarkup` against a stub WsClient.
// The store state we care about (sessionPhase + queue) is read
// from `bucketFor(session)`, so we pre-populate the fake's
// `bucketFor()` return shape to cover the 5 phase states +
// 0/1/2 queue counts.
//
// ## Coverage (≥3 cases per task brief)
//
//   1. phase badge 五态各自渲染（running/idle/spawning/exited/unknown）
//   2. session === 'new' 显「**新会话**」（与 M4 ChoicePage 既有
//      'new' 渲染对齐）
//   3. queue pills：queue=0 → 不显示；queue≥1 → 显示数字 pill
//
// ## session name 渲染分支
//
//   - 'new' → "新会话"
//   - M3_LEGACY_KEY ('m3-legacy') → "M3 旧链接会话"
//   - 其他 → 显示 stem 本身
//
// ## Tailwind only
//
// The component uses Tailwind utilities (no module.css). SSR
// output is the standard React HTML — className attributes
// contain the Tailwind utility strings.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStatusBar } from '../components/SessionStatusBar.js';
import { WsClient } from '../ws/WsClient.js';
import { WsClientProvider } from '../ws/WsClientContext.js';
import type { SessionPhase } from '@remotepi/shared';

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
  // WsClient.bucketFor is a method (not a getter) — we can
  // reassign via the prototype chain. Cast to `any` here because
  // the WsClient public surface doesn't expose `bucketFor` for
  // reassignment, but it's the cleanest way to seed a stable
  // session phase + queue without driving a real socket.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBar(session: string): string {
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

// ---------------------------------------------------------------------------
// 1. phase badge 五态各自渲染
// ---------------------------------------------------------------------------

describe('SessionStatusBar — phase badge 五态', () => {
  it('1a. phase=running → "running" 徽章 + data-phase="running"', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toMatch(/<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="running"[^>]*>running<\/span>/);
  });

  it('1b. phase=idle → "idle" 徽章', () => {
    bucketOverride = {
      sessionPhase: 'idle',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toMatch(/<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="idle"[^>]*>idle<\/span>/);
  });

  it('1c. phase=spawning → "spawning" 徽章', () => {
    bucketOverride = {
      sessionPhase: 'spawning',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toMatch(/<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="spawning"[^>]*>spawning<\/span>/);
  });

  it('1d. phase=exited → "exited" 徽章', () => {
    bucketOverride = {
      sessionPhase: 'exited',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toMatch(/<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="exited"[^>]*>exited<\/span>/);
  });

  it('1e. phase=null → "unknown" 徽章', () => {
    const html = renderBar('sess-1');
    expect(html).toMatch(/<span[^>]*data-testid="session-status-bar-phase"[^>]*data-phase="unknown"[^>]*>unknown<\/span>/);
  });
});

// ---------------------------------------------------------------------------
// 2. session === 'new' 显「**新会话**」
// ---------------------------------------------------------------------------

describe('SessionStatusBar — session name 渲染分支', () => {
  it('2a. session="new" → 显示「新会话」（与 M4 ChoicePage 既有 new 渲染对齐）', () => {
    const html = renderBar('new');
    const nameMatch = html.match(/<span[^>]*data-testid="session-status-bar-name"[^>]*>([^<]*)<\/span>/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe('新会话');
  });

  it('2b. session="sess-1" → 显示 stem 本身', () => {
    const html = renderBar('sess-1');
    const nameMatch = html.match(/<span[^>]*data-testid="session-status-bar-name"[^>]*>([^<]*)<\/span>/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe('sess-1');
  });

  it('2c. session="m3-legacy" → 显示「M3 旧链接会话」', () => {
    const html = renderBar('m3-legacy');
    const nameMatch = html.match(/<span[^>]*data-testid="session-status-bar-name"[^>]*>([^<]*)<\/span>/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1]).toBe('M3 旧链接会话');
  });
});

// ---------------------------------------------------------------------------
// 3. queue pills：queue=0 → 不显示；queue≥1 → 显示数字 pill
// ---------------------------------------------------------------------------

describe('SessionStatusBar — queue pills', () => {
  it('3a. queue 全 0 → 不显示 queue-pills 容器', () => {
    bucketOverride = {
      sessionPhase: 'idle',
      queue: { steering: [], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).not.toContain('data-testid="session-status-bar-queue"');
    expect(html).not.toContain('data-testid="session-status-bar-queue-steering"');
    expect(html).not.toContain('data-testid="session-status-bar-queue-follow-up"');
  });

  it('3b. queue.steering=1 → 显示 steering pill (count=1)', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: ['msg-1'], followUp: [] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toContain('data-testid="session-status-bar-queue"');
    const steeringMatch = html.match(/<span[^>]*data-testid="session-status-bar-queue-steering"[^>]*>/);
    expect(steeringMatch).not.toBeNull();
    expect(steeringMatch![0]).toContain('data-count="1"');
  });

  it('3c. queue.followUp=2 → 显示 follow-up pill (count=2)', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: [], followUp: ['m1', 'm2'] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    const followUpMatch = html.match(/<span[^>]*data-testid="session-status-bar-queue-follow-up"[^>]*>/);
    expect(followUpMatch).not.toBeNull();
    expect(followUpMatch![0]).toContain('data-count="2"');
  });

  it('3d. queue 全非零（steering=1 + followUp=3）→ 两个 pill 同时显示', () => {
    bucketOverride = {
      sessionPhase: 'running',
      queue: { steering: ['m1'], followUp: ['m2', 'm3', 'm4'] },
      messages: [],
      blockedOn: [],
      streamingDraft: null,
      sessionList: null,
    };
    const html = renderBar('sess-1');
    expect(html).toContain('data-testid="session-status-bar-queue-steering"');
    expect(html).toContain('data-testid="session-status-bar-queue-follow-up"');
    const steeringMatch = html.match(/<span[^>]*data-testid="session-status-bar-queue-steering"[^>]*>/);
    expect(steeringMatch![0]).toContain('data-count="1"');
    const followUpMatch = html.match(/<span[^>]*data-testid="session-status-bar-queue-follow-up"[^>]*>/);
    expect(followUpMatch![0]).toContain('data-count="3"');
  });
});
