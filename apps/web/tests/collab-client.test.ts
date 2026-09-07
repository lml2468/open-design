import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabClient } from '../src/collab/collab-client.js';
import { workspaceContextFixture } from './helpers/workspace-context';

const TEAM_CONTEXT = workspaceContextFixture({
  workspaceId: 'workspace-team',
  workspaceMemberId: 'member-viewer',
});

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
}

function makeFetch(options: {
  publishedVersion?: number | null;
  syncState?: string | null;
  failPath?: string;
} = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init?.headers) });
    const pathname = new URL(url, 'http://daemon.local').pathname;
    if (options.failPath && pathname.endsWith(options.failPath)) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    const payload = pathname.endsWith('/collab/status')
      ? {
          publishedVersion: options.publishedVersion ?? null,
          syncState: options.syncState ?? 'synced',
        }
      : { ok: true };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CollabClient', () => {
  it('binds status to the captured workspace identity', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({
      projectId: 'p1',
      fetch: fetchImpl,
      workspaceContext: TEAM_CONTEXT,
    });

    await client.pollStatus();

    for (const call of calls) {
      expect(call.headers.get('x-od-workspace-id')).toBe(TEAM_CONTEXT.workspaceId);
      expect(call.headers.get('x-od-workspace-member-id')).toBe(
        TEAM_CONTEXT.workspaceMemberId,
      );
    }
  });

  it('applies content-transfer SSE state in timestamp order', () => {
    const client = new CollabClient({ projectId: 'p1', fetch: makeFetch().fetchImpl });

    client.applyContentTransferState({
      status: 'downloading',
      version: 8,
      startedAt: 100,
      updatedAt: 100,
    });
    client.applyContentTransferState({
      status: 'idle',
      version: 8,
      startedAt: 100,
      updatedAt: 200,
    });
    client.applyContentTransferState({
      status: 'downloading',
      version: 8,
      startedAt: 100,
      updatedAt: 150,
    });

    expect(client.getSnapshot().contentTransferState).toMatchObject({
      status: 'idle',
      updatedAt: 200,
    });
  });

  it('does not let an older status response clear a newer SSE transfer', async () => {
    let resolveStatus!: (response: Response) => void;
    const statusResponse = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const client = new CollabClient({
      projectId: 'p1',
      fetch: vi.fn(async () => statusResponse) as unknown as typeof fetch,
    });

    const polling = client.pollStatus();
    client.applyContentTransferState({
      status: 'downloading',
      version: 9,
      startedAt: 200,
      updatedAt: 200,
    });
    resolveStatus({
      ok: true,
      status: 200,
      json: async () => ({
        publishedVersion: 8,
        materializedVersion: 8,
        contentTransferState: null,
        syncState: 'synced',
      }),
    } as Response);
    await polling;

    expect(client.getSnapshot().contentTransferState).toMatchObject({
      status: 'downloading',
      version: 9,
    });
  });

  it('polls status on start and stops its timer on stop', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({
      projectId: 'p1',
      fetch: fetchImpl,
      statusPollMs: 1_000,
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((call) => call.url.endsWith('/collab/status'))).toHaveLength(2);

    client.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.filter((call) => call.url.endsWith('/collab/status'))).toHaveLength(2);
  });

  it('reports author changes and publish requests through sync routes', async () => {
    const { fetchImpl, calls } = makeFetch();
    const client = new CollabClient({ projectId: 'p9', fetch: fetchImpl });

    await client.reportChange();
    await client.requestPublish();

    expect(calls.some((call) =>
      call.method === 'POST' && call.url.endsWith('/p9/collab/changed'),
    )).toBe(true);
    expect(calls.some((call) =>
      call.method === 'POST' && call.url.endsWith('/p9/collab/publish'),
    )).toBe(true);
  });

  it('surfaces status failures through onError', async () => {
    const errors: unknown[] = [];
    const client = new CollabClient({
      projectId: 'p1',
      fetch: makeFetch({ failPath: '/collab/status' }).fetchImpl,
      onError: (error) => errors.push(error),
    });

    await client.pollStatus();

    expect(errors).toHaveLength(1);
  });
});
