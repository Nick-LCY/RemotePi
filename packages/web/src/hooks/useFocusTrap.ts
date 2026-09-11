// useFocusTrap — M5 task 07 (PRD §第二块 G7 / D12 / 方案 §4) 自实现
// 焦点陷阱 hook。
//
// ## 行为
//
//   - `active === true` 时挂 keydown 监听（document 级），按 Tab
//     / Shift+Tab 在 `containerRef.current` 内 focusable 元素间
//     循环（首尾 wrap）。
//   - 单 focusable（或零 focusable）时不无限循环：Tab 停留在原焦点，
//     仅 `preventDefault` 阻止 focus 跑到容器外。
//   - `Escape` 键触发 `onEscape` 回调（仅 `active === true` 时挂监听）。
//   - `active` 由 `false` 翻 `true`：focus 容器内第一个 focusable。
//   - `active` 由 `true` 翻 `false`：调用 `returnFocusRef.current.focus()`
//     归还焦点（关闭抽屉后焦点回到汉堡按钮）。
//
// ## 为何不引入 Radix / Headless
//
// PRD §非目标明确「不引入 Radix / Headless」——焦点陷阱 / modal /
// 抽屉自实现。本 hook 即自实现版本，体量小（< 100 行）依赖为零。
// 触发条件挂账：「复杂交互组件或 a11y 缺陷时配合 Tailwind 走 shadcn
// 路线」（M+ 候选）。
//
// ## 测试策略
//
// hook 行为（focus / addEventListener / cleanup / focus 归还）抽出
// 为可注入依赖的纯函数（`runFocusTrapKeydown`），便于无 jsdom 测试：
//   - `getFocusableElements` / `computeNextFocusIndex` 纯函数直接
//     测（DOM API 桩 + 纯数学）；
//   - `runFocusTrapKeydown` 测试用 fake element 桩（plain object
//     with `focus` spy / `querySelectorAll` 桩）+ fake document
//     activeElement 钉桩，验证 keydown 路径与 preventDefault。
// 详见 `use-focus-trap.test.ts` header §策略。

