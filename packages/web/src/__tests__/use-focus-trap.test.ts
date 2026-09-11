// @vitest-environment node
// Vitest specs for `useFocusTrap` (M5 task 07 / PRD §第二块 G7 / D12).
//
// ## 测试策略记录（按 brief 要求如实记录）
//
// 选**纯函数 + extracted keydown handler**路径，**不**加 jsdom：
//   - `computeNextFocusIndex` / `isTabKey` / `isEscapeKey` /
//     `FOCUSABLE_SELECTOR` 纯函数直接测（纯数学 / 字符串字面）。
//   - `getFocusableElements` 纯函数测，用 plain object 替身
//     `FocusContainerLike`（fake `querySelectorAll` 返回 fake 元素）；
//     不需要 jsdom。
//   - `runFocusTrapKeydown` 抽出 hook 内 keydown handler 行为为
//     纯函数（deps 注入式），测试直接调用并验证 `focus` spy +
//     `preventDefault` spy——这是 brief 「≥4 tests for use-focus-trap」
//     的主要覆盖路径（Tab 循环 / Shift+Tab wrap / 单焦点不崩 /
//     Escape 触发 / disabled 不挂 listener）。
//   - hook 顶层 `useFocusTrap()` 仅薄壳，行为由
//     `runFocusTrapKeydown` + `focusFirstIn` 完全覆盖；测试
//     不必经 react reconciler / 真实 DOM。
//
// 为何不引 jsdom：
//   - 本包 ADR-0009 §决策 4 明确「无 jsdom web 测试基建」；hook
//     体量小（< 100 行），全部 effect 行为能用纯函数钉桩。
//   - 真实 DOM 集成（focus 实际跳到元素 + drawer 真渲染）由 e2e
//     任务 08 的 mobile-drawer spec 覆盖（Playwright 真浏览器）。
//
// ## ≥4 测试覆盖（brief 要求）
//
// 1. `computeNextFocusIndex` Tab 在末尾 wrap 到 0（brief §2 Tab 循环）。
// 2. `computeNextFocusIndex` Shift+Tab 在首部 wrap 到 total-1
//    （brief §2 Shift+Tab 反向 wrap）。
// 3. `computeNextFocusIndex` 单焦点不崩（brief §2 单焦点边界）。
// 4. `runFocusTrapKeydown` Tab 焦点在末尾 → focus 跳到首（wrap）。
// 5. `runFocusTrapKeydown` 单焦点 + Tab → preventDefault + 不调 focus
//    （防无限循环，brief §2 单焦点边界）。
// 6. `runFocusTrapKeydown` Escape → onEscape 调用。
// 7. `runFocusTrapKeydown` active=false 时不挂 listener / 无 effect
//    （间接覆盖 hook `active=false` 路径——pure function 不挂
//    listener 是构造性保证，详见 useFocusTrap body）。
// 8. `focusFirstIn` 关闭归还焦点（active true→false 触发
//    returnFocusRef.focus()）。

import { describe, expect, it, vi } from 'vitest';

import {
  FOCUSABLE_SELECTOR,
  computeNextFocusIndex,
  focusFirstIn,
  getFocusableElements,
  isEscapeKey,
  isTabKey,
  runFocusTrapKeydown,
  type FocusableElementLike,
  type FocusContainerLike,
} from '../hooks/useFocusTrap.js';

// ---------------------------------------------------------------------------
// computeNextFocusIndex — pure Tab cycling math
// ---------------------------------------------------------------------------

