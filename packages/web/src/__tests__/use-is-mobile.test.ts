// @vitest-environment node
// Vitest specs for `useIsMobile` (M5 task 07 / PRD §第二块 G7 / D12).
//
// ## 测试策略记录（按 brief 要求如实记录）
//
// 选**纯函数 + extracted 行为函数**路径，**不**加 jsdom：
//   - 抽离 hook 体内调用的 `readInitialMatches` +
//     `subscribeToMatchMedia` 为纯函数（依赖可选 `WindowLike`
//     替身），测试直接调用它们验证 listener 注册 / 注销 / 状态
//     推送路径——无需 react 渲染、无需 jsdom。
//   - `readMatchesFrom` 纯函数直接测（SSR / 无 MediaQueryList 兜底）。
//   - `MOBILE_QUERY` / `MOBILE_MAX_WIDTH` 字面常量钉桩（与 768px
//     断点字面绑定）。
//   - hook 顶层 `useIsMobile()` 仅靠薄壳（`useState` +
//     `useEffect(subscribeToMatchMedia, [])`），其行为由
//     `subscribeToMatchMedia` 完全覆盖；测试不必经 react reconciler。
//
// 为何不引 jsdom：
//   - 本包 ADR-0009 §决策 4 明确「无 jsdom web 测试基建」（避免引入
//     3MB+ devDep + 拖慢 CI）；hook 体量小（30 行），
//     全部 effect 行为能用 `subscribeToMatchMedia` 纯函数钉桩
//     （不需要 react reconciler / 真实 DOM）。
//   - 真实 DOM 集成（focus 实际跳到元素 / mobile drawer 真渲染）
//     由 e2e 任务 08 的 mobile-drawer spec 覆盖（Playwright 真
//     浏览器环境）。
//
// ## ≥4 测试覆盖（brief 要求）
//
// 1. `readMatchesFrom` SSR / null 兜底。
// 2. `MOBILE_QUERY` 与 `MOBILE_MAX_WIDTH` 字面绑定 768px 断点。
// 3. `subscribeToMatchMedia` mount：注册 listener + 同步初始 matches。
// 4. `subscribeToMatchMedia` change 事件：dispatch 触发 setState。
// 5. `subscribeToMatchMedia` cleanup：调用返回函数注销 listener。
// 6. `subscribeToMatchMedia` no-op：当无 window / 无 matchMedia。

import { describe, expect, it, vi } from 'vitest';

import {
  MOBILE_MAX_WIDTH,
  MOBILE_QUERY,
  readInitialMatches,
  readMatchesFrom,
  subscribeToMatchMedia,
  type MatchMediaLike,
  type WindowLike,
} from '../hooks/useIsMobile.js';

// ---------------------------------------------------------------------------
// Fake matchMedia — lets the test pin addEventListener / removeEventListener
// call counts + manually dispatch change events to listeners.
// ---------------------------------------------------------------------------

interface FakeMql extends MatchMediaLike {
  dispatchChange: (matches: boolean) => void;
  listeners: Array<(event: { matches: boolean; media: string }) => void>;
  addEventListenerMock: ReturnType<typeof vi.fn>;
  removeEventListenerMock: ReturnType<typeof vi.fn>;
}

function makeFakeMql(initialMatches: boolean): FakeMql {
  const listeners: Array<(event: { matches: boolean; media: string }) => void> = [];
  const addEventListenerMock = vi.fn((type: string, listener: (event: { matches: boolean; media: string }) => void) => {
    if (type !== 'change') return;
    listeners.push(listener);
  });
  const removeEventListenerMock = vi.fn((type: string, listener: (event: { matches: boolean; media: string }) => void) => {
    if (type !== 'change') return;
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  });
  return {
    matches: initialMatches,
    media: MOBILE_QUERY,
    listeners,
    addEventListener: addEventListenerMock,
    removeEventListener: removeEventListenerMock,
    addEventListenerMock,
    removeEventListenerMock,
    dispatchChange(matches: boolean) {
      // update internal matches so subsequent reads reflect the new value
      (this as { matches: boolean }).matches = matches;
      for (const listener of listeners) {
        listener({ matches, media: MOBILE_QUERY });
      }
    },
  };
}

function makeWindowLike(mql: FakeMql): WindowLike {
  return {
    matchMedia: (query: string) => {
      if (query !== MOBILE_QUERY) {
        throw new Error(`makeWindowLike got unexpected query ${query}`);
      }
      return mql;
    },
  };
}

// ---------------------------------------------------------------------------
// readMatchesFrom — pure helper (SSR safety)
// ---------------------------------------------------------------------------

