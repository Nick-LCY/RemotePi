import { useEffect, useState } from 'react';

/** 移动端断点（max-width 像素值）。与 PRD §D12 768px 单断点
 *  对齐：viewport 宽 ≤ 此值判 mobile。 */
export const MOBILE_MAX_WIDTH = 767;

/** matchMedia 媒体查询字符串——与 `MOBILE_MAX_WIDTH` 配对使用。
 *  导出便于测试与外部引用。 */
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/** Read the `matches` flag from a `MediaQueryList`-shaped object.
 *  Stub-friendly (tests can pass `{ matches: false }`); SSR-safe
 *  (`null` / `undefined` → false, i.e. desktop default). */
export function readMatchesFrom(mql: { matches: boolean } | null | undefined): boolean {
  if (mql === null || mql === undefined) return false;
  return mql.matches === true;
}

/** 最小 matchMedia 接口——hook 与 `subscribeToMatchMedia` 只读
 *  `.matches` + 调用 `addEventListener('change', fn)` /
 *  `removeEventListener('change', fn)`。SSR / 测试替身只需满足
 *  此接口，无需完整 `MediaQueryList`。 */
export interface MatchMediaLike {
  matches: boolean;
  media: string;
  addEventListener: (type: 'change', listener: (event: MatchMediaChangeEvent) => void) => void;
  removeEventListener: (type: 'change', listener: (event: MatchMediaChangeEvent) => void) => void;
}

export interface MatchMediaChangeEvent {
  matches: boolean;
  media: string;
}

/** 最小 window 接口——hook 只读 `matchMedia(query)`。测试替身
 *  只需满足此接口。 */
export interface WindowLike {
  matchMedia: (query: string) => MatchMediaLike;
}

/** Read the initial viewport-mobile flag. SSR-safe (no window →
 *  false; window without `matchMedia` → false; otherwise
 *  `window.matchMedia(MOBILE_QUERY).matches`). `windowLike` is
 *  optional — defaults to `globalThis.window`. */
export function readInitialMatches(windowLike?: WindowLike | null): boolean {
  const w: WindowLike | null | undefined = windowLike ?? getGlobalWindowLike();
  if (w === null || w === undefined) return false;
  if (typeof w.matchMedia !== 'function') return false;
  const mql = w.matchMedia(MOBILE_QUERY);
  return readMatchesFrom(mql);
}

/** Subscribe to `matchMedia` 'change' and emit the initial match
 *  once. Returns the unsubscribe function. `windowLike` is optional
 *  — defaults to `globalThis.window`. */
export function subscribeToMatchMedia(
  setIsMobile: (value: boolean) => void,
  windowLike?: WindowLike | null,
): () => void {
  const w: WindowLike | null | undefined = windowLike ?? getGlobalWindowLike();
  if (w === null || w === undefined) return () => undefined;
  if (typeof w.matchMedia !== 'function') return () => undefined;
  const mql = w.matchMedia(MOBILE_QUERY);
  // Force-sync inside the effect so the snapshot is always the
  // matchMedia truth at attach time (the `useState` initializer
  // may have read a different instance — e.g. window resized
  // between render and effect).
  setIsMobile(mql.matches);
  const handler = (event: MatchMediaChangeEvent): void => {
    setIsMobile(event.matches);
  };
  mql.addEventListener('change', handler);
  return () => {
    mql.removeEventListener('change', handler);
  };
}

/** 从 globalThis 取 WindowLike 替身。返回 `null` 当 globalThis 无
 *  window / matchMedia 时（SSR / node env）。 */
function getGlobalWindowLike(): WindowLike | null {
  const g = globalThis as { window?: { matchMedia?: unknown } };
  const w = g.window;
  if (w === undefined || w === null) return null;
  if (typeof w.matchMedia !== 'function') return null;
  const fn = w.matchMedia as (query: string) => MatchMediaLike;
  return {
    matchMedia: fn.bind(w),
  };
}

/** React hook — subscribe to the mobile breakpoint. Returns `true`
 *  when viewport width ≤ `MOBILE_MAX_WIDTH` (767px), else `false`.
 *  SSR-safe (returns `false` when `window` is unavailable).
 *  StrictMode-safe (single listener attach / detach via the
 *  `subscribeToMatchMedia` cleanup). */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => readInitialMatches());
  useEffect(() => subscribeToMatchMedia(setIsMobile), []);
  return isMobile;
}