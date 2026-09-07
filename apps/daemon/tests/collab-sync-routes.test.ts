import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { runVelaResourceCommand } from '../src/collab/vela-cli-resource-adapter.js';
import {
  createCollabRuntime,
  type CollabRuntime,
  type CreateCollabRuntimeOptions,
} from '../src/collab/runtime.js';
import { contextToResourceHubPrincipal } from '../src/collab/resource-principal.js';
import type { WorkspaceContextProvider } from '../src/collab/workspace-context.js';
import { createProjectContentTransferStateStore } from '../src/collab/project-content-transfer-state.js';
import { createSwrCache } from '../src/collab/swr-cache.js';
import { resolveAuthorizedActiveTeamWorkspaceSnapshot } from '../src/collab/active-workspace-selection.js';
import { verifyWorkspaceRequestContext } from '../src/collab/request-workspace-context.js';
import { createCachedWorkspaceDirectoryFetcher } from '../src/collab/vela-workspace-context.js';
import {
  materializePulledTeamMirror,
} from '../src/collab/team-mirror-materializer.js';
import { SHARED_PROJECT_PLACEHOLDER_METADATA_KEY } from '../src/collab/shared-project-placeholder.js';
import { withLastKnownWorkspaceContext } from '../src/collab/workspace-context.js';
import { closeDatabase, getProject, openDatabase } from '../src/db.js';
import { readVelaControlApiContext } from '../src/integrations/vela.js';
import { projectResourceIdFor } from '../src/integrations/vela-team-projects.js';
import {
  registerCollabSyncRoutes,
  type CollabSyncRoutesHandle,
  type PulledProjectStore,
  type RegisterCollabSyncRoutesDeps,
  type RegisterPulledProjectInput,
  type TeamMirrorPullScope,
} from '../src/routes/collab-sync.js';
import { writeProjectManifest } from '../src/project-locations.js';

vi.mock('../src/collab/vela-cli-resource-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/collab/vela-cli-resource-adapter.js')>();
  return {
    ...actual,
    runVelaResourceCommand: vi.fn(),
  };
});

vi.mock('../src/integrations/vela.js', () => ({
  readVelaControlApiContext: vi.fn(() => null),
}));

/** In-memory project store standing in for the daemon's SQLite-backed store, so
 *  a route test can assert register-on-pull without a real database. */
function fakeProjectStore(): PulledProjectStore & {
  projects: Map<string, RegisterPulledProjectInput>;
  bindings: Map<string, TeamMirrorPullScope>;
  registerCalls: number;
} {
  const projects = new Map<string, RegisterPulledProjectInput>();
  const bindings = new Map<string, TeamMirrorPullScope>();
  const store = {
    projects,
    bindings,
    registerCalls: 0,
    get: (projectId: string) => projects.get(projectId) ?? null,
    has: (projectId: string) => projects.has(projectId),
    register(input: RegisterPulledProjectInput) {
      store.registerCalls += 1;
      projects.set(input.id, input);
    },
    update(input: RegisterPulledProjectInput) {
      projects.set(input.id, input);
    },
    materializeTeamMirror(input: RegisterPulledProjectInput, scope: TeamMirrorPullScope) {
      const existing = projects.get(input.id);
      const localRecordChanged = !existing || existing.name === '共享项目';
      if (localRecordChanged) projects.set(input.id, input);
      bindings.set(input.id, scope);
      return { localRecordChanged };
    },
  };
  return store;
}

/** A personal (non-team) workspace context — the default a fresh account lands
 *  on. Non-null and fully populated, but with no `teamId`: the resource hub is
 *  addressed by its `workspaceId` instead, as a partition of one. */
function personalContextProvider(): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-personal-1',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-personal-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 1, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
  return { current: async () => context };
}

/** A fixed team context whose `canShareProjects` bit is forced to the tested
 *  value, served by a minimal provider (no `set` seam). */
function fixedShareContextProvider(canShareProjects: boolean): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: {
      ...buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
      canShareProjects,
    },
  };
  return { current: async () => context };
}

function teamContext(
  workspaceId: string,
  workspaceMemberId: string,
): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceType: 'team',
    teamId: workspaceId,
    workspaceMemberId,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({
      role: 'owner',
      lifecycleState: 'active',
    }),
  };
}