import { useEffect, useRef, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** useFocusTrap 选项。Brief 接口： `{ active, containerRef, onEscape?,
 *  returnFocusRef? }`。 */
export interface UseFocusTrapOptions {
  /** 启用 trap。`false` 时不挂 keydown listener、不改 focus。 */
  active: boolean;
  /** 容器 ref。`active === true` 时 focus 锁在该元素内部。
   *  ref 可能为 null（mount 前）；hook 视为空容器处理（不挂 listener，
   *  不报错）。 */
  containerRef: RefObject<HTMLElement | null>;
  /** Escape 键回调。仅 `active === true` 时挂监听。可选——若未传，
   *  Escape 不触发任何行为（直接被浏览器默认处理）。 */
  onEscape?: () => void;
  /** 关闭时焦点归还目标。`active` 由 `true` 翻 `false` 时调用
   *  `returnFocusRef.current.focus()`。可选——若未传或 current 为
   *  null，hook 不报错，跳过归还。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

// ---------------------------------------------------------------------------
// Test-friendly abstract element types (decouple from HTMLElement so
// tests don't need jsdom).
// ---------------------------------------------------------------------------

/** 可聚焦元素最小接口——只需 `focus()` + `getAttribute()`。实际
 *  运行时为 `HTMLElement`（HTMLElement 两个方法都有），测试可注入
 *  plain object 替身。 */
export interface FocusableElementLike {
  focus: () => void;
  getAttribute: (name: string) => string | null;
  /** `parentElement`——HTMLElement 返回 `HTMLElement | null`；替身
   *  也只需返回同形接口或 null。 */
  parentElement: FocusableElementLike | null;
}

/** 容器最小接口——hook 只读 `querySelectorAll(selector)`。
 *  `querySelectorAll` 返回 `Iterable<FocusableElementLike>`——运行时
 *  为 `NodeListOf<HTMLElement>`（HTMLElement 结构满足 FocusableElementLike），
 *  测试可注入 `() => [fake1, fake2, ...]` 等。 */
export interface FocusContainerLike {
  querySelectorAll: (selector: string) => Iterable<FocusableElementLike>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** CSS selector for focusable elements。覆盖：
 *   - `<a href="...">`（href 必须存在才算可聚焦）；
 *   - `<button>`（非 disabled）；
 *   - `<input>` / `<select>` / `<textarea>`（非 disabled，type 不限）；
 *   - `[tabindex]:not([tabindex="-1"])`（programmatic focusable）。
 *  `<area>` / `<embed>` / `<iframe>` / `<object>` 等老式可聚焦元素
 *  本项目无使用，不纳入。 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 从容器内提取可见 / 可聚焦元素。Stub-friendly：传入任意
 *  `querySelectorAll` 实现即可（如 jsdom / 自构造 DOM）。
 *  额外过滤 `aria-hidden="true"` 自身或祖先（a11y 共识——被
 *  aria-hidden 隐藏的元素即便 focusable 也不应被 trap）。
 *  容器本身 `null` → 返回空数组。 */
export function getFocusableElements(
  container: FocusContainerLike | null | undefined,
): FocusableElementLike[] {
  if (container === null || container === undefined) return [];
  const candidates = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return candidates.filter((el) => {
    // aria-hidden 跳过（自身或祖先）。递归 parentElement 链。
    let cur: FocusableElementLike | null = el;
    while (cur !== null && cur !== (container as unknown as FocusableElementLike)) {
      if (cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

/** 纯 Tab 循环计算：给定当前 focus 在元素列表中的位置（`currentIdx`
 *  可为 `-1` 表示当前 focus 不在列表内，如初始 focus / 浏览器
 * 强制 blur 后 Tab）与列表长度 `total`，返回 Tab 后的下一个
 * focus 元素索引。Shift+Tab 反向。
 *
 *  边界规则：
 *   - `total === 0` → 返回 -1（无元素，hook 不挂 listener 处理空容器）。
 *   - `total === 1` → 返回 0（单焦点，Tab / Shift+Tab 都停留原处
 *     ——hook 在该场景下 `preventDefault` 但不 focus 跳，详见
 *     文件 header 「单 focusable 元素不无限循环」）。
 *   - `currentIdx === -1`（focus 不在列表内）：
 *     - Tab 跳到 0（首元素）；
 *     - Shift+Tab 跳到 total-1（尾元素）。
 *   - Tab 在末尾 → wrap 到 0；Shift+Tab 在首部 → wrap 到 total-1。
 */
export function computeNextFocusIndex(
  currentIdx: number,
  total: number,
  shiftKey: boolean,
): number {
  if (total <= 0) return -1;
  if (total === 1) return 0;
  if (currentIdx < 0 || currentIdx >= total) {
    return shiftKey ? total - 1 : 0;
  }
  if (shiftKey) {
    return currentIdx === 0 ? total - 1 : currentIdx - 1;
  }
  return currentIdx === total - 1 ? 0 : currentIdx + 1;
}

/** 是否为 Tab 键。 */
export function isTabKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Tab';
}

/** 是否为 Escape 键。 */
export function isEscapeKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Escape';
}

// ---------------------------------------------------------------------------
// Extracted effect bodies (pure-ish; for testing)
// ---------------------------------------------------------------------------

/** focus 容器内第一个 focusable 元素。无 focusable 时 no-op。 */
export function focusFirstIn(container: FocusContainerLike | null | undefined): void {
  if (container === null || container === undefined) return;
  const focusables = getFocusableElements(container);
  const first = focusables[0];
  if (first !== undefined) first.focus();
}

/** keydown handler 纯函数——抽出便于测试。返回是否调用了
 *  `preventDefault`（true 表示阻止浏览器默认 Tab / Escape 行为）。
 *
 *  入参 `deps`：
 *   - `container`：trap 容器；
 *   - `activeElement`：当前 document.activeElement 替身；
 *   - `event`：keydown 事件替身（仅读 `key` / `shiftKey` / 调
 *     `preventDefault`）；
 *   - `onEscape`：Escape 回调。
 */
export interface FocusTrapKeydownDeps {
  container: FocusContainerLike | null | undefined;
  activeElement: FocusableElementLike | null | undefined;
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'> & { preventDefault: () => void };
  onEscape?: () => void;
}

export function runFocusTrapKeydown(deps: FocusTrapKeydownDeps): void {
  const { container, activeElement, event, onEscape } = deps;
  if (isEscapeKey(event)) {
    if (onEscape !== undefined) onEscape();
    return;
  }
  if (!isTabKey(event)) return;
  if (container === null || container === undefined) return;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) return;
  const currentIdx = focusables.indexOf(activeElement as FocusableElementLike);
  const nextIdx = computeNextFocusIndex(currentIdx, focusables.length, event.shiftKey);
  if (nextIdx < 0) return;
  // 单焦点元素：nextIdx === 0 === currentIdx（currentIdx 是 0）。
  // hook 不调用 focus 切换（防止无限循环），但仍 preventDefault
  // 阻止浏览器默认 Tab 行为（focus 到 container 之后的下一个
  // 元素——可能跳出 trap）。
  if (focusables.length === 1) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  const next = focusables[nextIdx];
  if (next !== undefined) next.focus();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** React hook——焦点陷阱。详见文件 header + `UseFocusTrapOptions` 注释。 */
export function useFocusTrap(options: UseFocusTrapOptions): void {
  const { active, containerRef, onEscape, returnFocusRef } = options;

  // 追踪「上一帧的 active 状态」用于：
  //   - false → true：focus 容器内第一个 focusable（激活 trap）；
  //   - true → false：归还焦点到 returnFocusRef（关闭 trap）。
  // mount 时 active === false → 不会「归还」（否则 mount 时用户焦点
  // 本可能在 body 上，「归还」到按钮会突兀打断）。
  // 用 `useRef` 而非另开 effect——读 ref 与 commit 同步，无需等下
  // 一帧才生效。
  const prevActiveRef = useRef(active);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;

    if (active && !wasActive) {
      // active false → true：focus 容器内第一个 focusable。
      focusFirstIn(containerRef.current);
    } else if (!active && wasActive) {
      // active true → false：归还焦点。
      const target = returnFocusRef?.current ?? null;
      if (target !== null) target.focus();
    }
  }, [active, containerRef, returnFocusRef]);

  // keydown listener：仅 active === true 时挂。
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (container === null || container === undefined) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      runFocusTrapKeydown({
        container,
        activeElement: (document.activeElement ?? null) as FocusableElementLike | null,
        event,
        onEscape,
      });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, containerRef, onEscape]);
}