import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  registerCollabContextRoutes,
  type RegisterCollabContextRoutesDeps,
} from '../src/routes/collab-context.js';
import {
  createDevWorkspaceContextProvider,
  parseWorkspaceCollabContext,
  resolveWorkspaceSettingsUrl,
} from '../src/collab/workspace-context.js';
import { createActiveWorkspaceSelectionStore } from '../src/collab/active-workspace-selection.js';

let server: http.Server | null = null;
const roots: string[] = [];

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The minimal payload a dev/demo run PUTs — only enum + identity fields. */
const TEAM_CONTEXT = {
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  displayName: 'Ma Shu',
};

const ADMIN_CONTEXT = {
  ...TEAM_CONTEXT,
  role: 'admin',
};

const TEAM_DIRECTORY_ITEM = {
  workspaceId: 'wm-1',
  workspaceName: 'Workspace 1',
  workspaceType: 'team' as const,
  workspaceMemberId: 'wm-1',
  role: 'member' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

const TEAM_HEADERS = {
  'x-od-workspace-id': 'wm-1',
  'x-od-workspace-member-id': 'wm-1',
};

const TEAM_WORKSPACE_SETTINGS_URL = resolveWorkspaceSettingsUrl('wm-1', undefined);

/** What `parseWorkspaceCollabContext` returns: the minimal input enriched with the
 *  fields it derives — workspaceId fallback, provider/billing defaults, and the
 *  permissions + seat summary derived through B's shared helpers. */
const TEAM_CONTEXT_PARSED: WorkspaceCollabContext = {
  workspaceId: 'wm-1',
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: null,
  providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
  permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  // Invariant: a team context always carries teamId (the workspace IS the
  // team scope) — collab gates on it, so the parser pins it when omitted.
  teamId: 'wm-1',
  displayName: 'Ma Shu',
  ...(TEAM_WORKSPACE_SETTINGS_URL
    ? { workspaceSettingsUrl: TEAM_WORKSPACE_SETTINGS_URL }
    : {}),
};

async function startContextServer(
  overrides: Partial<Omit<RegisterCollabContextRoutesDeps, 'workspaceContext'>> = {},
) {
  const app = express();
  app.use(express.json());
  registerCollabContextRoutes(app, {
    workspaceContext: createDevWorkspaceContextProvider(),
    ...overrides,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    async req(
      route: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
      const init: RequestInit = { method: options.method ?? 'GET' };
      if (options.headers) init.headers = options.headers;
      if (options.body !== undefined) {
        init.headers = { ...options.headers, 'content-type': 'application/json' };
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${base}${route}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
  };
}

describe('parseWorkspaceCollabContext', () => {
  it('accepts a well-formed team context and derives permissions/seats', () => {
    expect(parseWorkspaceCollabContext(TEAM_CONTEXT)).toEqual(TEAM_CONTEXT_PARSED);
  });

  it('rejects a bad enum or a missing member id', () => {
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, role: 'viewer' })).toBeNull();
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, lifecycleState: 'frozen' })).toBeNull();
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, workspaceMemberId: '' })).toBeNull();
  });
});