describe('readMatchesFrom — pure helper', () => {
  it('1.1 readMatchesFrom({matches:true}) returns true', () => {
    expect(readMatchesFrom({ matches: true })).toBe(true);
  });

  it('1.2 readMatchesFrom({matches:false}) returns false', () => {
    expect(readMatchesFrom({ matches: false })).toBe(false);
  });

  it('1.3 readMatchesFrom(null) returns false (SSR safety)', () => {
    expect(readMatchesFrom(null)).toBe(false);
  });

  it('1.4 readMatchesFrom(undefined) returns false (SSR safety)', () => {
    expect(readMatchesFrom(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readInitialMatches — initial state of useState
// ---------------------------------------------------------------------------

describe('readInitialMatches — useState initializer', () => {
  it('2.1 reads matches:true from the stub matchMedia (mobile)', () => {
    const mql = makeFakeMql(true);
    expect(readInitialMatches(makeWindowLike(mql))).toBe(true);
  });

  it('2.2 reads matches:false from the stub matchMedia (desktop)', () => {
    const mql = makeFakeMql(false);
    expect(readInitialMatches(makeWindowLike(mql))).toBe(false);
  });

  it('2.3 returns false when windowLike is null (SSR)', () => {
    expect(readInitialMatches(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MOBILE_QUERY / MOBILE_MAX_WIDTH — breakpoint literal pin
// ---------------------------------------------------------------------------

describe('MOBILE_QUERY / MOBILE_MAX_WIDTH — breakpoint literal', () => {
  it('3.1 MOBILE_MAX_WIDTH is 767 (768px 单断点 → ≤767 判 mobile)', () => {
    expect(MOBILE_MAX_WIDTH).toBe(767);
  });

  it('3.2 MOBILE_QUERY is "(max-width: 767px)"', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 767px)');
  });
});

// ---------------------------------------------------------------------------
// subscribeToMatchMedia — extracted useEffect body (listener lifecycle)
// ---------------------------------------------------------------------------

describe('subscribeToMatchMedia — extracted useEffect body (≥4 cases)', () => {
  it('4.1 registers exactly one change listener on the stub matchMedia', () => {
    const mql = makeFakeMql(true);
    const cleanup = subscribeToMatchMedia(() => undefined, makeWindowLike(mql));
    expect(mql.addEventListenerMock).toHaveBeenCalledTimes(1);
    expect(mql.addEventListenerMock.mock.calls[0]?.[0]).toBe('change');
    cleanup();
  });

  it('4.2 syncs the initial matches value into setIsMobile on mount', () => {
    const mql = makeFakeMql(true);
    const setIsMobile = vi.fn<(value: boolean) => void>();
    const cleanup = subscribeToMatchMedia(setIsMobile, makeWindowLike(mql));
    // mount-once 内同步调用一次 setIsMobile(mql.matches)。
    expect(setIsMobile).toHaveBeenCalledTimes(1);
    expect(setIsMobile).toHaveBeenCalledWith(true);
    cleanup();
  });

  it('4.3 dispatching change(matches:true) on a desktop-mounted subscriber updates state to mobile', () => {
    const mql = makeFakeMql(false);
    const setIsMobile = vi.fn<(value: boolean) => void>();
    const cleanup = subscribeToMatchMedia(setIsMobile, makeWindowLike(mql));
    expect(setIsMobile).toHaveBeenLastCalledWith(false); // mount-once sync
    // 模拟 viewport 缩窄到 mobile 范围——matchMedia 派发 change 事件。
    mql.dispatchChange(true);
    expect(setIsMobile).toHaveBeenCalledTimes(2);
    expect(setIsMobile).toHaveBeenLastCalledWith(true);
    cleanup();
  });

  it('4.4 cleanup removes the listener and dispatchChange no longer calls setIsMobile', () => {
    const mql = makeFakeMql(false);
    const setIsMobile = vi.fn<(value: boolean) => void>();
    const cleanup = subscribeToMatchMedia(setIsMobile, makeWindowLike(mql));
    expect(mql.listeners.length).toBe(1);
    cleanup();
    expect(mql.removeEventListenerMock).toHaveBeenCalledTimes(1);
    // 注销后 listeners 数组已空——dispatch 不再触发回调。
    mql.dispatchChange(true);
    expect(setIsMobile).toHaveBeenCalledTimes(1); // 仅 mount-once 同步调用
  });

  it('4.5 StrictMode safety — mount → cleanup → mount results in exactly 1 active listener', () => {
    const mql = makeFakeMql(true);
    // 模拟 React StrictMode mount → cleanup → mount 序列。
    const cleanup1 = subscribeToMatchMedia(() => undefined, makeWindowLike(mql));
    cleanup1();
    const cleanup2 = subscribeToMatchMedia(() => undefined, makeWindowLike(mql));
    // add 调 2 次（两次 mount），remove 调 1 次（第一次 cleanup）。
    expect(mql.addEventListenerMock).toHaveBeenCalledTimes(2);
    expect(mql.removeEventListenerMock).toHaveBeenCalledTimes(1);
    // listeners 数组仅剩 1 个（第二次 mount 的 listener）。
    expect(mql.listeners.length).toBe(1);
    cleanup2();
    expect(mql.listeners.length).toBe(0);
  });

  it('4.6 returns a no-op cleanup when windowLike is null (SSR safety)', () => {
    const setIsMobile = vi.fn<(value: boolean) => void>();
    const cleanup = subscribeToMatchMedia(setIsMobile, null);
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
    expect(setIsMobile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Hook-level sanity — verify the hook function is callable + has expected
// shape (the useEffect body delegates to subscribeToMatchMedia which is
// already tested above). This protects against accidental refactors that
// break the React surface.
// ---------------------------------------------------------------------------

describe('useIsMobile — hook surface', () => {
  it('5.1 useIsMobile is a function', async () => {
    const mod = await import('../hooks/useIsMobile.js');
    expect(typeof mod.useIsMobile).toBe('function');
  });
});