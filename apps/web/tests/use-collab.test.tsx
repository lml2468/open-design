// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollab } from '../src/collab/useCollab.js';
import { workspaceContextFixture } from './helpers/workspace-context';

const CONTEXTS = {
  a: workspaceContextFixture({ workspaceId: 'ws-a', workspaceMemberId: 'mem-a' }),
  b: workspaceContextFixture({ workspaceId: 'ws-b', workspaceMemberId: 'mem-b' }),
};

function makeFetch(publishedVersion: number | null) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const payload = url.endsWith('/collab/status')
      ? { publishedVersion, syncState: 'synced' }
      : { ok: true };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCollab', () => {
  it('restarts on workspace identity change and ignores the old scoped status response', async () => {
    const statusReads: Array<{
      workspaceId: string | null;
      resolve: (response: Response) => void;
    }> = [];
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((next) => {
          resolve = next;
        });
        statusReads.push({
          workspaceId: new Headers(init?.headers).get('x-od-workspace-id'),
          resolve,
        });
        return promise;
      },
    ) as unknown as typeof fetch;
    type Props = { context: (typeof CONTEXTS)[keyof typeof CONTEXTS] };
    const { result, rerender } = renderHook(
      ({ context }: Props) => useCollab({
        projectId: 'p1',
        enabled: true,
        workspaceContext: context,
        fetch: fetchImpl,
      }),
      { initialProps: { context: CONTEXTS.a } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    rerender({ context: CONTEXTS.b });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(statusReads.map((read) => read.workspaceId)).toEqual(['ws-a', 'ws-b']);

    await act(async () => {
      statusReads[0]!.resolve(new Response(JSON.stringify({
        publishedVersion: 1,
        syncState: 'synced',
      })));
      await Promise.resolve();
    });
    expect(result.current.publishedVersion).toBeNull();

    await act(async () => {
      statusReads[1]!.resolve(new Response(JSON.stringify({
        publishedVersion: 2,
        syncState: 'synced',
      })));
      await Promise.resolve();
    });
    expect(result.current.publishedVersion).toBe(2);
  });

  it('polls status and exposes the published version', async () => {
    const { fetchImpl } = makeFetch(7);
    const { result } = renderHook(() => useCollab({
      projectId: 'p1',
      enabled: true,
      fetch: fetchImpl,
    }));

    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(result.current.publishedVersion).toBe(7);
  });

  it('does not start when disabled', async () => {
    const { fetchImpl, calls } = makeFetch(null);
    renderHook(() => useCollab({ projectId: 'p1', enabled: false, fetch: fetchImpl }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(calls).toHaveLength(0);
  });

  it('reports changes and publish requests through the client', async () => {
    const { fetchImpl, calls } = makeFetch(null);
    const { result } = renderHook(() => useCollab({
      projectId: 'p1',
      enabled: true,
      fetch: fetchImpl,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    act(() => {
      result.current.reportChange();
      result.current.requestPublish();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(calls.some((call) => call.url.endsWith('/collab/changed'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/collab/publish'))).toBe(true);
  });

  it('stops polling on unmount', async () => {
    const { fetchImpl, calls } = makeFetch(1);
    const { unmount } = renderHook(() => useCollab({
      projectId: 'p1',
      enabled: true,
      statusPollMs: 1_000,
      fetch: fetchImpl,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    unmount();
    const afterUnmount = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(calls).toHaveLength(afterUnmount);
  });
});
