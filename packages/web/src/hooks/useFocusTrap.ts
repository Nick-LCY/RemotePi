// Self-rolled focus trap (PRD §非目标: no Radix / Headless dependency).
//
// `useFocusTrap` behaviour:
//   - `active === true`: install document keydown listener; Tab /
//     Shift+Tab cycle focus inside `containerRef.current` (wrap at
//     ends). Single focusable (or zero) → stay put, only
//     `preventDefault` so focus can't escape the container.
//   - Escape fires `onEscape`.
//   - `active` flips false → true: focus the first focusable in
//     the container.
//   - `active` flips true → false: call
//     `returnFocusRef.current.focus()` (e.g. restore focus to the
//     hamburger button after the drawer closes).
//
// `runFocusTrapKeydown` is extracted as a pure-with-deps function so
// tests can drive it without jsdom (`getFocusableElements` /
// `computeNextFocusIndex` are similarly pure). See
// `use-focus-trap.test.ts` for the testing strategy.

import { useEffect, useRef, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseFocusTrapOptions {
  /** Enable the trap. `false` skips the keydown listener and does
   *  not touch focus. */
  active: boolean;
  /** Container ref. While `active === true` focus is locked
   *  inside this element. `null` is tolerated (mount before the
   *  ref is attached) — the hook treats it as "no container". */
  containerRef: RefObject<HTMLElement | null>;
  /** Escape callback. Only attached while `active === true`. If
   *  omitted, Escape is left to the browser default. */
  onEscape?: () => void;
  /** Focus-restore target. When `active` flips true → false, the
   *  hook calls `returnFocusRef.current.focus()`. Optional — if
   *  omitted or `current === null`, the hook silently skips
   *  restoration. */
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

/** Pull focusable elements out of `container`, filtering any whose
 *  own subtree is `aria-hidden="true"` (a11y consensus: hidden
 *  elements must not be reachable by the trap). `null` /
 *  `undefined` container → empty array. */
export function getFocusableElements(
  container: FocusContainerLike | null | undefined,
): FocusableElementLike[] {
  if (container === null || container === undefined) return [];
  const candidates = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return candidates.filter((el) => {
    let cur: FocusableElementLike | null = el;
    while (cur !== null && cur !== (container as unknown as FocusableElementLike)) {
      if (cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

/** Compute the next focus index for a Tab / Shift+Tab key. `currentIdx`
 *  may be `-1` (focus is outside the list, e.g. initial focus or
 *  after a forced blur).
 *
 *  Edge rules:
 *   - `total === 0` → -1 (no elements to focus).
 *   - `total === 1` → 0 (stay put; the caller still preventDefaults
 *     to keep focus inside the container).
 *   - `currentIdx === -1` → Tab lands on 0; Shift+Tab lands on
 *     `total - 1`.
 *   - Otherwise advance one step, wrapping at the ends. */
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

/** `event.key === 'Tab'`. */
export function isTabKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Tab';
}

/** `event.key === 'Escape'`. */
export function isEscapeKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Escape';
}

// ---------------------------------------------------------------------------
// Extracted effect bodies (pure-ish; for testing)
// ---------------------------------------------------------------------------

/** Focus the first focusable element inside `container`. No-op
 *  when the container is null or has no focusables. */
export function focusFirstIn(container: FocusContainerLike | null | undefined): void {
  if (container === null || container === undefined) return;
  const focusables = getFocusableElements(container);
  const first = focusables[0];
  if (first !== undefined) first.focus();
}

/** Pure keydown handler extracted for testing. See `FocusTrapKeydownDeps`
 *  for the inputs; the function consumes only the fields it needs
 *  off `event` (key / shiftKey / preventDefault). */
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
  // Single focusable: stay put, still preventDefault so the browser
  // doesn't tab out of the container.
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

/** React hook — focus trap. See file header for behaviour and
 *  `UseFocusTrapOptions` for the configuration surface. */
export function useFocusTrap(options: UseFocusTrapOptions): void {
  const { active, containerRef, onEscape, returnFocusRef } = options;

  // Track the previous active state to drive the false→true /
  // true→false transitions. `useRef` is read synchronously
  // alongside the commit, so no extra effect / frame is needed.
  const prevActiveRef = useRef(active);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;

    if (active && !wasActive) {
      focusFirstIn(containerRef.current);
    } else if (!active && wasActive) {
      const target = returnFocusRef?.current ?? null;
      if (target !== null) target.focus();
    }
  }, [active, containerRef, returnFocusRef]);

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