let server: http.Server | null = null;
let runtime: CollabRuntime | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.mocked(runVelaResourceCommand).mockReset();
  vi.mocked(readVelaControlApiContext).mockReturnValue(null);
  runtime?.dispose(); // cancel any pending debounce timers
  runtime = null;
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function startSyncServer(
  workspaceContext?: WorkspaceContextProvider,
  extraDeps?: Omit<RegisterCollabSyncRoutesDeps, 'collab'>,
  runtimeOptions?: Omit<CreateCollabRuntimeOptions, 'workspaceContext'>,
) {
  const app = express();
  app.use(express.json());
  const effectiveWorkspaceContext =
    workspaceContext ?? fixedShareContextProvider(true);
  // Freeze the test authority once, mirroring an authoritative directory
  // fixture. Route verification must never follow later ambient Workspace
  // changes from the runtime provider.
  const authoritativeContext =
    await effectiveWorkspaceContext.current({});
  runtime = createCollabRuntime({
    ...(runtimeOptions ?? {}),
    workspaceContext: effectiveWorkspaceContext,
  });
  const verifyWorkspaceRequest = async (req: express.Request) => {
    if (
      !authoritativeContext
      || req.get('x-od-workspace-id') !== authoritativeContext.workspaceId
      || req.get('x-od-workspace-member-id')
        !== authoritativeContext.workspaceMemberId
    ) {
      return null;
    }
    return authoritativeContext;
  };
  const verifyWorkspaceScope = async (scope: TeamMirrorPullScope) => {
    return Boolean(
      authoritativeContext
      && authoritativeContext.workspaceType === 'team'
      && authoritativeContext.memberStatus === 'active'
      && authoritativeContext.lifecycleState === 'active'
      && authoritativeContext.workspaceId === scope.workspaceId
      && (authoritativeContext.teamId ?? authoritativeContext.workspaceId)
        === scope.resourceTeamId
      && authoritativeContext.workspaceMemberId === scope.viewerMemberId,
    );
  };
  const defaultResolveSharedProject = async (
    projectId: string,
    scope?: TeamMirrorPullScope | null,
  ) => {
    const ownerMemberId =
      scope?.ownerMemberId || authoritativeContext?.workspaceMemberId || '';
    return ownerMemberId
      ? {
          projectId,
          ownerMemberId,
          sharedAt: '2026-07-30T00:00:00.000Z',
        }
      : null;
  };
  const defaultResolveSharedProjectOwner = async (
    projectId: string,
    scope?: { workspaceId: string; workspaceMemberId: string },
  ) => {
    if (
      !authoritativeContext
      || authoritativeContext.workspaceType !== 'team'
      || !scope
      || scope.workspaceId !== authoritativeContext.workspaceId
      || scope.workspaceMemberId !== authoritativeContext.workspaceMemberId
    ) {
      return null;
    }
    return runtime!.projectOwnerMemberId(projectId, {
      teamId:
        authoritativeContext.teamId ?? authoritativeContext.workspaceId,
      memberId: authoritativeContext.workspaceMemberId,
      role: authoritativeContext.role,
      lifecycleState: authoritativeContext.lifecycleState,
    });
  };
  const handle: CollabSyncRoutesHandle = registerCollabSyncRoutes(app, {
    collab: runtime,
    verifyWorkspaceRequest,
    verifyWorkspaceScope,
    resolveSharedProject: defaultResolveSharedProject,
    resolveSharedProjectOwner: defaultResolveSharedProjectOwner,
    ...(extraDeps?.resolveSharedProject && !extraDeps.resolveSharedProjectOwner
      ? {
          resolveSharedProjectOwner: async (
            projectId: string,
            scope?: { workspaceId: string; workspaceMemberId: string },
          ) =>
            (await extraDeps.resolveSharedProject?.(
              projectId,
              scope
                ? {
                    workspaceId: scope.workspaceId,
                    resourceTeamId: scope.workspaceId,
                    viewerMemberId: scope.workspaceMemberId,
                    ownerMemberId: '',
                  }
                : null,
            ))?.ownerMemberId ?? null,
        }
      : {}),
    ...extraDeps,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    handle,
    async json(
      route: string,
      options: {
        method?: string;
        body?: unknown;
        headers?: Record<string, string>;
        workspaceScope?: WorkspaceCollabContext | false;
      } = {},
    ) {
      const init: RequestInit = { method: options.method ?? 'GET' };
      const workspaceScope =
        options.workspaceScope === false
          ? null
          : options.workspaceScope ?? authoritativeContext;
      const requestHeaders: Record<string, string> = {
        ...(workspaceScope
          ? {
              'x-od-workspace-id': workspaceScope.workspaceId,
              'x-od-workspace-member-id': workspaceScope.workspaceMemberId,
            }
          : {}),
        ...(options.headers ?? {}),
      };
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json', ...requestHeaders };
        init.body = JSON.stringify(options.body);
      } else if (Object.keys(requestHeaders).length > 0) {
        init.headers = requestHeaders;
      }
      const response = await fetch(`${base}${route}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
    // Publishing is async (flush → adapter → onPublished); poll until it lands.
    async awaitPublishedVersion(route: string, notEqualTo: number | null): Promise<number | null> {
      let version = notEqualTo;
      for (let i = 0; i < 40 && version === notEqualTo; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        version = (await this.json(route)).body.publishedVersion;
      }
      return version;
    },
  };
}

describe('collab sync routes', () => {
  it('keeps publish callbacks scoped to every workspace sharing the same project', async () => {
    const onPublished = vi.fn();
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => ({
      version: input.principal?.memberId === 'member-a' ? 11 : 22,
    }));
    runtime = createCollabRuntime({
      adapter: { publish },
      onPublished,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (let i = 0; i < 40 && (publish.mock.calls.length < 2 || onPublished.mock.calls.length < 2); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((publish.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, principal: workspaceA }),
        expect.objectContaining({ projectId, principal: workspaceB }),
      ]),
    );
    expect(onPublished.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.publishedVersion(projectId, workspaceA)).toBe(11);
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
    expect(runtime.projectOwnerMemberId(projectId, workspaceA)).toBe('member-a');
    expect(runtime.projectOwnerMemberId(projectId, workspaceB)).toBe('member-b');

    publish.mockClear();
    onPublished.mockClear();
    runtime.scheduler.notifyChanged(projectId, 'save');
    runtime.scheduler.runBoundary(projectId);

    for (
      let i = 0;
      i < 40 &&
      (publish.mock.calls.length < 2 ||
        runtime.publishedVersion(projectId, workspaceA) === null ||
        runtime.publishedVersion(projectId, workspaceB) === null);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((publish.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, reason: 'save', principal: workspaceA }),
        expect.objectContaining({ projectId, reason: 'save', principal: workspaceB }),
      ]),
    );
    expect(onPublished.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.publishedVersion(projectId, workspaceA)).toBe(11);
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
  });

  it('unshares only the requested workspace and keeps other workspace state live', async () => {
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => ({
      version: input.principal?.memberId === 'member-a' ? 11 : 22,
    }));
    const unpublish = vi.fn(async () => undefined);
    const teamProjectCatalog = {
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    runtime = createCollabRuntime({
      adapter: { publish, unpublish },
      teamProjectCatalog,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    await runtime.requestTeamShare(projectId, workspaceA);
    await runtime.requestTeamShare(projectId, workspaceB);
    await runtime.requestTeamUnshare(projectId, workspaceA);

    expect(unpublish).toHaveBeenCalledWith({ projectId, principal: workspaceA });
    expect(teamProjectCatalog.remove).toHaveBeenCalledWith(projectId, workspaceA);
    expect(runtime.publishedVersion(projectId, workspaceA)).toBeNull();
    expect(runtime.projectSyncState(projectId, workspaceA)).toBe('local_only');
    expect(runtime.projectOwnerMemberId(projectId, workspaceA)).toBeNull();
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
    expect(runtime.projectSyncState(projectId, workspaceB)).toBe('synced');
    expect(runtime.projectOwnerMemberId(projectId, workspaceB)).toBe('member-b');
    expect(runtime.publishedVersion(projectId)).toBe(22);
    expect(runtime.projectSyncState(projectId)).toBe('synced');

    publish.mockClear();
    runtime.scheduler.notifyChanged(projectId, 'save');
    runtime.scheduler.runBoundary(projectId);
    for (let i = 0; i < 40 && publish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      projectId,
      reason: 'save',
      principal: workspaceB,
    });
  });

  it('reports ordinary publish failures to every workspace sharing the same project', async () => {
    let failPublish = false;
    const onError = vi.fn();
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => {
      if (failPublish) throw new Error('resource hub unavailable');
      return { version: input.principal?.memberId === 'member-a' ? 11 : 22 };
    });
    runtime = createCollabRuntime({
      adapter: { publish },
      onError,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (
      let i = 0;
      i < 40 &&
      (publish.mock.calls.length < 2 ||
        runtime.publishedVersion(projectId, workspaceA) === null ||
        runtime.publishedVersion(projectId, workspaceB) === null);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    publish.mockClear();
    onError.mockClear();

    failPublish = true;
    runtime.scheduler.notifyChanged(projectId, 'change');
    runtime.scheduler.runBoundary(projectId);

    for (
      let i = 0;
      i < 40 &&
      (onError.mock.calls.length < 2 ||
        runtime.projectSyncState(projectId, workspaceA) !== 'sync_failed' ||
        runtime.projectSyncState(projectId, workspaceB) !== 'sync_failed');
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(onError.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.projectSyncState(projectId, workspaceA)).toBe('sync_failed');
    expect(runtime.projectSyncState(projectId, workspaceB)).toBe('sync_failed');
  });

  it('does not recreate a failed catalog row when a publish error arrives after unshare', async () => {
    let publishCalls = 0;
    const teamProjectCatalog = {
      upsert: vi.fn(async () => null),
      remove: vi.fn(async () => null),
    };
    const workspace = {
      memberId: 'wm-1',
      teamId: 'ws-1',
      role: 'member' as const,
      lifecycleState: 'active' as const,
    };
    runtime = createCollabRuntime({
      adapter: {
        publish: async () => {
          publishCalls += 1;
          if (publishCalls === 1) return { version: 1 };
          throw new Error('project directory removed after unshare');
        },
        unpublish: async () => {},
      },
      workspaceContext: fixedShareContextProvider(true),
      teamProjectCatalog,
    });

    await runtime.requestTeamShare('landing', workspace);
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    teamProjectCatalog.upsert.mockClear();

    await runtime.requestTeamUnshare('landing', workspace);
    runtime.scheduler.notifyChanged('landing', 'save');
    runtime.scheduler.runBoundary('landing');
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runtime.projectSyncState('landing', workspace)).toBe('local_only');
    expect(teamProjectCatalog.upsert).not.toHaveBeenCalled();
  });

  it('preserves existing sync state when rememberTeamShare only seeds ownership', () => {
    runtime = createCollabRuntime();
    const workspace = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    runtime.rememberTeamShare('p1', workspace, 'sync_failed');
    runtime.rememberTeamShare('p1', workspace);
    expect(runtime.projectSyncState('p1', workspace)).toBe('sync_failed');
  });

  it('keeps team-project catalog resource ids scoped per workspace principal', async () => {
    const teamProjectCatalog = {
      list: vi.fn(),
      upsert: vi.fn(async () => null),
    };
    runtime = createCollabRuntime({
      teamProjectCatalog,
    });
    const projectId = 'landing';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const resourceIds = (
      teamProjectCatalog.upsert.mock.calls as unknown as Array<[{
        resourceId?: string;
      }]>
    ).map((call) => call[0]?.resourceId);
    expect(resourceIds).toEqual(
      expect.arrayContaining([
        projectResourceIdFor(projectId, workspaceA),
        projectResourceIdFor(projectId, workspaceB),
      ]),
    );
    expect(projectResourceIdFor(projectId, workspaceA)).not.toBe(projectResourceIdFor(projectId, workspaceB));
  });

  it('writes project discovery metadata when publishing a team share through the runtime', async () => {
    const descriptor = {
      name: 'Electric Studio 2',
      skillId: 'deck-builder',
      designSystemId: 'ds-emerald',
      createdAt: 1719820800000,
      updatedAt: 1719907200000,
      metadata: { kind: 'deck', entryFile: 'index.html' },
    };
    const teamProjectCatalog = {
      upsert: vi.fn(async () => null),
    };
    const workspace = {
      memberId: 'member-owner',
      teamId: 'workspace-team',
      role: 'owner' as const,
      lifecycleState: 'active' as const,
    };
    runtime = createCollabRuntime({
      adapter: { publish: async () => ({ version: 1 }) },
      describeProject: () => descriptor,
      teamProjectCatalog,
    });

    await runtime.requestTeamShare('landing', workspace);
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(teamProjectCatalog.upsert).toHaveBeenCalledWith(
      {
        projectId: 'landing',
        resourceId: projectResourceIdFor('landing', workspace),
        displayName: 'Electric Studio 2',
        syncState: 'synced',
        metadata: descriptor,
      },
      workspace,
    );
  });

  it('restores persisted team-share principals after runtime restart', async () => {
    const projectId = 'shared-after-restart';
    const workspace = {
      memberId: 'member-owner',
      teamId: 'workspace-restart',
      role: 'member' as const,
      lifecycleState: 'active' as const,
    };
    const initialPublish = vi.fn(async () => ({ version: 1 }));
    runtime = createCollabRuntime({
      adapter: { publish: initialPublish },
    });
    runtime.requestTeamShare(projectId, workspace);
    for (let i = 0; i < 40 && initialPublish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtime.dispose();

    const publish = vi.fn(async () => ({ version: 2 }));
    runtime = createCollabRuntime({
      adapter: { publish },
    });
    runtime.rememberTeamShare(projectId, workspace, 'synced');

    expect(runtime.projectOwnerMemberId(projectId, workspace)).toBe('member-owner');
    runtime.scheduler.notifyChanged(projectId, 'change');
    runtime.scheduler.runBoundary(projectId);

    for (let i = 0; i < 40 && publish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      principal: workspace,
    }));
  });

  it('publishes on request and advances the published version monotonically', async () => {
    const context = teamContext('workspace-publish', 'member-publish');
    const api = await startSyncServer({ current: async () => context });
    runtime!.rememberTeamShare(
      'p1',
      contextToResourceHubPrincipal(context)!,
      'synced',
    );
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBeNull();

    const pub = await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    expect(pub.status).toBe(200);
    expect(pub.body.ok).toBe(true);

    const v1 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    expect(v1).toBe(1);

    await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    const v2 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', v1);
    expect(v2).toBe(2);
  });

  it('accepts a coalesced change notification', async () => {
    const context = teamContext('workspace-change', 'member-change');
    const api = await startSyncServer({ current: async () => context });
    runtime!.rememberTeamShare(
      'p1',
      contextToResourceHubPrincipal(context)!,
      'synced',
    );
    const res = await api.json('/api/projects/p1/collab/changed', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('keeps the default route verifier on its authoritative fixture after ambient moves', async () => {
    const contextA = teamContext('workspace-fixture-a', 'member-fixture-a');
    const contextB = teamContext('workspace-fixture-b', 'member-fixture-b');
    let ambientContext = contextA;
    const api = await startSyncServer({
      current: async () => ambientContext,
    });
    runtime!.rememberTeamShare(
      'fixture-project',
      contextToResourceHubPrincipal(contextA)!,
      'synced',
    );

    ambientContext = contextB;
    const response = await api.json(
      '/api/projects/fixture-project/collab/changed',
      {
        method: 'POST',
        workspaceScope: contextA,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('fails status closed before reading or materializing when workspace verification fails', async () => {
    const store = fakeProjectStore();
    const resolveSharedProjectOwner = vi.fn(async () => 'member-owner');
    const context = teamContext('workspace-status', 'member-status');
    let authorityAvailable = true;
    const api = await startSyncServer(
      { current: async () => context },
      {
        projectStore: store,
        resolveSharedProjectOwner,
        verifyWorkspaceRequest: async (req) =>
          authorityAvailable
          && req.get('x-od-workspace-id') === context.workspaceId
          && req.get('x-od-workspace-member-id') === context.workspaceMemberId
            ? context
            : null,
      },
    );

    const missing = await api.json('/api/projects/secret-project/collab/status', {
      workspaceScope: false,
    });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('WORKSPACE_PROJECT_STATUS_DENIED');
    expect(resolveSharedProjectOwner).not.toHaveBeenCalled();
    expect(store.has('secret-project')).toBe(false);

    const spoofed = await api.json('/api/projects/secret-project/collab/status', {
      workspaceScope: false,
      headers: {
        'x-od-workspace-id': 'workspace-spoofed',
        'x-od-workspace-member-id': 'member-spoofed',
      },
    });
    expect(spoofed.status).toBe(403);
    expect(resolveSharedProjectOwner).not.toHaveBeenCalled();
    expect(store.has('secret-project')).toBe(false);

    authorityAvailable = false;
    const unavailable = await api.json('/api/projects/secret-project/collab/status');
    expect(unavailable.status).toBe(403);
    expect(resolveSharedProjectOwner).not.toHaveBeenCalled();
    expect(store.has('secret-project')).toBe(false);
  });

  it('publishes a changed project only to the verified request workspace', async () => {
    const contextA = teamContext('workspace-a', 'member-a');
    const contextB = teamContext('workspace-b', 'member-b');
    const principalA = contextToResourceHubPrincipal(contextA)!;
    const principalB = contextToResourceHubPrincipal(contextB)!;
    const publish = vi.fn(async () => ({ version: 1 }));
    const verifyWorkspaceRequest = async (req: express.Request) => {
      const workspaceId = req.get('x-od-workspace-id');
      const memberId = req.get('x-od-workspace-member-id');
      if (workspaceId === contextA.workspaceId && memberId === contextA.workspaceMemberId) {
        return contextA;
      }
      if (workspaceId === contextB.workspaceId && memberId === contextB.workspaceMemberId) {
        return contextB;
      }
      return null;
    };
    const api = await startSyncServer(
      { current: async () => contextA },
      {
        verifyWorkspaceRequest,
        resolveSharedProjectOwner: async (_projectId, scope) =>
          scope?.workspaceId === contextA.workspaceId
            ? contextA.workspaceMemberId
            : scope?.workspaceId === contextB.workspaceId
              ? contextB.workspaceMemberId
              : null,
      },
      { adapter: { publish } },
    );
    runtime!.rememberTeamShare('shared-project', principalA, 'synced');
    runtime!.rememberTeamShare('shared-project', principalB, 'synced');

    const response = await api.json('/api/projects/shared-project/collab/publish', {
      method: 'POST',
      workspaceScope: contextB,
    });
    expect(response.status).toBe(200);

    for (let i = 0; i < 40 && publish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'shared-project',
      principal: principalB,
    }));
  });

  it('rejects unscoped and spoofed change notifications before scheduling', async () => {
    const context = teamContext('workspace-author', 'member-author');
    const principal = contextToResourceHubPrincipal(context)!;
    const publish = vi.fn(async () => ({ version: 1 }));
    const api = await startSyncServer(
      { current: async () => context },
      undefined,
      { adapter: { publish } },
    );
    runtime!.rememberTeamShare('shared-project', principal, 'synced');

    const missing = await api.json('/api/projects/shared-project/collab/changed', {
      method: 'POST',
      workspaceScope: false,
    });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('WORKSPACE_PROJECT_PUBLISH_DENIED');

    const spoofed = await api.json('/api/projects/shared-project/collab/publish', {
      method: 'POST',
      workspaceScope: false,
      headers: {
        'x-od-workspace-id': 'workspace-spoofed',
        'x-od-workspace-member-id': 'member-spoofed',
      },
    });
    expect(spoofed.status).toBe(403);
    expect(spoofed.body.error).toBe('WORKSPACE_PROJECT_PUBLISH_DENIED');

    expect(runtime!.projectSyncState('shared-project', principal)).toBe('synced');
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps published versions independent per project', async () => {
    const context = teamContext('workspace-independent', 'member-independent');
    const principal = contextToResourceHubPrincipal(context)!;
    const api = await startSyncServer({ current: async () => context });
    runtime!.rememberTeamShare('a', principal, 'synced');
    await api.json('/api/projects/a/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/a/collab/status', null);
    expect((await api.json('/api/projects/b/collab/status')).body.publishedVersion).toBeNull();
  });

  it('reports local_only sync state before any share', async () => {
    const api = await startSyncServer();
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('leases consecutive status reads while publish, share, and pull stay fresh', async () => {
    const context = teamContext('ws-1', 'wm-1');
    const directory = {
      ok: true as const,
      items: [{
        workspaceId: context.workspaceId,
        workspaceName: 'Team',
        workspaceType: 'team' as const,
        workspaceMemberId: context.workspaceMemberId,
        role: context.role,
        memberStatus: context.memberStatus,
        lifecycleState: context.lifecycleState,
      }],
    };
    const fetchReadDirectory = vi.fn(async () => directory);
    const cachedReadDirectory = createCachedWorkspaceDirectoryFetcher({
      fetchDirectory: fetchReadDirectory,
      identityKey: () => 'account-a:config-a',
      ttlMs: 5_000,
    });
    const verifyWorkspaceReadRequest = vi.fn((req: express.Request) =>
      verifyWorkspaceRequestContext({
        req,
        fetchWorkspaceDirectory: cachedReadDirectory,
      }));
    const verifyWorkspaceRequest = vi.fn(async () => ({
      ok: true as const,
      context,
    }));
    const api = await startSyncServer(
      { current: async () => context },
      {
        verifyWorkspaceReadRequest,
        verifyWorkspaceRequest,
        resolveSharedProjectOwner: async () => null,
      },
    );

    expect((await api.json('/api/projects/p1/collab/status')).status).toBe(200);
    expect((await api.json('/api/projects/p1/collab/status')).status).toBe(200);
    expect(verifyWorkspaceReadRequest).toHaveBeenCalledTimes(2);
    expect(fetchReadDirectory).toHaveBeenCalledTimes(1);
    expect(verifyWorkspaceRequest).not.toHaveBeenCalled();

    expect((await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: {
        event: 'project_team_share_requested',
        projectId: 'p1',
      },
    })).status).toBe(200);
    expect((await api.json('/api/projects/p1/collab/publish', {
      method: 'POST',
    })).status).toBe(200);
    // This narrow fixture has no mirror store, so pull reaches its expected
    // post-authorization 502 after proving it used fresh authority.
    expect((await api.json('/api/projects/p1/collab/pull', {
      method: 'POST',
    })).status).toBe(502);
    expect(verifyWorkspaceRequest).toHaveBeenCalledTimes(3);
    expect(fetchReadDirectory).toHaveBeenCalledTimes(1);
  });

  it('reuses the scoped catalog across consecutive status owner reads and refreshes after invalidation', async () => {
    const context = teamContext('ws-status-cache', 'wm-status-viewer');
    const listCatalog = vi.fn(async () => [{
      projectId: 'shared-status-project',
      ownerMemberId: 'wm-status-owner',
    }]);
    const cache = createSwrCache(
      listCatalog,
      () => JSON.stringify([
        context.workspaceId,
        context.workspaceMemberId,
      ]),
      3_000,
    );
    const resolveSharedProjectOwnerForStatus = vi.fn(async (
      projectId: string,
      scope?: { workspaceId: string; workspaceMemberId: string },
    ) => {
      if (
        scope?.workspaceId !== context.workspaceId
        || scope.workspaceMemberId !== context.workspaceMemberId
      ) {
        return null;
      }
      return (await cache())
        .find((entry) => entry.projectId === projectId)
        ?.ownerMemberId ?? null;
    });
    const api = await startSyncServer(
      { current: async () => context },
      { resolveSharedProjectOwnerForStatus },
    );

    expect((await api.json(
      '/api/projects/shared-status-project/collab/status',
    )).status).toBe(200);
    expect((await api.json(
      '/api/projects/shared-status-project/collab/status',
    )).status).toBe(200);
    expect(resolveSharedProjectOwnerForStatus).toHaveBeenCalledTimes(2);
    expect(listCatalog).toHaveBeenCalledTimes(1);

    cache.invalidate();
    expect((await api.json(
      '/api/projects/shared-status-project/collab/status',
    )).status).toBe(200);
    expect(listCatalog).toHaveBeenCalledTimes(2);
  });

  it('rejects a revoked member before consulting a cached status owner catalog', async () => {
    const context = teamContext('ws-revoked-status', 'wm-revoked-status');
    let revoked = false;
    const resolveSharedProjectOwnerForStatus = vi.fn(
      async () => 'wm-status-owner',
    );
    const verifyWorkspaceReadRequest = vi.fn(async () =>
      revoked
        ? {
            ok: false as const,
            status: 403 as const,
            code: 'WORKSPACE_ACCESS_DENIED' as const,
            message: 'workspace membership is inactive',
          }
        : {
            ok: true as const,
            context,
          });
    const api = await startSyncServer(
      { current: async () => context },
      {
        verifyWorkspaceReadRequest,
        resolveSharedProjectOwnerForStatus,
      },
    );

    expect((await api.json(
      '/api/projects/revoked-status-project/collab/status',
    )).status).toBe(200);
    expect(resolveSharedProjectOwnerForStatus).toHaveBeenCalledTimes(1);

    revoked = true;
    expect((await api.json(
      '/api/projects/revoked-status-project/collab/status',
    )).status).toBe(403);
    expect(verifyWorkspaceReadRequest).toHaveBeenCalledTimes(2);
    expect(resolveSharedProjectOwnerForStatus).toHaveBeenCalledTimes(1);
  });

  it('circuits failed status authority reads and retries after the outage lease', async () => {
    let now = 0;
    const context = teamContext('ws-1', 'wm-1');
    const fetchReadDirectory = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, items: [] })
      .mockResolvedValueOnce({
        ok: true as const,
        items: [{
          workspaceId: context.workspaceId,
          workspaceName: 'Team',
          workspaceType: 'team' as const,
          workspaceMemberId: context.workspaceMemberId,
          role: context.role,
          memberStatus: context.memberStatus,
          lifecycleState: context.lifecycleState,
        }],
      });
    const cachedReadDirectory = createCachedWorkspaceDirectoryFetcher({
      fetchDirectory: fetchReadDirectory,
      identityKey: () => 'account-a:config-a',
      ttlMs: 5_000,
      failureBackoffMinMs: 100,
      failureBackoffMaxMs: 100,
      now: () => now,
      random: () => 0,
    });
    const api = await startSyncServer(
      { current: async () => context },
      {
        verifyWorkspaceReadRequest: (req) =>
          verifyWorkspaceRequestContext({
            req,
            fetchWorkspaceDirectory: cachedReadDirectory,
          }),
        verifyWorkspaceRequest: vi.fn(async () => ({
          ok: true as const,
          context,
        })),
        resolveSharedProjectOwner: async () => null,
      },
    );

    expect((await api.json('/api/projects/p1/collab/status')).status).toBe(503);
    expect((await api.json('/api/projects/p1/collab/status')).status).toBe(503);
    expect(fetchReadDirectory).toHaveBeenCalledOnce();

    now = 100;
    expect((await api.json('/api/projects/p1/collab/status')).status).toBe(200);
    expect(fetchReadDirectory).toHaveBeenCalledTimes(2);
  });

  it('registers a local placeholder when a member opens a not-yet-pulled shared project', async () => {
    const projectStore = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore,
      resolveSharedProjectOwner: async () => 'other-owner',
    });
    expect(projectStore.has('shared-p')).toBe(false);
    // The first status poll a member fires on opening the shared project must
    // register the placeholder so the other project routes stop 404ing while
    // the pull runs.
    const res = await api.json('/api/projects/shared-p/collab/status');
    expect(res.status).toBe(200);
    expect(projectStore.registerCalls).toBe(1);
    expect(projectStore.projects.get('shared-p')?.name).toBe('共享项目');
    // Idempotent: subsequent polls do not re-register the now-known project.
    await api.json('/api/projects/shared-p/collab/status');
    expect(projectStore.registerCalls).toBe(1);
  });

  it('reports the durable owner-scoped materialized version for a shared project', async () => {
    const readMaterializedVersion = vi.fn(() => 6);
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProjectOwner: async () => 'wm-owner',
        readMaterializedVersion,
      },
      {
        adapter: {
          publish: async () => ({ version: 7 }),
          syncLatest: async () => ({ version: 7 }),
        },
      },
    );

    const first = await api.json('/api/projects/shared-p/collab/status');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      publishedVersion: null,
      materializedVersion: null,
      ownerMemberId: 'wm-owner',
    });
    expect(await api.awaitPublishedVersion(
      '/api/projects/shared-p/collab/status',
      null,
    )).toBe(7);
    const res = await api.json('/api/projects/shared-p/collab/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publishedVersion: 7,
      materializedVersion: 6,
      ownerMemberId: 'wm-owner',
    });
    expect(readMaterializedVersion).toHaveBeenCalledWith('shared-p', {
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      viewerMemberId: 'wm-1',
      ownerMemberId: 'wm-owner',
    });
  });

  it('returns the daemon-local content transfer snapshot for reconnects', async () => {
    const contentTransferState = {
      status: 'downloading' as const,
      version: 8,
      startedAt: 100,
      updatedAt: 101,
    };
    const readContentTransferState = vi.fn(() => contentTransferState);
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProjectOwner: async () => 'wm-owner',
        readContentTransferState,
      },
    );

    const res = await api.json('/api/projects/shared-p/collab/status');

    expect(res.status).toBe(200);
    expect(res.body.contentTransferState).toEqual(contentTransferState);
    expect(readContentTransferState).toHaveBeenCalledWith('shared-p', {
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      viewerMemberId: 'wm-1',
      ownerMemberId: 'wm-owner',
    });
  });

  it('fails closed to a null materialized version when the durable cursor cannot be read', async () => {
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProjectOwner: async () => 'wm-owner',
        readMaterializedVersion: () => {
          throw new Error('cursor unavailable');
        },
      },
      {
        adapter: {
          publish: async () => ({ version: 7 }),
          syncLatest: async () => ({ version: 7 }),
        },
      },
    );

    const res = await api.json('/api/projects/shared-p/collab/status');

    expect(res.status).toBe(200);
    expect(res.body.materializedVersion).toBeNull();
  });

  it('registers a local placeholder when the OWNER opens their own shared project not materialized on this machine', async () => {
    const projectStore = fakeProjectStore();
    const ownerContext = teamContext('ws-1', 'owner-self');
    const api = await startSyncServer({ current: async () => ownerContext }, {
      projectStore,
      // The hub reports the caller themselves as the owner.
      resolveSharedProjectOwner: async () => 'owner-self',
    });
    expect(projectStore.has('shared-owned')).toBe(false);
    // An owner can hit a shared project that is NOT in this daemon's local DB —
    // it was created/shared on another machine (or a smoke-test attributed it to
    // them in the hub). Opening it must still register the placeholder, or
    // conversations/events/tabs 404 and the left pane hangs for a minute. The
    // owner never auto-pulls, so nothing else registers it. callerIsOwner=true
    // here (owner member id === caller's own member id via the workspace header).
    const ownerHeaders = {
      'x-od-workspace-id': 'ws-1',
      'x-od-workspace-member-id': 'owner-self',
    };
    const res = await api.json('/api/projects/shared-owned/collab/status', {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(200);
    expect(projectStore.registerCalls).toBe(1);
    expect(projectStore.projects.get('shared-owned')?.name).toBe('共享项目');
    // Idempotent: the now-known project is not re-registered on the next poll.
    await api.json('/api/projects/shared-owned/collab/status', { headers: ownerHeaders });
    expect(projectStore.registerCalls).toBe(1);
  });

  it('drives the visibility-to-sync team-share intent through to synced', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    const intent = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(intent.status).toBe(200);
    // Team-share is user-facing: the route waits for a durable resource version
    // before reporting success, so teammates never see a catalog-only shell.
    expect(intent.body.syncState).toBe('synced');
    expect(intent.body.publishedVersion).toBe(1);
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBe(1);
  });

  it('moves a team-shared project back to local_only on unshare intent', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);

    const unshare = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });

    expect(unshare.status).toBe(200);
    expect(unshare.body.syncState).toBe('local_only');
    const status = await api.json('/api/projects/p1/collab/status');
    expect(status.body.syncState).toBe('local_only');
    expect(status.body.publishedVersion).toBeNull();
  });

  it('invalidates the team-project catalog on a sync-intent share and unshare', async () => {
    // The display read behind `/api/workspace/projects/team` is served from a
    // 3s SWR entry, so invalidation is part of the mutation contract now. The
    // `/api/workspaces/:id/projects` move path already invalidates; this route
    // — the one `od project share` and CollabDemoView drive — did not, so a
    // catalog GET right after sharing could answer with the pre-share list
    // until the freshness window expired or a hub event happened to arrive.
    const invalidateTeamProjectCatalog = vi.fn();
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      { invalidateTeamProjectCatalog },
    );

    await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(invalidateTeamProjectCatalog).toHaveBeenCalledTimes(1);

    await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });
    expect(invalidateTeamProjectCatalog).toHaveBeenCalledTimes(2);
  });

  it('accepts a visibility-changed intent as a no-op signal', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_visibility_changed', projectId: 'p1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('local_only'); // visibility change alone doesn't publish
  });

  it('rejects an unknown sync intent event', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'nonsense', projectId: 'p1' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a team-share intent from a member without canShareProjects (server-side gate)', async () => {
    // The client hides the share affordance, but the daemon must not trust the
    // client — a member whose context lacks canShareProjects is refused (403),
    // and the project stays local_only (no publish is triggered).
    const api = await startSyncServer(fixedShareContextProvider(false));
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_SHARE_DENIED');
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('refuses a team-share intent when no workspace context is available', async () => {
    const api = await startSyncServer({ current: async () => null });
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_SHARE_DENIED');
    const status = await api.json('/api/projects/p1/collab/status');
    expect(status.status).toBe(403);
    expect(status.body.error).toBe('WORKSPACE_PROJECT_STATUS_DENIED');
  });

  it('honors a team-share intent from a member with canShareProjects', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('synced');
    expect(res.body.publishedVersion).toBe(1);
  });

  it('treats an already shared project owned by another member as shared instead of republishing it', async () => {
    let publishCalls = 0;
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProject: async () => ({
          projectId: 'p1',
          ownerMemberId: 'wm-owner',
          sharedAt: new Date(1).toISOString(),
          name: 'Owner Project',
        }),
      },
      {
        adapter: {
          publish: async () => {
            publishCalls += 1;
            throw new Error('resource hub should not be called');
          },
          syncLatest: async () => null,
          pull: async () => null,
          unpublish: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('synced');
    expect(publishCalls).toBe(0);
  });

  it('refuses to unshare a project owned by another member', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveSharedProject: async () => ({
        projectId: 'p1',
        ownerMemberId: 'wm-owner',
        sharedAt: new Date(1).toISOString(),
        name: 'Owner Project',
      }),
    });

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_UNSHARE_DENIED');
  });

  it('publishes a public file from a personal workspace, scoped by its workspace id', async () => {
    // The public-file routes require A workspace, not a TEAM workspace.
    //
    // They were briefly team-only, on the premise that a hub snapshot is keyed
    // by teamId and a personal session had nothing to publish under. B's
    // control-key auth path stopped refusing non-team callers: it mints a
    // principal whose teamId IS the workspace id, and its access check only
    // compares that id against the resource's own — a partition of one. So a
    // personal workspace must get through, and must be scoped by its OWN id.
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'personal-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    const api = await startSyncServer(personalContextProvider(), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });

    expect(publish.status).toBe(200);
    expect(publish.body).toEqual({
      url: 'https://hub.example.test/api/v1/public/snapshots/personal-slug/files/index.html',
      slug: 'personal-slug',
      fileName: 'index.html',
    });
    // Every hub call carries the personal workspace's own id as the scope —
    // there is no teamId on this context, and nothing may invent one.
    expect(runVelaResourceCommand).toHaveBeenCalled();
    for (const call of vi.mocked(runVelaResourceCommand).mock.calls) {
      expect(call[1]).toBe('ws-personal-1');
    }

    // The published link then reads back and clears like any other.
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    expect(current.body.publication?.slug).toBe('personal-slug');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'personal-slug' },
    });
    expect(unpublish.status).toBe(200);
  });

  it('keeps public file ownership reads on request workspace A while ambient workspace B is active', async () => {
    const workspaceA = teamContext('workspace-a', 'member-a');
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published in A</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'workspace-a-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    const ownershipScopes: Array<TeamMirrorPullScope | null | undefined> = [];
    const resolveSharedProject = vi.fn(async (
      projectId: string,
      scope?: TeamMirrorPullScope | null,
    ) => {
      ownershipScopes.push(scope);
      // Production used to omit this scope, so the catalog adapter fell back
      // to ambient B and returned B's owner for an explicit A request.
      const workspaceId = scope?.workspaceId ?? 'workspace-b';
      return {
        projectId,
        ownerMemberId: workspaceId === 'workspace-a' ? 'member-a' : 'member-b',
        sharedAt: '2026-07-30T00:00:00.000Z',
      };
    });
    const api = await startSyncServer(
      { current: async () => workspaceA },
      {
        resolveProjectDir: () => dir,
        resolveSharedProject,
      },
    );

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'workspace-a-slug' },
    });

    expect(publish.status).toBe(200);
    expect(current.status).toBe(200);
    expect(current.body.publication?.slug).toBe('workspace-a-slug');
    expect(unpublish.status).toBe(200);
    expect(resolveSharedProject).toHaveBeenCalledTimes(3);
    expect(ownershipScopes).toHaveLength(3);
    for (const scope of ownershipScopes) {
      expect(scope).toMatchObject({
        workspaceId: 'workspace-a',
        resourceTeamId: 'workspace-a',
        viewerMemberId: 'member-a',
      });
    }
    for (const call of vi.mocked(runVelaResourceCommand).mock.calls) {
      expect(call[1]).toBe('workspace-a');
    }
  });

  it('explains, rather than bare-codes, a public file publish with no workspace at all', async () => {
    // The gate was widened, not removed. A signed-out caller (or a context read
    // that came back empty) has no id to publish under and no member id to own
    // the resource with, so all three handlers still refuse it — and must ship a
    // human-readable reason alongside the code, since the `od` CLI and embedding
    // agents surface the body verbatim. The sentence now says SIGN IN; telling a
    // personal user to "switch to a team workspace" is no longer true.
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    const api = await startSyncServer(
      { current: async () => null },
      { resolveProjectDir, resolveSharedProject: async () => null },
    );

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const read = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });

    for (const res of [publish, read, unpublish]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('WORKSPACE_IDENTITY_REQUIRED');
      // The load-bearing assertion: a human-readable reason ships with the code.
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/sign in/i);
      expect(res.body.message).not.toMatch(/team workspace/i);
    }
    // The gate must short-circuit before any project read or hub call.
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('refuses public file operations for a shared project owned by another member without side effects', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => ({
        projectId: 'p1',
        ownerMemberId: 'wm-owner',
        sharedAt: new Date(1).toISOString(),
        name: 'Owner Project',
      }),
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'other-member-slug' },
    });

    for (const res of [publish, current, unpublish]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('WORKSPACE_PROJECT_PUBLISH_DENIED');
    }
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('fails public file publish and unpublish when ownership lookup fails', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => {
        throw new Error('catalog unavailable');
      },
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });

    expect(publish.status).toBe(503);
    expect(publish.body.error).toBe('WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE');
    expect(unpublish.status).toBe(503);
    expect(unpublish.body.error).toBe('WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('does not create a public snapshot when no public base URL is configured', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => null,
    });

    const res = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('PUBLIC_FILE_URL_UNAVAILABLE');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('hydrates and clears public file publication state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'public-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', { method: 'POST' });
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });
    const afterUnpublish = await api.json('/api/projects/p1/files/index.html/publish-public');

    const publication = {
      url: 'https://hub.example.test/api/v1/public/snapshots/public-slug/files/index.html',
      slug: 'public-slug',
      fileName: 'index.html',
    };
    expect(publish.status).toBe(200);
    expect(publish.body).toEqual(publication);
    expect(current.body.publication).toEqual(publication);
    expect(unpublish.status).toBe(200);
    expect(afterUnpublish.body.publication).toBeNull();
  });

  it('publishes a public file when the project-dir resolver is async (production wiring)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'public-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    // Production injects resolveProjectDir as an async resolver (it awaits
    // ensureProject before returning the share dir). The handler must await it;
    // otherwise the raw Promise reaches realpath and the owner gets a spurious
    // FILE_UNAVAILABLE even though the file is present and readable.
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: async () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', { method: 'POST' });

    expect(publish.status).toBe(200);
    expect(publish.body).toEqual({
      url: 'https://hub.example.test/api/v1/public/snapshots/public-slug/files/index.html',
      slug: 'public-slug',
      fileName: 'index.html',
    });
  });

  it('rejects escaped and symlinked public file paths before publishing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'od-public-outside-'));
    tempDirs.push(dir, outsideDir);
    await writeFile(path.join(outsideDir, 'secret.html'), '<h1>Secret</h1>');
    await symlink(path.join(outsideDir, 'secret.html'), path.join(dir, 'secret-link.html'));
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const backslash = await api.json('/api/projects/p1/files/nested%5Csecret.html/publish-public', { method: 'POST' });
    const symlinked = await api.json('/api/projects/p1/files/secret-link.html/publish-public', { method: 'POST' });

    expect(backslash.status).toBe(400);
    expect(backslash.body.error).toBe('invalid_file_path');
    expect(symlinked.status).toBe(400);
    expect(symlinked.body.error).toBe('FILE_UNAVAILABLE');
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('writes and removes the Vela team-project catalog around share intents', async () => {
    const writes: unknown[] = [];
    const removes: string[] = [];
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        adapter: {
          publish: async () => ({ version: 1, versionId: 'version-1' }),
          unpublish: async () => {},
        },
        describeProject: () => ({
          name: 'Electric Studio 2',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
        }),
        teamProjectCatalog: {
          upsert: async (input) => {
            writes.push(input);
          },
          remove: async (projectId) => {
            removes.push(projectId);
          },
        },
      },
    );

    const share = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(share.status).toBe(200);
    expect(writes).toEqual([
      {
        projectId: 'p1',
        resourceId: projectResourceIdFor('p1', {
          teamId: 'team-1',
          memberId: 'wm-1',
          role: 'member',
          lifecycleState: 'active',
        }),
        displayName: 'Electric Studio 2',
        syncState: 'synced',
        lastSyncedVersionId: 'version-1',
        metadata: {
          name: 'Electric Studio 2',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ]);

    const unshare = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });
    expect(unshare.status).toBe(200);
    expect(removes).toEqual(['p1']);
  });

  it('does not pretend a project is shared when the Vela catalog write fails', async () => {
    const unpublish = vi.fn(async () => undefined);
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        adapter: {
          publish: async () => ({ version: 1, versionId: 'version-1' }),
          unpublish,
        },
        teamProjectCatalog: {
          upsert: async () => {
            throw new Error('catalog unavailable');
          },
          remove: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TEAM_PROJECT_PUBLISH_UNAVAILABLE');
    expect(unpublish).toHaveBeenCalledTimes(1);
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('sync_failed');
  });

  it('does not write the team catalog when resource publishing fails', async () => {
    const writes: unknown[] = [];
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        teamProjectCatalog: {
          upsert: async (input) => {
            writes.push(input);
          },
          remove: async () => {},
        },
        adapter: {
          publish: async () => {
            throw new Error('resource hub unavailable');
          },
          syncLatest: async () => null,
          pull: async () => null,
          unpublish: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TEAM_PROJECT_PUBLISH_UNAVAILABLE');
    expect(writes).toEqual([]);
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('sync_failed');
  });

  it('rejects spoofed workspace headers without publishing, pulling, or materializing', async () => {
    const authoritativeContext =
      await fixedShareContextProvider(true).current({});
    if (!authoritativeContext) {
      throw new Error('expected authoritative Team context fixture');
    }
    const projectStore = fakeProjectStore();
    const publish = vi.fn(async () => ({ version: 1 }));
    const pull = vi.fn(async () => ({ version: 1 }));
    const api = await startSyncServer(
      { current: async () => null },
      {
        projectStore,
        resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
        verifyWorkspaceRequest: async (req) =>
          req.get('x-od-workspace-id') === authoritativeContext.workspaceId
          && req.get('x-od-workspace-member-id')
            === authoritativeContext.workspaceMemberId
            ? authoritativeContext
            : null,
        verifyWorkspaceScope: async (scope) =>
          scope.workspaceId === authoritativeContext.workspaceId
          && scope.viewerMemberId
            === authoritativeContext.workspaceMemberId,
        resolveSharedProjectOwner: async () =>
          authoritativeContext.workspaceMemberId,
        resolveSharedProject: async (projectId, scope) => ({
          projectId,
          ownerMemberId:
            scope?.ownerMemberId ?? authoritativeContext.workspaceMemberId,
          sharedAt: '2026-07-30T00:00:00.000Z',
        }),
      },
      {
        adapter: {
          publish,
          pull,
          syncLatest: vi.fn(async () => ({ version: 1 })),
        },
      },
    );
    const headers = {
      'x-od-workspace-id': 'ws-spoofed',
      'x-od-workspace-member-id': 'member-spoofed',
      'x-od-workspace-role': 'owner',
    };

    const intent = await api.json('/api/projects/spoofed-project/collab/sync-intent', {
      method: 'POST',
      workspaceScope: false,
      headers,
      body: {
        event: 'project_team_share_requested',
        projectId: 'spoofed-project',
      },
    });
    const status = await api.json(
      '/api/projects/spoofed-project/collab/status',
      {
        workspaceScope: false,
        headers,
      },
    );
    const pullResponse = await api.json(
      '/api/projects/spoofed-project/collab/pull',
      {
        method: 'POST',
        workspaceScope: false,
        headers,
      },
    );

    expect(intent.status).toBe(403);
    expect(status.status).toBe(403);
    expect(pullResponse.status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(projectStore.has('spoofed-project')).toBe(false);
    expect(runtime!.projectSyncState(
      'spoofed-project',
      contextToResourceHubPrincipal(authoritativeContext)!,
    )).toBe('local_only');
  });

  it('returns retryable 503s before collab side effects when Workspace authority is unavailable', async () => {
    const projectStore = fakeProjectStore();
    const resolveSharedProjectOwner = vi.fn(async () => 'member-1');
    const resolveSharedProject = vi.fn(async () => ({
      projectId: 'authority-outage',
      ownerMemberId: 'member-1',
      sharedAt: '2026-07-30T00:00:00.000Z',
    }));
    const api = await startSyncServer(undefined, {
      projectStore,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner,
      resolveSharedProject,
      verifyWorkspaceRequest: async () => ({
        ok: false,
        status: 503,
        code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
        message: 'workspace membership authority is temporarily unavailable',
        retryable: true,
      }),
    });
    const notifyChanged = vi.spyOn(runtime!.scheduler, 'notifyChanged');

    const responses = [
      await api.json('/api/projects/authority-outage/collab/publish', {
        method: 'POST',
      }),
      await api.json('/api/projects/authority-outage/collab/status'),
      await api.json('/api/projects/authority-outage/collab/pull', {
        method: 'POST',
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
        retryable: true,
      });
    }
    expect(notifyChanged).not.toHaveBeenCalled();
    expect(resolveSharedProjectOwner).not.toHaveBeenCalled();
    expect(resolveSharedProject).not.toHaveBeenCalled();
    expect(projectStore.has('authority-outage')).toBe(false);
  });

  it('pulls the published head for a member (null before any publish)', async () => {
    const api = await startSyncServer(undefined, {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });
    const before = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(before.status).toBe(403);
    expect(before.body.error).toBe('WORKSPACE_PROJECT_PULL_DENIED');

    await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    const after = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(after.body.version).toBe(1);
  });

  it('finishes the exact scoped transfer token when a shared pull succeeds', async () => {
    const pullScope: TeamMirrorPullScope = {
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      viewerMemberId: 'wm-1',
      ownerMemberId: 'wm-owner',
    };
    const transferStates = createProjectContentTransferStateStore();
    const beginContentTransfer = vi.fn(
      (projectId: string, scope: TeamMirrorPullScope, version?: number) =>
        transferStates.begin({ projectId, ...scope }, version).token,
    );
    const finishContentTransfer = vi.fn(
      (
        projectId: string,
        scope: TeamMirrorPullScope,
        token: ReturnType<typeof beginContentTransfer>,
        version?: number,
      ) => {
        transferStates.finish({ projectId, ...scope }, token, version);
      },
    );
    const api = await startSyncServer(fixedShareContextProvider(true), {
      beginContentTransfer,
      finishContentTransfer,
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async (projectId) => ({
        projectId,
        ownerMemberId: pullScope.ownerMemberId,
        sharedAt: '2026-07-25T00:00:00.000Z',
      }),
    });
    await runtime!.requestTeamShare('p1', {
      teamId: pullScope.resourceTeamId,
      memberId: pullScope.ownerMemberId,
      role: 'owner',
      lifecycleState: 'active',
      workspaceType: 'team',
    });

    const pull = await api.handle.pullSharedProject('p1', pullScope);

    expect(pull).toEqual({ status: 'pulled', version: 1 });
    expect(beginContentTransfer).toHaveBeenCalledTimes(1);
    const [projectId, scope, version] =
      beginContentTransfer.mock.calls[0]!;
    const token = beginContentTransfer.mock.results[0]!.value;
    expect(projectId).toBe('p1');
    expect(scope).toEqual(pullScope);
    expect(version).toBeUndefined();
    expect(finishContentTransfer).toHaveBeenCalledWith(
      'p1',
      scope,
      token,
      1,
    );
    expect(transferStates.read({ projectId, ...scope })).toMatchObject({
      status: 'idle',
      version: 1,
    });
  });

  it('refuses to pull a project that is no longer team-shared (revocation)', async () => {
    // The team catalog no longer lists this project (the owner moved it out of
    // the team). A stale local copy on a former member's daemon must not be able
    // to keep pulling fresh content, and the mirror is flagged revoked so its
    // files stop being served.
    const revoked: Array<{ projectId: string; revoked: boolean }> = [];
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveSharedProjectOwner: async () => 'wm-1',
      resolveSharedProject: async () => null,
      markTeamProjectRevoked: (projectId, value) => revoked.push({ projectId, revoked: value }),
    });

    const pull = await api.json('/api/projects/moved-out-project/collab/pull', { method: 'POST' });

    expect(pull.status).toBe(403);
    expect(pull.body.error).toBe('WORKSPACE_PROJECT_PULL_DENIED');
    expect(revoked).toContainEqual({ projectId: 'moved-out-project', revoked: true });
  });

  it('does not register a placeholder project when there is no published version to pull', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolveSharedProject: async (projectId) => ({
        projectId,
        ownerMemberId: 'wm-1',
        sharedAt: '2026-07-30T00:00:00.000Z',
      }),
    });

    const pull = await api.json('/api/projects/unpublished-shared/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(pull.body.version).toBeNull();
    expect(store.has('unpublished-shared')).toBe(false);
  });

  it('fails the pull route when a pulled shared project cannot be registered locally', async () => {
    const api = await startSyncServer(undefined, {
      projectStore: {
        get: () => ({ name: 'Existing project' }),
        has: () => true,
        register: () => {},
        materializeTeamMirror: () => {
          throw new Error('project store unavailable');
        },
      },
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    await api.json('/api/projects/shared-register-fail/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-register-fail/collab/status', null);
    const pull = await api.json('/api/projects/shared-register-fail/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(502);
    expect(pull.body.error).toBe('TEAM_PROJECT_PULL_REGISTER_UNAVAILABLE');
  });

  it('registers a pulled shared project locally so it appears in the project store', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    expect(store.has('shared-1')).toBe(false);
    await api.json('/api/projects/shared-1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-1/collab/status', null);
    const pull = await api.json('/api/projects/shared-1/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);

    // The pull registered a local project record. With no manifest under the
    // (non-existent) pull dir, it falls back to the placeholder name.
    expect(store.has('shared-1')).toBe(true);
    expect(store.projects.get('shared-1')?.name).toBe('共享项目');
  });

  it('notifies notifyFilesChanged after a successful pull, so an open FileViewer refreshes without depending on chokidar surviving the pull\'s directory-replace (recvq6CIesNvWZ)', async () => {
    const store = fakeProjectStore();
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyFilesChanged,
    });

    await api.json('/api/projects/shared-notify/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-notify/collab/status', null);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
    const pull = await api.json('/api/projects/shared-notify/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(notifyFilesChanged).toHaveBeenCalledTimes(1);
    expect(notifyFilesChanged).toHaveBeenCalledWith('shared-notify');
  });

  it('does not call notifyFilesChanged when the pulled project fails to register locally', async () => {
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: {
        get: () => ({ name: 'Existing project' }),
        has: () => true,
        register: () => {},
        materializeTeamMirror: () => {
          throw new Error('project store unavailable');
        },
      },
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyFilesChanged,
    });

    await api.json('/api/projects/shared-notify-fail/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-notify-fail/collab/status', null);
    const pull = await api.json('/api/projects/shared-notify-fail/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(502);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
  });

  // recvqhwv6RPU1j: replacing the "共享项目" placeholder record with the real
  // project name happens only in the daemon DB (registerPulledProject). The
  // only post-pull signal used to be `file-changed`, which makes the web
  // refresh the FILE LIST but never re-read the project record — so a member's
  // sidebar/tab title stayed on the placeholder until a manual page reload.
  // A pull that registered or updated the local record must also emit the
  // existing `project-metadata-changed` thin signal (notifyProjectMetadataChanged)
  // so the open project view re-fetches the record and the title follows.
  it('notifies notifyProjectMetadataChanged when a pull replaces the placeholder record with the real name (recvqhwv6RPU1j)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await writeProjectManifest(dir, {
      schemaVersion: 1,
      id: 'shared-title-notify',
      name: 'Q3 Marketing Site',
      createdAt: 111,
      updatedAt: 222,
    });

    const store = fakeProjectStore();
    store.register({
      id: 'shared-title-notify',
      name: '共享项目',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const notifyProjectMetadataChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
      notifyProjectMetadataChanged,
    });

    await api.json('/api/projects/shared-title-notify/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-title-notify/collab/status', null);
    expect(notifyProjectMetadataChanged).not.toHaveBeenCalled();
    const pull = await api.json('/api/projects/shared-title-notify/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(store.projects.get('shared-title-notify')?.name).toBe('Q3 Marketing Site');
    expect(notifyProjectMetadataChanged).toHaveBeenCalledTimes(1);
    expect(notifyProjectMetadataChanged).toHaveBeenCalledWith('shared-title-notify');
  });

  it('does not notify notifyProjectMetadataChanged when the pulled project already has its real name locally', async () => {
    const store = fakeProjectStore();
    store.register({
      id: 'shared-title-steady',
      name: 'Already Local',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const notifyProjectMetadataChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyProjectMetadataChanged,
    });

    await api.json('/api/projects/shared-title-steady/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-title-steady/collab/status', null);
    const pull = await api.json('/api/projects/shared-title-steady/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    // A content-only pull of an already-named local project changes no
    // metadata the web renders; no spurious refetch signal.
    expect(notifyProjectMetadataChanged).not.toHaveBeenCalled();
  });

  it('prefers the hub project name and metadata when registering a pulled project', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async (projectId) => ({
        projectId,
        ownerMemberId: 'wm-owner',
        sharedAt: '2026-07-09T00:00:00.000Z',
        name: 'Emerald Editorial',
        skillId: 'deck-builder',
        designSystemId: 'ds-emerald',
        createdAt: 123,
        updatedAt: 456,
        metadata: { kind: 'deck', entryFile: 'index.html' },
      }),
    });

    await runtime!.requestTeamShare('shared-from-hub', {
      teamId: 'team-1',
      memberId: 'wm-owner',
      role: 'owner',
      lifecycleState: 'active',
      workspaceType: 'team',
    });
    const pull = await api.json('/api/projects/shared-from-hub/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);

    const registered = store.projects.get('shared-from-hub');
    expect(registered?.name).toBe('Emerald Editorial');
    expect(registered?.skillId).toBe('deck-builder');
    expect(registered?.designSystemId).toBe('ds-emerald');
    expect(registered?.createdAt).toBe(123);
    expect(registered?.updatedAt).toBe(456);
    expect(registered?.metadata).toEqual({ kind: 'deck', entryFile: 'index.html' });
  });

  it('registers a pulled shared project under its real name from the manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    // The shared tree carries the owner's project manifest; register-on-pull
    // reads it so the local record shows the real name after opening.
    await writeProjectManifest(dir, {
      schemaVersion: 1,
      id: 'shared-2',
      name: 'Team Roadmap',
      createdAt: 111,
      updatedAt: 222,
      skillId: 'live-artifact',
      designSystemId: 'ds-9',
    });

    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-2/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-2/collab/status', null);
    await api.json('/api/projects/shared-2/collab/pull', { method: 'POST' });
    const registered = store.projects.get('shared-2');
    expect(registered?.name).toBe('Team Roadmap');
    expect(registered?.skillId).toBe('live-artifact');
    expect(registered?.designSystemId).toBe('ds-9');
    expect(registered?.createdAt).toBe(111);
    expect(registered?.updatedAt).toBe(222);
  });

  it('infers a pulled shared project name from the bundled skill manifest when no project manifest exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, '.od-skills', 'fs-emerald'), { recursive: true });
    await writeFile(
      path.join(dir, '.od-skills', 'fs-emerald', 'open-design.json'),
      JSON.stringify({ title: 'Emerald Editorial', name: 'example-fs-emerald-editorial' }),
    );

    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-skill/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-skill/collab/status', null);
    await api.json('/api/projects/shared-skill/collab/pull', { method: 'POST' });
    expect(store.projects.get('shared-skill')?.name).toBe('Emerald Editorial');
  });

  it('repairs an existing placeholder pulled project name once pulled files expose a title', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, '.od-skills', 'fs-emerald'), { recursive: true });
    await writeFile(
      path.join(dir, '.od-skills', 'fs-emerald', 'open-design.json'),
      JSON.stringify({ title: 'Emerald Editorial' }),
    );

    const store = fakeProjectStore();
    store.register({
      id: 'shared-placeholder',
      name: '共享项目',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-placeholder/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested' },
    });
    await api.awaitPublishedVersion('/api/projects/shared-placeholder/collab/status', null);
    await api.json('/api/projects/shared-placeholder/collab/pull', { method: 'POST' });
    expect(store.registerCalls).toBe(1);
    expect(store.projects.get('shared-placeholder')?.name).toBe('Emerald Editorial');
  });

  it('is idempotent — a pull for an already-local project does not re-register it', async () => {
    const store = fakeProjectStore();
    store.register({
      id: 'shared-3',
      name: 'Already Local',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(store.registerCalls).toBe(1);

    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    await api.json('/api/projects/shared-3/collab/pull', { method: 'POST' });
    // Still exactly one registration; the existing record is left untouched.
    expect(store.registerCalls).toBe(1);
    expect(store.projects.get('shared-3')?.name).toBe('Already Local');
  });

  it('derives read-only from the hub at status time — no pull or in-memory record needed', async () => {
    const api = await startSyncServer(undefined, {
      resolveSharedProjectOwner: async (projectId) =>
        projectId === 'shared-ro' ? 'wm-owner' : null,
    });

    // Straight to status: no pull, no in-memory share record. A project the hub
    // lists as shared by wm-owner reports synced + that owner, so a non-owner
    // member's client (`shared && !isOwner`) renders it single-writer read-only.
    // Deriving every read is what makes read-only survive a daemon restart (which
    // clears the in-memory maps) and an already-pulled project opened without a
    // re-pull — the bug was the pull never recording this at all.
    const status = await api.json('/api/projects/shared-ro/collab/status');
    expect(status.body.syncState).toBe('synced');
    expect(status.body.ownerMemberId).toBe('wm-owner');
  });

  it('leaves a project the hub does not list editable (local_only)', async () => {
    const api = await startSyncServer(undefined, {
      resolveSharedProjectOwner: async () => null,
    });
    const status = await api.json('/api/projects/not-shared/collab/status');
    // Not team-shared → no read-only: the member keeps full edit on their own
    // local project. Read-only never fires just because a status probe ran.
    expect(status.body.syncState).toBe('local_only');
    expect(status.body.ownerMemberId).toBeNull();
  });
});
