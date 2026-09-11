// useIsMobile — M5 task 07 (PRD §第二块 G7 / D12 / 方案 §4) 移动
// 端判定 hook。
//
// ## 阈值
//
// 单断点 `<768px` 判 mobile，对应 media query `(max-width:
// 767px)`（即 `[0, 767]` 像素区间为 mobile，≥768 为 desktop）。
// 与 PRD §D12 「768px 单断点」对齐。
//
// ## SSR / 无 window 安全
//
// 本包无 SSR（vite SPA，`index.html` 直接 hydrate），但 hook
// 仍然对 `typeof window === 'undefined'` 兜底——React 18 的
// `useSyncExternalStore` 调试或 server snapshot 路径下可能被
// 调到，此时返回 `false`（即默认桌面态）。零运行时风险。
//
// ## StrictMode 双跑安全
//
// React 18 StrictMode 在 dev 下 mount → unmount → mount 双跑
// 同一 effect。hook 用单一 useEffect 注册 listener：
//   - mount-once body 内 `mql.addEventListener('change', ...)`
//   - cleanup body 内 `mql.removeEventListener('change', ...)`
// `mql` 是 mount-once 内取一次的对象（不会双注册），cleanup
// 是同一个 listener 引用（移除匹配）。StrictMode 双跑不会留
// 孤儿 listener。
//
// ## 测试策略
//
// hook 行为（listener 注册 / 注销 / 状态更新）抽出为
// `subscribeToMatchMedia(setIsMobile, window?)` 纯函数——
// 入参 setState + 可选 window 替身，返回 cleanup。测试可在
// stub `globalThis.matchMedia` 后直接调用函数并验证 listener
// 路径，**不**需要 jsdom（保持项目 ADR-0009 §决策 4「无 jsdom
// web 测试基建」约束）。
// 详见 `__tests__/use-is-mobile.test.ts`。

import { useEffect, useState } from 'react';

/** 移动端断点（max-width 像素值）。与 PRD §D12 768px 单断点
 *  对齐：viewport 宽 ≤ 此值判 mobile。 */
export const MOBILE_MAX_WIDTH = 767;

/** matchMedia 媒体查询字符串——与 `MOBILE_MAX_WIDTH` 配对使用。
 *  导出便于测试与外部引用。 */
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/** Pure helper——从 `MediaQueryList` 实例读 matches。Stub 友好
 *  （测试可传入 `{ matches: false }`），SSR 安全（`null` /
 *  `undefined` → false，即默认桌面态）。
 *  导出便于测试：hook 的初始 state + listener 状态合并可独立
 *  钉桩，不依赖 react 渲染。 */
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

/** 读初始 matches 值——SSR 安全（无 window → false；window 无
 *  matchMedia 函数 → false；正常 → stub.get(MOBILE_QUERY).matches）。
 *  抽出为纯函数便于测试。
 *
 *  入参 `window` 可选：默认读 `globalThis.window`（生产环境），
 *  测试可注入替身。
 */
export function readInitialMatches(windowLike?: WindowLike | null): boolean {
  const w: WindowLike | null | undefined = windowLike ?? getGlobalWindowLike();
  if (w === null || w === undefined) return false;
  if (typeof w.matchMedia !== 'function') return false;
  const mql = w.matchMedia(MOBILE_QUERY);
  return readMatchesFrom(mql);
}

/** 注册 matchMedia 'change' 监听并同步一次初始 matches。返回
 *  cleanup 函数（取消监听）。
 *
 *  抽出为纯函数（无 React 依赖）便于测试：测试可注入 `window`
 *  替身 + spy addEventListener / removeEventListener，直接验证
 *  listener 注册 / 注销 / change 派发路径。
 *
 *  入参 `window` 可选：默认读 `globalThis.window`。
 */
export function subscribeToMatchMedia(
  setIsMobile: (value: boolean) => void,
  windowLike?: WindowLike | null,
): () => void {
  const w: WindowLike | null | undefined = windowLike ?? getGlobalWindowLike();
  if (w === null || w === undefined) return () => undefined;
  if (typeof w.matchMedia !== 'function') return () => undefined;
  const mql = w.matchMedia(MOBILE_QUERY);
  // 在 effect 内同步 setMatches：
  //   - 抹平「state 初始值与 effect 运行时 mql.matches 不一致」的
  //     边缘窗口（理论上 useState 初始化已读一次，但若 mount 时
  //     matchMedia 返回新实例则可能不同——这里强制覆盖以保证可钉桩）。
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
  // `w.matchMedia` 类型上是 `unknown`——运行时已是 function（typeof
  // 守卫保证），此处显式断言把 `unknown` 缩为函数签名供 caller 调用。
  const fn = w.matchMedia as (query: string) => MatchMediaLike;
  return {
    matchMedia: fn.bind(w),
  };
}

/** React hook——订阅 viewport 移动端断点变化。
 *
 *  返回 `true` 当 viewport 宽 ≤ `MOBILE_MAX_WIDTH`（767px），
 *  否则 `false`。
 *
 *  SSR 安全——`typeof window === 'undefined'` 时返回 `false`。
 *
 *  StrictMode 双跑安全——`useEffect` 调用 `subscribeToMatchMedia`
 *  一次性注册 listener；cleanup 移除同一 listener 引用。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => readInitialMatches());
  useEffect(() => subscribeToMatchMedia(setIsMobile), []);
  return isMobile;
}