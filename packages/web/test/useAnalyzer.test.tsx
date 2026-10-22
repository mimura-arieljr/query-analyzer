import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeResponse, FinalAnalysis } from '@qa/core/types';
import { useAnalyzer } from '../src/useAnalyzer';

const analysis = (what: string) => ({ what_it_does: what }) as unknown as FinalAnalysis;
const okBody = (what: string): AnalyzeResponse => ({ ok: true, analysis: analysis(what) });

interface Deferred {
  resolve: (r: AnalyzeResponse) => void;
}

// Each fetch call returns a promise the test resolves by hand.
function setupFetch() {
  const pending: Deferred[] = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push({ resolve: (r) => resolve(new Response(JSON.stringify(r))) });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { pending, fetchMock };
}

// fetch runs after an async body hash, so wait for the nth call.
const calls = (fetchMock: { mock: { calls: unknown[] } }, n: number) =>
  waitFor(() => expect(fetchMock.mock.calls).toHaveLength(n));

afterEach(() => vi.unstubAllGlobals());

describe('useAnalyzer', () => {
  it('status goes idle, loading, done', async () => {
    const { pending, fetchMock } = setupFetch();
    const { result } = renderHook(() => useAnalyzer('s'));
    expect(result.current.status).toBe('idle');
    act(() => result.current.run('select 1'));
    expect(result.current.status).toBe('loading');
    await calls(fetchMock, 1);
    await act(async () => pending[0]!.resolve(okBody('one')));
    expect(result.current.status).toBe('done');
    expect(result.current.result).toEqual(analysis('one'));
    expect(result.current.error).toBeNull();
  });

  it('sets error and the code on ok:false', async () => {
    const { pending, fetchMock } = setupFetch();
    const { result } = renderHook(() => useAnalyzer('s'));
    act(() => result.current.run('q'));
    await calls(fetchMock, 1);
    await act(async () =>
      pending[0]!.resolve({ ok: false, error: 'throttled', message: 'slow down' }),
    );
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('throttled');
    expect(result.current.result).toBeNull();
  });

  it('run is ignored while loading', async () => {
    const { pending, fetchMock } = setupFetch();
    const { result } = renderHook(() => useAnalyzer('s'));
    act(() => {
      result.current.run('first');
      result.current.run('second');
    });
    await calls(fetchMock, 1);
    // let a wrongly started second request reach fetch before asserting
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.resolve(okBody('one')));
    expect(result.current.status).toBe('done');
  });

  it('a slow first response does not overwrite a newer one', async () => {
    const { pending, fetchMock } = setupFetch();
    const { result } = renderHook(() => useAnalyzer('s'));
    act(() => result.current.run('first'));
    await calls(fetchMock, 1);
    // clear lets a second run start while the first is still in flight
    act(() => result.current.clear());
    act(() => result.current.run('second'));
    await calls(fetchMock, 2);
    await act(async () => pending[1]!.resolve(okBody('second')));
    expect(result.current.result).toEqual(analysis('second'));
    await act(async () => pending[0]!.resolve(okBody('first')));
    expect(result.current.status).toBe('done');
    expect(result.current.result).toEqual(analysis('second'));
  });

  it('a response arriving after clear is ignored', async () => {
    const { pending, fetchMock } = setupFetch();
    const { result } = renderHook(() => useAnalyzer('s'));
    act(() => result.current.run('q'));
    await calls(fetchMock, 1);
    act(() => result.current.clear());
    expect(result.current.status).toBe('idle');
    await act(async () => pending[0]!.resolve(okBody('late')));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.result).toBeNull();
  });
});
