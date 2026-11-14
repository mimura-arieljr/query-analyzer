import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, useScan } from '../src/motion';
import { WaitPanel } from '../src/WaitPanel';

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Small steps so React re-renders (and schedules the next timer) between ticks, as in a browser.
function advance(ms: number) {
  for (let left = ms; left > 0; left -= 50) act(() => vi.advanceTimersByTime(Math.min(50, left)));
}
const stepClasses = () => [...document.querySelectorAll('.wait li')].map((li) => li.className);

describe('prefersReducedMotion', () => {
  it('stays still when matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('reads the media query', () => {
    stubMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('WaitPanel', () => {
  it('walks the steps on a timer', () => {
    stubMotion(false);
    render(<WaitPanel done={false} onFinished={vi.fn()} />);
    expect(stepClasses()).toEqual(['on', '', '']);
    advance(700);
    expect(stepClasses()).toEqual(['done', 'on', '']);
    advance(1400);
    expect(stepClasses()).toEqual(['done', 'done', 'on']);
  });

  it('keeps spinning on the last step while waiting', () => {
    stubMotion(false);
    const onFinished = vi.fn();
    render(<WaitPanel done={false} onFinished={onFinished} />);
    advance(10000);
    expect(stepClasses()).toEqual(['done', 'done', 'on']);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('finishes after the response even when it arrives early', () => {
    stubMotion(false);
    const onFinished = vi.fn();
    const { rerender } = render(<WaitPanel done={false} onFinished={onFinished} />);
    advance(100);
    rerender(<WaitPanel done onFinished={onFinished} />);
    expect(onFinished).not.toHaveBeenCalled();
    advance(300);
    expect(onFinished).not.toHaveBeenCalled();
    advance(200);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('finishes quickly when the response arrives on the last step', () => {
    stubMotion(false);
    const onFinished = vi.fn();
    const { rerender } = render(<WaitPanel done={false} onFinished={onFinished} />);
    advance(3000);
    rerender(<WaitPanel done onFinished={onFinished} />);
    advance(150);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('reports the current step', () => {
    stubMotion(false);
    const onStep = vi.fn();
    render(<WaitPanel done={false} onFinished={vi.fn()} onStep={onStep} />);
    advance(700);
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it('skips straight to results with reduced motion', () => {
    stubMotion(true);
    const onFinished = vi.fn();
    const { rerender } = render(<WaitPanel done={false} onFinished={onFinished} />);
    rerender(<WaitPanel done onFinished={onFinished} />);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

describe('useScan', () => {
  it('steps through the parts while active, looping', () => {
    stubMotion(false);
    const { result } = renderHook(() => useScan(true, 3, 110));
    expect(result.current).toBe(0);
    advance(110);
    expect(result.current).toBe(1);
    advance(220);
    expect(result.current).toBe(0);
  });

  it('returns null when inactive, empty or with reduced motion', () => {
    stubMotion(false);
    expect(renderHook(() => useScan(false, 3, 110)).result.current).toBeNull();
    expect(renderHook(() => useScan(true, 0, 110)).result.current).toBeNull();
    stubMotion(true);
    expect(renderHook(() => useScan(true, 3, 110)).result.current).toBeNull();
  });
});
