import { describe, expect, it, vi } from 'vitest';
import type {
  CollabCloudMemberDirectoryEntry,
  TeamProject,
  WorkspaceCollabContext,
  WorkspaceInvalidationSsePayload,
} from '@open-design/contracts';
import { createWorkspaceInvalidationPoller } from '../src/collab/workspace-invalidation-poller.js';

// Minimal team context — `isTeamContext` only reads `workspaceType`/`teamId`,
// and `contextSignature` stringifies the whole object, so a partial cast is a
// faithful stand-in for the diff logic under test.
function teamContext(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    ...overrides,
  } as WorkspaceCollabContext;
}

function personalContext(): WorkspaceCollabContext {
  return { workspaceId: 'ws-1', workspaceType: 'personal', workspaceMemberId: 'wm-1', role: 'member' } as WorkspaceCollabContext;
}

function project(id: string, extra: Partial<TeamProject> = {}): TeamProject {
  return { projectId: id, ownerMemberId: 'wm-1', sharedAt: '2026-01-01T00:00:00Z', ...extra };
}

function member(id: string, extra: Partial<CollabCloudMemberDirectoryEntry> = {}): CollabCloudMemberDirectoryEntry {
  return { memberId: id, displayName: id, role: 'member', ...extra } as CollabCloudMemberDirectoryEntry;
}

interface Harness {
  emitted: WorkspaceInvalidationSsePayload[];
  types: () => string[];
  context: WorkspaceCollabContext | null;
  projects: TeamProject[] | null; // null simulates a transient read failure
  members: CollabCloudMemberDirectoryEntry[] | null;
  contextCalls: number;
  teamListCalls: number;
  memberListCalls: number;
  listedWorkspaceIds: string[];
  emittedWorkspaceIds: Array<string | null>;
  errors: unknown[];
  poller: ReturnType<typeof createWorkspaceInvalidationPoller>;
}

function harness(initial: {
  context?: WorkspaceCollabContext | null;
  projects?: TeamProject[] | null;
  members?: CollabCloudMemberDirectoryEntry[] | null;
  pollIntervalMs?: number;
  realtimePollFloorMs?: number;
  now?: () => number;
  onPollSuppressed?: () => void;
}): Harness {
  const h: Harness = {
    emitted: [],
    types: () => h.emitted.map((e) => e.type),
    context: initial.context === undefined ? teamContext() : initial.context,
    projects: initial.projects === undefined ? [] : initial.projects,
    members: initial.members === undefined ? [] : initial.members,
    contextCalls: 0,
    teamListCalls: 0,
    memberListCalls: 0,
    listedWorkspaceIds: [],
    emittedWorkspaceIds: [],
    errors: [],
    poller: null as unknown as ReturnType<typeof createWorkspaceInvalidationPoller>,
  };
  h.poller = createWorkspaceInvalidationPoller({
    getWorkspaceContext: async () => {
      h.contextCalls += 1;
      return h.context;
    },
    listTeamProjects: async (context) => {
      h.teamListCalls += 1;
      h.listedWorkspaceIds.push(context.workspaceId);
      if (h.projects === null) throw new Error('team-projects read failed');
      return h.projects;
    },
    listMembers: async () => {
      h.memberListCalls += 1;
      if (h.members === null) throw new Error('members read failed');
      return h.members;
    },
    emit: (payload, context) => {
      h.emitted.push(payload);
      h.emittedWorkspaceIds.push(context?.workspaceId ?? null);
    },
    onError: (error) => h.errors.push(error),
    ...(initial.onPollSuppressed
      ? { onPollSuppressed: initial.onPollSuppressed }
      : {}),
    ...(initial.pollIntervalMs != null
      ? { pollIntervalMs: initial.pollIntervalMs }
      : {}),
    ...(initial.realtimePollFloorMs != null
      ? { realtimePollFloorMs: initial.realtimePollFloorMs }
      : {}),
    ...(initial.now ? { now: initial.now } : {}),
  });
  return h;
}