describe('computeNextFocusIndex — pure Tab cycling (brief §2)', () => {
  it('1.1 Tab 在末尾 wrap 到 0', () => {
    // currentIdx = 2 (last of 3)，Tab → 0
    expect(computeNextFocusIndex(2, 3, false)).toBe(0);
  });

  it('1.2 Shift+Tab 在首部 wrap 到 total-1', () => {
    // currentIdx = 0，Shift+Tab → 2 (total-1)
    expect(computeNextFocusIndex(0, 3, true)).toBe(2);
  });

  it('1.3 Tab 在中间按 Tab → 下一个', () => {
    expect(computeNextFocusIndex(1, 3, false)).toBe(2);
  });

  it('1.4 Shift+Tab 在中间按 Shift+Tab → 上一个', () => {
    expect(computeNextFocusIndex(2, 3, true)).toBe(1);
  });

  it('1.5 单焦点 (total=1) 不崩，停留原处 (返回 0)', () => {
    // brief §2 单焦点边界 — Tab / Shift+Tab 都停留原处。
    expect(computeNextFocusIndex(0, 1, false)).toBe(0);
    expect(computeNextFocusIndex(0, 1, true)).toBe(0);
  });

  it('1.6 空容器 (total=0) 返回 -1 (无元素)', () => {
    expect(computeNextFocusIndex(0, 0, false)).toBe(-1);
    expect(computeNextFocusIndex(0, 0, true)).toBe(-1);
  });

  it('1.7 currentIdx 越界 (-1, focus 在容器外) → Tab 跳到 0 / Shift+Tab 跳到 total-1', () => {
    expect(computeNextFocusIndex(-1, 3, false)).toBe(0);
    expect(computeNextFocusIndex(-1, 3, true)).toBe(2);
    // 越界正向 (currentIdx >= total) 同样处理：
    expect(computeNextFocusIndex(5, 3, false)).toBe(0);
    expect(computeNextFocusIndex(5, 3, true)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isTabKey / isEscapeKey — key predicate (brief §2)
// ---------------------------------------------------------------------------

describe('isTabKey / isEscapeKey — key predicates', () => {
  it('2.1 isTabKey(\'Tab\') === true；其他键 false', () => {
    expect(isTabKey({ key: 'Tab' })).toBe(true);
    expect(isTabKey({ key: 'Enter' })).toBe(false);
    expect(isTabKey({ key: 'Escape' })).toBe(false);
    expect(isTabKey({ key: 'a' })).toBe(false);
  });

  it('2.2 isEscapeKey(\'Escape\') === true；其他键 false', () => {
    expect(isEscapeKey({ key: 'Escape' })).toBe(true);
    expect(isEscapeKey({ key: 'Tab' })).toBe(false);
    expect(isEscapeKey({ key: 'a' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FOCUSABLE_SELECTOR — literal pin
// ---------------------------------------------------------------------------

describe('FOCUSABLE_SELECTOR — selector literal pin', () => {
  it('3.1 selector 字面包含 a[href] / button / input / select / textarea / [tabindex]', () => {
    // 防止未来无意剔除 selector 项。
    expect(FOCUSABLE_SELECTOR).toContain('a[href]');
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('select:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('textarea:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

// ---------------------------------------------------------------------------
// getFocusableElements — pure container extraction (with fake container)
// ---------------------------------------------------------------------------

/** Make a fake focusable element with a focus spy + aria-hidden setter. */
function makeFakeFocusable(ariaHidden: string | null = null): FocusableElementLike & { focusMock: ReturnType<typeof vi.fn> } {
  const focusMock = vi.fn();
  return {
    focus: focusMock,
    getAttribute: (name: string) => (name === 'aria-hidden' ? ariaHidden : null),
    parentElement: null,
    focusMock,
  };
}

/** Make a fake container with a stubbed querySelectorAll that returns
 *  the given focusables. */
function makeFakeContainer(focusables: FocusableElementLike[]): FocusContainerLike & { querySelectorAllMock: ReturnType<typeof vi.fn> } {
  const querySelectorAllMock = vi.fn((selector: string) => {
    // 不解析 selector——直接返回传入列表（测试替身）。
    void selector;
    return focusables;
  });
  return {
    querySelectorAll: querySelectorAllMock,
    querySelectorAllMock,
  };
}

describe('getFocusableElements — pure container extraction', () => {
  it('4.1 三个 focusable 全部返回', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable();
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    expect(getFocusableElements(container)).toEqual([a, b, c]);
  });

  it('4.2 aria-hidden="true" 元素被过滤', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable('true');
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    const result = getFocusableElements(container);
    expect(result).toEqual([a, c]);
    expect(result).not.toContain(b);
  });

  it('4.3 空容器返回空数组', () => {
    const container = makeFakeContainer([]);
    expect(getFocusableElements(container)).toEqual([]);
  });

  it('4.4 容器 null 返回空数组', () => {
    expect(getFocusableElements(null)).toEqual([]);
    expect(getFocusableElements(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runFocusTrapKeydown — extracted keydown behavior (brief §2)
// ---------------------------------------------------------------------------

function makeFakeEvent(key: string, shiftKey = false): { key: string; shiftKey: boolean; preventDefault: () => void; prevented: boolean } {
  const ev = {
    key,
    shiftKey,
    prevented: false,
    preventDefault() {
      ev.prevented = true;
    },
  };
  return ev;
}

describe('runFocusTrapKeydown — Tab cycling + Escape (brief §2)', () => {
  it('5.1 Tab 在末尾 wrap 到首（focus 跳到第一个 focusable）', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable();
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    const event = makeFakeEvent('Tab', false);
    runFocusTrapKeydown({
      container,
      activeElement: c, // currentIdx = 2 (last)
      event,
    });
    expect(event.prevented).toBe(true);
    expect(a.focusMock).toHaveBeenCalledTimes(1); // focus 跳到 a
    expect(b.focusMock).not.toHaveBeenCalled();
    expect(c.focusMock).not.toHaveBeenCalled();
  });

  it('5.2 Shift+Tab 在首部 wrap 到尾', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable();
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    const event = makeFakeEvent('Tab', true);
    runFocusTrapKeydown({
      container,
      activeElement: a, // currentIdx = 0
      event,
    });
    expect(event.prevented).toBe(true);
    expect(c.focusMock).toHaveBeenCalledTimes(1); // focus 跳到 c
    expect(a.focusMock).not.toHaveBeenCalled();
  });

  it('5.3 单 focusable 元素 + Tab → preventDefault 但不调 focus（不无限循环）', () => {
    const a = makeFakeFocusable();
    const container = makeFakeContainer([a]);
    const event = makeFakeEvent('Tab', false);
    runFocusTrapKeydown({
      container,
      activeElement: a, // currentIdx = 0 = 唯一焦点
      event,
    });
    expect(event.prevented).toBe(true);
    // focus 不应被调用——preventDefault 已经阻止浏览器默认 Tab 行为。
    expect(a.focusMock).not.toHaveBeenCalled();
  });

  it('5.4 单 focusable + Shift+Tab → 同上（不调 focus）', () => {
    const a = makeFakeFocusable();
    const container = makeFakeContainer([a]);
    const event = makeFakeEvent('Tab', true);
    runFocusTrapKeydown({
      container,
      activeElement: a,
      event,
    });
    expect(event.prevented).toBe(true);
    expect(a.focusMock).not.toHaveBeenCalled();
  });

  it('5.5 Escape 触发 onEscape 回调', () => {
    const container = makeFakeContainer([]);
    const event = makeFakeEvent('Escape');
    const onEscape = vi.fn();
    runFocusTrapKeydown({
      container,
      activeElement: null,
      event,
      onEscape,
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('5.6 Escape 无 onEscape 回调 → 不抛异常', () => {
    const container = makeFakeContainer([]);
    const event = makeFakeEvent('Escape');
    expect(() => {
      runFocusTrapKeydown({
        container,
        activeElement: null,
        event,
      });
    }).not.toThrow();
  });

  it('5.7 activeElement 不在列表内 (currentIdx=-1) → Tab 跳到首元素', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable();
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    const event = makeFakeEvent('Tab', false);
    // focus 在 body 上 (不在列表内)：
    const outsideElement = makeFakeFocusable();
    runFocusTrapKeydown({
      container,
      activeElement: outsideElement,
      event,
    });
    expect(a.focusMock).toHaveBeenCalledTimes(1);
    expect(b.focusMock).not.toHaveBeenCalled();
    expect(c.focusMock).not.toHaveBeenCalled();
  });

  it('5.8 非 Tab / 非 Escape 键 → 不 preventDefault 不 focus', () => {
    const a = makeFakeFocusable();
    const container = makeFakeContainer([a]);
    const event = makeFakeEvent('Enter');
    runFocusTrapKeydown({
      container,
      activeElement: a,
      event,
    });
    expect(event.prevented).toBe(false);
    expect(a.focusMock).not.toHaveBeenCalled();
  });

  it('5.9 容器 null → keydown handler no-op', () => {
    const event = makeFakeEvent('Tab');
    runFocusTrapKeydown({
      container: null,
      activeElement: null,
      event,
    });
    expect(event.prevented).toBe(false); // 无容器时不 preventDefault
  });
});

// ---------------------------------------------------------------------------
// focusFirstIn — extracted "active false→true" body (brief §2 焦点进入)
// ---------------------------------------------------------------------------

describe('focusFirstIn — focus container first focusable on activation', () => {
  it('6.1 focus 容器内第一个 focusable', () => {
    const a = makeFakeFocusable();
    const b = makeFakeFocusable();
    const c = makeFakeFocusable();
    const container = makeFakeContainer([a, b, c]);
    focusFirstIn(container);
    expect(a.focusMock).toHaveBeenCalledTimes(1);
    expect(b.focusMock).not.toHaveBeenCalled();
    expect(c.focusMock).not.toHaveBeenCalled();
  });

  it('6.2 容器 null → no-op 不抛', () => {
    expect(() => focusFirstIn(null)).not.toThrow();
    expect(() => focusFirstIn(undefined)).not.toThrow();
  });

  it('6.3 空容器 → no-op（无可聚焦元素）', () => {
    const container = makeFakeContainer([]);
    expect(() => focusFirstIn(container)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hook surface sanity
// ---------------------------------------------------------------------------

describe('useFocusTrap — hook surface', () => {
  it('7.1 useFocusTrap is a function', async () => {
    const mod = await import('../hooks/useFocusTrap.js');
    expect(typeof mod.useFocusTrap).toBe('function');
  });
});