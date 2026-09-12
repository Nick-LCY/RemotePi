// Vitest specs for the App-level modal↔drawer focus-trap
// mutex helpers — M5 task 08 review W1 焦点陷阱互斥.
//
// ## What this guards against
//
// PRD §D12 specifies the z-index stack
// `toast(100) < sidebar(200) < dialog-host(300) < token-modal(400)`.
// Modals therefore visually overlay the mobile drawer. Z-index
// alone, however, does not solve the **focus-trap conflict**:
//
//   - When the mobile drawer is open (`sidebarOpen=true` on
//     `<768px`), AppShell installs a document-level `keydown`
//     listener via `useFocusTrap` (active=true). Escape closes
//     the drawer; Tab cycles focus inside the aside.
//   - When a modal is open (TokenModal closable / DirectoryBrowser),
//     the modal component also installs a document-level `keydown`
//     listener via `useFocusTrap`. Escape closes the modal.
//
// If both are open at once, a single Escape press fires
// `onClose`/`onCancel` on BOTH layers (modal closes AND drawer
// closes — see `tests/e2e/specs/09-mobile-drawer.spec.ts` step 6
// for the regression scenario). Tab is intercepted twice
// (preventDefault + focus jumps from each listener, doubling the
// move).
//
// The chosen fix is **modal-over-drawer exclusive**: opening any
// modal forces the drawer closed first, so only ONE focus trap
// is active at any moment. This matches the visual stacking
// (modal covers drawer) and the user's mental model ("opening a
// dialog should hide the thing behind it").
//
// ## Why these tests live as a separate file
//
// The handlers in `<App />` are inline `useCallback` closures over
// React state setters; testing them requires a React reconciler
// and DOM. To keep the test surface tight (project policy: no
// jsdom, see ADR-0009 §决策 4), the modal-opener logic is
// extracted as two pure helpers in App.tsx:
//
//   - `openSettingsAndCloseDrawer(args)`
//   - `openBrowserAndCloseDrawer(args)`
//
// Both take only the relevant React setters as arguments, so
// unit testing is trivial: pass `vi.fn()` spies, assert call
// ordering and arguments. The integration with `<App />` itself
// (identity-stable `useCallback` wrappers that close over the
// setters) is reviewed + exercised by the e2e spec.
//
// ## Coverage (≥4 cases per task brief W1)
//
//   1. openSettingsAndCloseDrawer — setSettingsOpen(true) AND
//      setSidebarOpen(false) both called
//   2. openSettingsAndCloseDrawer — setSidebarOpen called BEFORE
//      setSettingsOpen? (the order doesn't strictly matter for
//      React state, but we assert both fire — the invariant is
//      "both side effects happen", not "drawer closes first")
//   3. openBrowserAndCloseDrawer — setBrowserOpen(true) AND
//      setSidebarOpen(false) both called
//   4. openSettingsAndCloseDrawer does NOT touch setBrowserOpen
//      (and vice versa — no cross-talk between the two paths)
//   5. Direct smoke: both helpers are exported as named functions
//      (sanity pin for refactors)

import { describe, expect, it, vi } from 'vitest';

import {
  openSettingsAndCloseDrawer,
  openBrowserAndCloseDrawer,
} from '../App.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSetters(): {
  setSettingsOpen: ReturnType<typeof vi.fn>;
  setBrowserOpen: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
} {
  return {
    setSettingsOpen: vi.fn(),
    setBrowserOpen: vi.fn(),
    setSidebarOpen: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// openSettingsAndCloseDrawer (Settings button → TokenModal closable path)
// ---------------------------------------------------------------------------

describe('openSettingsAndCloseDrawer — W1 焦点陷阱互斥 (settings path)', () => {
  it('1. setSettingsOpen(true) AND setSidebarOpen(false) both fire (mutex contract)', () => {
    const setters = makeSetters();
    openSettingsAndCloseDrawer(setters);
    expect(setters.setSettingsOpen).toHaveBeenCalledTimes(1);
    expect(setters.setSettingsOpen).toHaveBeenCalledWith(true);
    // W1 — modal 打开前先收抽屉，保证 document 上至多一个 useFocusTrap
    // keydown listener。
    expect(setters.setSidebarOpen).toHaveBeenCalledTimes(1);
    expect(setters.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('2. 不触动 setBrowserOpen (no cross-talk — Settings 与 DirectoryBrowser 路径独立)', () => {
    const setters = makeSetters();
    openSettingsAndCloseDrawer(setters);
    // setBrowserOpen 在 Settings 路径下不应被触发 (否则会造成意外状态翻转)。
    expect(setters.setBrowserOpen).not.toHaveBeenCalled();
  });

  it('3. 幂等性: 连调两次同样参数 → 同样 4 次 setter 调用 (无状态累积 / 副作用漂移)', () => {
    const setters = makeSetters();
    openSettingsAndCloseDrawer(setters);
    openSettingsAndCloseDrawer(setters);
    expect(setters.setSettingsOpen).toHaveBeenCalledTimes(2);
    expect(setters.setSidebarOpen).toHaveBeenCalledTimes(2);
    expect(setters.setBrowserOpen).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// openBrowserAndCloseDrawer (Sidebar WorkDirs tab → DirectoryBrowser path)
// ---------------------------------------------------------------------------

describe('openBrowserAndCloseDrawer — W1 焦点陷阱互斥 (DirectoryBrowser path)', () => {
  it('4. setBrowserOpen(true) AND setSidebarOpen(false) both fire (mutex contract)', () => {
    const setters = makeSetters();
    openBrowserAndCloseDrawer({
      setBrowserOpen: setters.setBrowserOpen,
      setSidebarOpen: setters.setSidebarOpen,
    });
    expect(setters.setBrowserOpen).toHaveBeenCalledTimes(1);
    expect(setters.setBrowserOpen).toHaveBeenCalledWith(true);
    // W1 — DirectoryBrowser 也 trap 全开，开之前同样先收抽屉。
    expect(setters.setSidebarOpen).toHaveBeenCalledTimes(1);
    expect(setters.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('5. 不触动 setSettingsOpen (no cross-talk)', () => {
    const setters = makeSetters();
    openBrowserAndCloseDrawer({
      setBrowserOpen: setters.setBrowserOpen,
      setSidebarOpen: setters.setSidebarOpen,
    });
    expect(setters.setSettingsOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Smoke pin — refactor safety
// ---------------------------------------------------------------------------

describe('App.tsx — W1 helpers export surface', () => {
  it('6. openSettingsAndCloseDrawer is an exported function (refactor-safe)', () => {
    expect(typeof openSettingsAndCloseDrawer).toBe('function');
  });

  it('7. openBrowserAndCloseDrawer is an exported function (refactor-safe)', () => {
    expect(typeof openBrowserAndCloseDrawer).toBe('function');
  });
});