describe('workspace invalidation poller', () => {
  it('establishes a baseline on the first cycle without emitting', async () => {
    const h = harness({ projects: [project('p1')], members: [member('m1')] });
    await h.poller.pollOnce();
    expect(h.emitted).toEqual([]);
  });

  it('emits only team-projects-changed when the shared project list changes', async () => {
    const h = harness({ projects: [project('p1')] });
    await h.poller.pollOnce(); // baseline
    h.projects = [project('p1'), project('p2')];
    await h.poller.pollOnce();
    expect(h.types()).toEqual(['team-projects-changed']);
  });

  it('carries one captured context through catalog read and emission when ambient selection changes', async () => {
    const contextA = teamContext({ workspaceId: 'team-a', teamId: 'team-a' });
    const contextB = teamContext({ workspaceId: 'team-b', teamId: 'team-b' });
    const h = harness({ context: contextA, projects: [project('a')] });
    await h.poller.pollOnce();

    h.context = contextA;
    h.projects = [project('a'), project('a2')];
    let catalogReads = 0;
    let memberReads = 0;
    const poller = createWorkspaceInvalidationPoller({
      getWorkspaceContext: async () => contextA,
      listTeamProjects: async (captured) => {
        h.context = contextB;
        expect(captured.workspaceId).toBe('team-a');
        catalogReads += 1;
        return catalogReads === 1
          ? [project('a')]
          : [project('a'), project('a2')];
      },
      listMembers: async (captured) => {
        expect(captured.workspaceId).toBe('team-a');
        memberReads += 1;
        return memberReads === 1 ? [] : [member('member-a')];
      },
      emit: (payload, captured) => {
        h.emitted.push(payload);
        h.emittedWorkspaceIds.push(captured?.workspaceId ?? null);
      },
    });
    await poller.pollOnce();
    await poller.pollOnce();

    expect(h.context?.workspaceId).toBe('team-b');
    expect(h.emittedWorkspaceIds.slice(-2)).toEqual(['team-a', 'team-a']);
  });

  it('does not emit when the team list is reordered but unchanged', async () => {
    const h = harness({ projects: [project('a'), project('b')] });
    await h.poller.pollOnce();
    h.projects = [project('b'), project('a')];
    await h.poller.pollOnce();
    expect(h.emitted).toEqual([]);
  });

  it('emits only members-changed when the roster changes', async () => {
    const h = harness({ members: [member('m1')] });
    await h.poller.pollOnce();
    h.members = [member('m1'), member('m2')];
    await h.poller.pollOnce();
    expect(h.types()).toEqual(['members-changed']);
  });

  it('emits workspace-context-changed when the context changes', async () => {
    const h = harness({ context: teamContext({ role: 'member' }) });
    await h.poller.pollOnce();
    h.context = teamContext({ role: 'admin' });
    await h.poller.pollOnce();
    expect(h.types()).toEqual(['workspace-context-changed']);
  });

  it('never reads team projects/members while off-team', async () => {
    const h = harness({ context: personalContext(), projects: [project('p1')] });
    await h.poller.pollOnce();
    await h.poller.pollOnce();
    expect(h.teamListCalls).toBe(0);
  });

  it('folds team projects/members to empty when leaving a team', async () => {
    const h = harness({ context: teamContext(), projects: [project('p1')], members: [member('m1')] });
    await h.poller.pollOnce(); // baseline: team with 1 project + 1 member
    h.context = personalContext();
    await h.poller.pollOnce();
    // The team list + roster clear, and the context itself changed.
    expect(h.types().sort()).toEqual(
      ['members-changed', 'team-projects-changed', 'workspace-context-changed'].sort(),
    );
  });

  it('keeps the last baseline on a transient read failure (no spurious emit)', async () => {
    const h = harness({ projects: [project('p1')] });
    await h.poller.pollOnce(); // baseline
    h.projects = null; // read fails this cycle
    await h.poller.pollOnce();
    expect(h.types()).toEqual([]);
    // Recovery with the SAME list must not emit either — baseline was preserved.
    h.projects = [project('p1')];
    await h.poller.pollOnce();
    expect(h.types()).toEqual([]);
  });

  it('does not turn a transient member-directory failure into members-changed, but accepts a real empty roster', async () => {
    const h = harness({ members: [member('m1')] });
    await h.poller.pollOnce(); // baseline

    h.members = null;
    await h.poller.pollOnce();
    expect(h.types()).toEqual([]);

    // Recovery with the same roster proves the failed cycle did not replace
    // the baseline with a synthetic empty signature.
    h.members = [member('m1')];
    await h.poller.pollOnce();
    expect(h.types()).toEqual([]);

    // A successful empty response is authoritative (the final member left),
    // so it must still converge and notify clients.
    h.members = [];
    await h.poller.pollOnce();
    expect(h.types()).toEqual(['members-changed']);
  });

  it('uses the realtime poll floor only while healthy and resumes immediately on disconnect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onPollSuppressed = vi.fn();
    const h = harness({
      pollIntervalMs: 10,
      realtimePollFloorMs: 100,
      onPollSuppressed,
    });

    try {
      h.poller.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.contextCalls).toBe(1);

      h.poller.setRealtimeHealthy(true);
      await vi.advanceTimersByTimeAsync(99);
      expect(h.contextCalls).toBe(1);
      expect(onPollSuppressed).toHaveBeenCalledTimes(9);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.contextCalls).toBe(2);

      h.poller.setRealtimeHealthy(false);
      await vi.runAllTicks();
      expect(h.contextCalls).toBe(3);
    } finally {
      h.poller.stop();
      vi.useRealTimers();
    }
  });

});
