// @vitest-environment jsdom
//
// Project collaboration accepts only a project-bound Workspace context. The
// navigation shell's cached selection must never become authority for a project
// whose persisted scope was not supplied.

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectCollab } from '../src/collab/useProjectCollab';
import {
  resetWorkspaceContextCache,
  useWorkspaceContext,
} from '../src/collab/useWorkspaceContext';

function teamContext(): WorkspaceCollabContext {
  const role = 'member' as const;
  const lifecycleState = 'active' as const;
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role,
    memberStatus: 'active',
    lifecycleState,
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState }),
    displayName: 'Ma Shu',
  };
}

function installNeverResolvingContextFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://d.local').pathname;
    if (pathname.endsWith('/workspace/context')) return new Promise<Response>(() => {});
    return {
      ok: true,
      status: 200,
      json: async () => ({ publishedVersion: 1, syncState: 'local_only' }),
    } as unknown as Response;
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetWorkspaceContextCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceContextCache();
  vi.restoreAllMocks();
});

describe('useProjectCollab workspace-context seeding', () => {
  it('does not borrow a context the navigation shell already resolved', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      if (pathname.endsWith('/workspace/directory')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [teamContext()] }),
        } as unknown as Response;
      }
      if (pathname.endsWith('/workspace/context')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ context: teamContext() }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;

    const shell = renderHook(() => useWorkspaceContext());
    await waitFor(() => {
      expect(shell.result.current.loading).toBe(false);
    });
    shell.unmount();

    installNeverResolvingContextFetch();
    const project = renderHook(() => useProjectCollab('p-private'));

    expect(project.result.current.viewerOnly).toBe(true);
  });

  it('still fails closed on the first read of a session, before any context is known', () => {
    installNeverResolvingContextFetch();
    const project = renderHook(() => useProjectCollab('p-private'));

    expect(project.result.current.viewerOnly).toBe(true);
  });

  it('does not inherit the shell cache when a test injects its own daemon', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      if (pathname.endsWith('/workspace/directory')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [teamContext()] }),
        } as unknown as Response;
      }
      if (pathname.endsWith('/workspace/context')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ context: teamContext() }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;

    const shell = renderHook(() => useWorkspaceContext());
    await waitFor(() => {
      expect(shell.result.current.loading).toBe(false);
    });
    shell.unmount();

    const injected = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const project = renderHook(() => useProjectCollab('p-private', { fetch: injected }));

    expect(project.result.current.viewerOnly).toBe(true);
  });
});
