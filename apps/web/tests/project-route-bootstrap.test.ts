import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapProjectRoute } from '../src/state/projects';
import { resetCoalescedGet } from '../src/lib/coalesced-get';

const PROJECT_ID = 'project-a';
const PROJECT_A = {
  id: PROJECT_ID,
  name: 'Project A',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoalescedGet();
});

describe('bootstrapProjectRoute', () => {
  it('loads a local Project directly without Workspace authority headers', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      project: PROJECT_A,
      resolvedDir: '/project-a',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({
      kind: 'found',
      project: PROJECT_A,
      resolvedDir: '/project-a',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}`,
      { cache: 'no-store' },
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('x-od-workspace-id')).toBe(false);
    expect(new Headers(init?.headers).has('x-od-workspace-member-id')).toBe(false);
  });

  it.each([
    { status: 403, kind: 'forbidden' as const },
    { status: 404, kind: 'not-found' as const },
    { status: 503, kind: 'unavailable' as const },
  ])('maps Project HTTP $status to $kind', async ({ status, kind }) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({ kind });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed Project responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      project: { ...PROJECT_A, id: 'other-project' },
    }), { status: 200 })));

    await expect(bootstrapProjectRoute(PROJECT_ID)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('single-flights successful reads and retries unavailable responses', async () => {
    const successFetch = vi.fn(async () => new Response(JSON.stringify({
      project: PROJECT_A,
    }), { status: 200 }));
    vi.stubGlobal('fetch', successFetch);

    await Promise.all([
      bootstrapProjectRoute(PROJECT_ID),
      bootstrapProjectRoute(PROJECT_ID),
    ]);
    expect(successFetch).toHaveBeenCalledTimes(1);

    resetCoalescedGet();
    const failedFetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', failedFetch);
    await bootstrapProjectRoute(PROJECT_ID);
    await bootstrapProjectRoute(PROJECT_ID);
    expect(failedFetch).toHaveBeenCalledTimes(2);
  });
});