describe('collab context routes', () => {
  it('requires an explicit workspace/member pair before any context is set', async () => {
    const api = await startContextServer();
    const response = await api.req('/api/workspace/context');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('WORKSPACE_CONTEXT_REQUIRED');
  });

  it('round-trips a context set via the dev PUT for an explicit directory membership', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [TEAM_DIRECTORY_ITEM],
      }),
    });
    const put = await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ context: TEAM_CONTEXT_PARSED });
    expect((await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    })).body).toEqual({ context: TEAM_CONTEXT_PARSED });
  });

  it('uses the settled read verifier for the pure context GET without changing its body', async () => {
    const fetchWorkspaceDirectory = vi.fn(async () => {
      throw new Error('fresh directory should not run');
    });
    const verifyWorkspaceReadAuthority = vi.fn(async () => ({
      ok: true as const,
      context: TEAM_CONTEXT_PARSED,
    }));
    const api = await startContextServer({
      fetchWorkspaceDirectory,
      verifyWorkspaceReadAuthority,
    });
    await api.req('/api/workspace/context', {
      method: 'PUT',
      body: TEAM_CONTEXT,
    });

    const response = await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    });

    expect(response).toEqual({ status: 200, body: { context: TEAM_CONTEXT_PARSED } });
    expect(verifyWorkspaceReadAuthority).toHaveBeenCalledTimes(1);
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('does not let exact-context enrichment downgrade directory-verified Team authority', async () => {
    const verifiedTeamContext: WorkspaceCollabContext = {
      ...TEAM_CONTEXT_PARSED,
      role: 'admin',
      permissions: buildWorkspacePermissions({ role: 'admin', lifecycleState: 'active' }),
    };
    const api = await startContextServer({
      verifyWorkspaceReadAuthority: async () => ({
        ok: true as const,
        context: verifiedTeamContext,
      }),
    });
    await api.req('/api/workspace/context', {
      method: 'PUT',
      body: {
        workspaceId: verifiedTeamContext.workspaceId,
        workspaceType: 'personal',
        workspaceMemberId: verifiedTeamContext.workspaceMemberId,
        role: 'member',
        memberStatus: 'active',
        lifecycleState: 'active',
        planId: 'team_pro',
      },
    });

    const response = await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    });

    expect(response.status).toBe(200);
    expect(response.body.context).toMatchObject({
      workspaceId: verifiedTeamContext.workspaceId,
      workspaceMemberId: verifiedTeamContext.workspaceMemberId,
      workspaceType: 'team',
      role: 'admin',
      permissions: verifiedTeamContext.permissions,
      planId: 'team_pro',
      teamId: verifiedTeamContext.workspaceId,
    });
  });

  it('observes authoritative workspace size without sending names or member identity', async () => {
    const observeWorkspace = vi.fn();
    const api = await startContextServer({
      observeWorkspace,
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [TEAM_DIRECTORY_ITEM],
      }),
    });

    const put = await api.req('/api/workspace/context', {
      method: 'PUT',
      body: TEAM_CONTEXT,
    });
    expect(put.status).toBe(200);
    observeWorkspace.mockClear();
    const response = await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    });

    expect(response.status).toBe(200);
    expect(observeWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      TEAM_CONTEXT_PARSED,
      {
        workspace_type: 'team',
        workspace_lifecycle: 'active',
        billing_state: 'active',
        plan_bucket: 'free',
        provider_mode: 'platform_credits',
        seat_limit: 5,
        member_count: 1,
        seat_state: 'available',
      },
    );
    expect(observeWorkspace.mock.calls[0]?.[2]).not.toHaveProperty('displayName');
    expect(observeWorkspace.mock.calls[0]?.[2]).not.toHaveProperty('workspaceMemberId');
  });

  it('observes directory-only seat capacity as unknown without synthetic counts', async () => {
    const observeWorkspace = vi.fn();
    const api = await startContextServer({
      observeWorkspace,
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [TEAM_DIRECTORY_ITEM],
      }),
    });

    const response = await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    });

    expect(response.status).toBe(200);
    expect(response.body.context.seatSummary).toMatchObject({
      seatLimit: 0,
      usedSeats: 0,
    });
    expect(observeWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: 'wm-1' }),
      expect.objectContaining({ seat_state: 'unknown' }),
    );
    expect(observeWorkspace.mock.calls[0]?.[2]).not.toHaveProperty('seat_limit');
    expect(observeWorkspace.mock.calls[0]?.[2]).not.toHaveProperty('member_count');
  });

  it('clears dev enrichment but retains directory-authorized exact context', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [TEAM_DIRECTORY_ITEM],
      }),
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });
    const cleared = await api.req('/api/workspace/context', { method: 'PUT', body: {} });
    expect(cleared.body).toEqual({ context: null });
    const exact = await api.req('/api/workspace/context', {
      headers: TEAM_HEADERS,
    });
    expect(exact.status).toBe(200);
    expect(exact.body.context).toMatchObject({
      workspaceId: 'wm-1',
      workspaceMemberId: 'wm-1',
      role: 'member',
    });
  });

  it('rejects an invalid context body', async () => {
    const api = await startContextServer();
    const res = await api.req('/api/workspace/context', { method: 'PUT', body: { workspaceType: 'team' } });
    expect(res.status).toBe(400);
  });

  it('requires an explicit workspace/member pair instead of borrowing daemon current state', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [
          {
            workspaceId: 'ws-a',
            workspaceName: 'Workspace A',
            workspaceType: 'team',
            workspaceMemberId: 'wm-a',
            role: 'member',
            memberStatus: 'active',
            lifecycleState: 'active',
          },
          {
            workspaceId: 'ws-b',
            workspaceName: 'Workspace B',
            workspaceType: 'team',
            workspaceMemberId: 'wm-b',
            role: 'owner',
            memberStatus: 'active',
            lifecycleState: 'active',
          },
        ],
      }),
    });
    await api.req('/api/workspace/context', {
      method: 'PUT',
      body: {
        ...TEAM_CONTEXT,
        workspaceId: 'ws-b',
        workspaceMemberId: 'wm-b',
        role: 'owner',
      },
    });

    const missing = await api.req('/api/workspace/context');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('WORKSPACE_CONTEXT_REQUIRED');

    const explicitA = await api.req('/api/workspace/context', {
      headers: {
        'x-od-workspace-id': 'ws-a',
        'x-od-workspace-member-id': 'wm-a',
      },
    });
    expect(explicitA.status).toBe(200);
    expect(explicitA.body.context).toMatchObject({
      workspaceId: 'ws-a',
      workspaceMemberId: 'wm-a',
      role: 'member',
    });
  });

  it('fails retryably when the membership authority cannot verify an explicit context', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({ ok: false, items: [] }),
    });
    const response = await api.req('/api/workspace/context', {
      headers: {
        'x-od-workspace-id': 'ws-a',
        'x-od-workspace-member-id': 'wm-a',
      },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('returns AGENT_AUTH_REQUIRED instead of daemon unavailable for expired credentials', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: false,
        items: [],
        reason: 'unauthorized',
        status: 401,
      }),
    });
    const response = await api.req('/api/workspace/context', {
      headers: {
        'x-od-workspace-id': 'ws-a',
        'x-od-workspace-member-id': 'wm-a',
      },
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: 'AGENT_AUTH_REQUIRED',
        retryable: false,
      },
    });
  });

  it('returns the same structured auth failure from the directory bootstrap endpoint', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: false,
        items: [],
        reason: 'unauthorized',
        status: 401,
      }),
    });
    const response = await api.req('/api/workspace/directory');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: 'AGENT_AUTH_REQUIRED', retryable: false },
    });
  });

  it('returns AGENT_AUTH_REQUIRED when workspace selection encounters expired credentials', async () => {
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: false,
        items: [],
        reason: 'unauthorized',
        status: 401,
      }),
    });
    const response = await api.req('/api/workspace/active', {
      method: 'PUT',
      body: { workspaceId: 'ws-a', workspaceMemberId: 'wm-a' },
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: 'AGENT_AUTH_REQUIRED', retryable: false },
    });
  });

  it('persists the restart default after verifying the request-local selection', async () => {
    const setActive = vi.fn(async () => {});
    const api = await startContextServer({
      activeWorkspace: {
        get: () => 'ws-a',
        set: setActive,
        clear: async () => {},
        clearIf: async () => true,
      },
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'ws-b',
          workspaceName: 'Workspace B',
          workspaceType: 'team',
          workspaceMemberId: 'wm-b',
          role: 'owner',
          memberStatus: 'active',
          lifecycleState: 'active',
        }],
      }),
    });

    const response = await api.req('/api/workspace/active', {
      method: 'PUT',
      body: { workspaceId: 'ws-b', workspaceMemberId: 'wm-b' },
    });
    expect(response.status).toBe(200);
    expect(response.body.context).toMatchObject({
      workspaceId: 'ws-b',
      workspaceMemberId: 'wm-b',
    });
    expect(setActive).toHaveBeenCalledOnce();
    expect(setActive).toHaveBeenCalledWith('ws-b');
  });

  it('keeps the previous directory default when selection persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-workspace-selection-route-'));
    roots.push(root);
    const activeWorkspace = createActiveWorkspaceSelectionStore(root);
    await activeWorkspace.set('ws-a');
    await rm(root, { recursive: true });
    await writeFile(root, 'not a directory', 'utf8');
    const directoryItems = [
      {
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        workspaceType: 'team' as const,
        workspaceMemberId: 'wm-a',
        role: 'member' as const,
        memberStatus: 'active' as const,
        lifecycleState: 'active' as const,
      },
      {
        workspaceId: 'ws-b',
        workspaceName: 'Workspace B',
        workspaceType: 'team' as const,
        workspaceMemberId: 'wm-b',
        role: 'owner' as const,
        memberStatus: 'active' as const,
        lifecycleState: 'active' as const,
      },
    ];
    const api = await startContextServer({
      activeWorkspace,
      fetchWorkspaceDirectory: async () => ({ ok: true, items: directoryItems }),
    });

    const failedSwitch = await api.req('/api/workspace/active', {
      method: 'PUT',
      body: { workspaceId: 'ws-b', workspaceMemberId: 'wm-b' },
    });
    const directory = await api.req('/api/workspace/directory');

    expect(failedSwitch.status).toBe(500);
    expect(activeWorkspace.get()).toBe('ws-a');
    expect(directory).toEqual({
      status: 200,
      body: { items: directoryItems, activeWorkspaceId: 'ws-a' },
    });
  });

  it('does not let stale directory cleanup erase a concurrent workspace switch', async () => {
    let pinned: string | null = 'ws-a';
    let markClearStarted!: () => void;
    let resumeClear!: () => void;
    const clearStarted = new Promise<void>((resolve) => {
      markClearStarted = resolve;
    });
    const clearMayFinish = new Promise<void>((resolve) => {
      resumeClear = resolve;
    });
    const directoryItems = [{
      workspaceId: 'ws-b',
      workspaceName: 'Workspace B',
      workspaceType: 'team' as const,
      workspaceMemberId: 'wm-b',
      role: 'owner' as const,
      memberStatus: 'active' as const,
      lifecycleState: 'active' as const,
    }];
    const api = await startContextServer({
      activeWorkspace: {
        get: () => pinned,
        set: async (workspaceId) => {
          pinned = workspaceId;
        },
        clear: async () => {
          pinned = null;
        },
        clearIf: async (workspaceId) => {
          markClearStarted();
          await clearMayFinish;
          if (pinned !== workspaceId) return false;
          pinned = null;
          return true;
        },
      },
      fetchWorkspaceDirectory: async () => ({ ok: true, items: directoryItems }),
    });

    const staleDirectoryPromise = api.req('/api/workspace/directory');
    await clearStarted;
    const switched = await api.req('/api/workspace/active', {
      method: 'PUT',
      body: { workspaceId: 'ws-b', workspaceMemberId: 'wm-b' },
    });
    resumeClear();
    const staleDirectory = await staleDirectoryPromise;

    expect(switched.status).toBe(200);
    expect(pinned).toBe('ws-b');
    expect(staleDirectory).toEqual({
      status: 200,
      body: { items: directoryItems, activeWorkspaceId: 'ws-b' },
    });
  });
});
