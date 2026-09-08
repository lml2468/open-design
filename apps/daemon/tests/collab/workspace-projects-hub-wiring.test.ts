// Coverage for the two seams that trigger `reconcileWorkspaceProjectsWithRemote`
// in server.ts: the hub's real-time `team-projects-changed` SSE push
// (`startHubEventsSubscriber`) and the ~15s `workspaceInvalidationPoller`'s
// own diff-and-signal cadence. Mirrors the existing precedent in
// `hub-workspace-context-changed-poll.test.ts` (same extracted-named-function
// + source-scan-boundary-guard style) for the sibling
// `workspace-context-changed` fix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  handleHubProjectMetadataChanged,
  handleHubTeamProjectsChanged,
  handlePolledWorkspaceInvalidation,
} from '../../src/collab/workspace-projects-reconciler.js';
import { parseHubWorkspaceEvent, startHubEventsSubscriber } from '../../src/collab/hub-events-subscriber.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        return;
      }
      // Never enqueue again — keeps the connection open so the subscriber
      // does not immediately loop into a reconnect after the one event.
      await new Promise(() => undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('handleHubTeamProjectsChanged', () => {
  it('emits the thin display-cache signal only after reconciliation finishes', async () => {
    const emit = vi.fn();
    let finishReconcile!: () => void;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => {
      finishReconcile = resolve;
    }));
    handleHubTeamProjectsChanged(emit, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();

    finishReconcile();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
  });

  it('never lets a reconciliation failure throw or reject out of the hub event handler', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() => handleHubTeamProjectsChanged(emit, reconcile)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  // End-to-end through the REAL SSE parser/dispatcher (`startHubEventsSubscriber`
  // + `parseHubWorkspaceEvent`), not a hand-called function — this is the
  // "real push" half of the verification: a genuine `team-projects-changed`
  // wire frame, parsed by real code, must reach the reconciler.
  it('fires from a genuine team-projects-changed SSE frame parsed by the real hub subscriber', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const readyFrame = 'event: ready\ndata: {"workspaceId":"w1"}\n\n';
    const frame =
      'event: workspace-event\ndata: {"type":"team-projects-changed","workspaceId":"w1","at":123}\n\n';
    const subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({
        url: 'https://hub/api/v1/collab/events',
        headers: {},
        workspaceId: 'w1',
      }),
      onEvent: (event) => {
        expect(parseHubWorkspaceEvent(JSON.stringify(event))).toEqual(event);
        if (event.type === 'team-projects-changed') {
          handleHubTeamProjectsChanged(emit, reconcile);
          resolveDone();
        }
      },
      fetchImpl: async () => sseResponse([readyFrame, frame]),
    });

    try {
      await done;
      expect(emit).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      subscriber.stop();
    }
  });
});

describe('handleHubProjectMetadataChanged', () => {
  it('re-emits after the targeted metadata write becomes durable', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => true);
    handleHubProjectMetadataChanged(emit, reconcile);

    expect(emit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
  });

  it('does not emit a persistence follow-up for a no-op or failed reconcile', async () => {
    const noOpEmit = vi.fn();
    handleHubProjectMetadataChanged(noOpEmit, async () => false);
    await Promise.resolve();
    expect(noOpEmit).toHaveBeenCalledTimes(1);

    const failedEmit = vi.fn();
    handleHubProjectMetadataChanged(failedEmit, async () => { throw new Error('offline'); });
    await Promise.resolve();
    await Promise.resolve();
    expect(failedEmit).toHaveBeenCalledTimes(1);
  });
});

describe('handlePolledWorkspaceInvalidation', () => {
  it('forwards every payload to emit unchanged', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    const payload = { type: 'members-changed' as const, at: 1 };
    handlePolledWorkspaceInvalidation(payload, emit, reconcile);
    expect(emit).toHaveBeenCalledWith(payload);
  });

  it('kicks reconciliation only for a team-projects-changed payload', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);

    handlePolledWorkspaceInvalidation({ type: 'workspace-context-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'members-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'workspace-directory-changed', at: 1 }, emit, reconcile);
    expect(reconcile).not.toHaveBeenCalled();

    handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconciliation failure throw out of the poller emit path', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() =>
      handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });
});

// Scope-boundary guard (real source, not a re-implementation) — the sibling of
// `hub-workspace-context-changed-poll.test.ts`'s own switch-boundary test.
// Confirms the wiring actually landed in server.ts: exactly the
// `team-projects-changed` case calls `handleHubTeamProjectsChanged`, and the
// poller's `emit` wiring calls `handlePolledWorkspaceInvalidation`.
describe('server.ts wiring (source boundary)', () => {
  const serverSourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/server.ts',
  );
  const source = fs.readFileSync(serverSourcePath, 'utf8');

  function extractOnEventSwitchBody(): string {
    const anchor = 'onEvent: (event, connection) => {';
    const start = source.indexOf(anchor);
    expect(start, 'expected to find the hub events onEvent handler in server.ts').toBeGreaterThan(-1);
    const switchStart = source.indexOf('switch (event.type) {', start);
    expect(switchStart, 'expected a switch(event.type) right after onEvent').toBeGreaterThan(-1);
    let depth = 0;
    let i = switchStart + 'switch (event.type) {'.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(depth, 'expected the switch braces to balance').toBe(0);
    return source.slice(switchStart, i + 1);
  }

  it('resets directory and exact authority across credential changes before refreshing hub endpoints', () => {
    const resetHelperStart = source.indexOf(
      'const resetWorkspaceIdentityCaches = (): void => {',
    );
    const start = source.indexOf(
      'const refreshWorkspaceHubAccountIdentity = (): void => {',
    );
    const end = source.indexOf(
      'const fetchWorkspaceDirectoryForAccountSurface = () => {',
      start,
    );
    expect(resetHelperStart).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(resetHelperStart);
    expect(end).toBeGreaterThan(start);
    const resetHelperBody = source.slice(resetHelperStart, start);
    expect(resetHelperBody).toContain(
      'workspaceDirectoryAuthority.resetIdentity();',
    );
    expect(resetHelperBody).toContain(
      'workspaceExactAuthorityCache.resetIdentity();',
    );
    expect(resetHelperBody).toContain(
      'workspaceExactContextCache.resetIdentity();',
    );
    const body = source.slice(start, end);
    const resetStart = body.indexOf('resetWorkspaceIdentityCaches();');
    const endpointRefreshStart = body.indexOf(
      'workspaceHubSubscriptions?.refreshEndpoints();',
    );
    expect(resetStart).toBeGreaterThan(-1);
    expect(endpointRefreshStart).toBeGreaterThan(resetStart);
  });

  it('routes both project catalog event families through project reconciliation', () => {
    const switchBody = extractOnEventSwitchBody();
    const cases = switchBody.split(/(?=case '[a-z-]+':)/g).filter((chunk) => chunk.startsWith("case '"));
    expect(cases.length).toBeGreaterThanOrEqual(6);

    const casesCallingReconcile = cases.filter((chunk) => /handleHubTeamProjectsChanged\(/.test(chunk));
    const caseNames = casesCallingReconcile.map((chunk) => chunk.match(/^case '([a-z-]+)':/)?.[1]);
    expect(caseNames).toEqual(['team-projects-changed', 'team-resources-changed']);
  });

  it('routes project resource retractions through project reconciliation instead of the generic resource lane', () => {
    const switchBody = extractOnEventSwitchBody();
    const teamResourcesCase = switchBody
      .split(/(?=case '[a-z-]+':)/g)
      .find((chunk) => chunk.startsWith("case 'team-resources-changed':"));

    expect(teamResourcesCase).toContain("event.resourceKind === 'project'");
    expect(teamResourcesCase).toContain('handleHubTeamProjectsChanged(');
    expect(teamResourcesCase).toContain('reconcileWorkspaceProjectsFromRemote(');
  });

  it('runs targeted metadata reconciliation only from project-metadata-changed', () => {
    const switchBody = extractOnEventSwitchBody();
    const cases = switchBody.split(/(?=case '[a-z-]+':)/g).filter((chunk) => chunk.startsWith("case '"));
    const casesCallingTargetedMetadata = cases.filter((chunk) =>
      /reconcileWorkspaceProjectMetadataFromRemote\(/.test(chunk),
    );
    expect(casesCallingTargetedMetadata.map((chunk) =>
      chunk.match(/^case '([a-z-]+)':/)?.[1],
    )).toEqual(['project-metadata-changed']);
  });

  it('does not drop subscribed Workspace A hub data when Workspace B is ambient', () => {
    const start = source.indexOf(
      'const startWorkspaceHubSubscriber = (subscribedWorkspaceId: string) =>',
    );
    const end = source.indexOf(
      'workspaceHubSubscriptions = createWorkspaceHubSubscriptionManager({',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).not.toContain(
      'subscribedWorkspaceId === activeWorkspace.get()?.trim()',
    );
    expect(body).not.toContain('if (!isAmbientWorkspace');
    expect(body).toContain(
      'event.workspaceId ?? subscribedWorkspaceId',
    );
    expect(body).toMatch(/emitTeamProjectsChanged\(\s*eventWorkspaceId/);
  });

  it('runs reconnect and source-gap recovery for the exact subscribed Workspace', () => {
    const start = source.indexOf(
      'const startWorkspaceHubSubscriber = (subscribedWorkspaceId: string) =>',
    );
    const end = source.indexOf(
      'workspaceHubSubscriptions = createWorkspaceHubSubscriptionManager({',
      start,
    );
    const body = source.slice(start, end);
    const reconnectStart = body.indexOf('onReconnect: (connection) => {');
    const sourceGapStart = body.indexOf('onSourceGap:', reconnectStart);
    const errorStart = body.indexOf('onError:', sourceGapStart);
    expect(reconnectStart).toBeGreaterThan(-1);
    expect(sourceGapStart).toBeGreaterThan(reconnectStart);
    expect(errorStart).toBeGreaterThan(sourceGapStart);

    const reconnectBody = body.slice(reconnectStart, sourceGapStart);
    const sourceGapBody = body.slice(sourceGapStart, errorStart);
    expect(reconnectBody).not.toContain('activeWorkspace.get()');
    expect(sourceGapBody).not.toContain('activeWorkspace.get()');
    expect(reconnectBody).toContain(
      'reconcileWorkspaceProjectsFromRemote(subscribedWorkspaceId)',
    );
    expect(sourceGapBody).toContain(
      'workspaceId ?? subscribedWorkspaceId',
    );
    expect(sourceGapBody).toContain(
      'reconcileWorkspaceProjectsFromRemote(exactWorkspaceId)',
    );
  });

  it('has no ambient active-workspace invalidation poller or hub subscription', () => {
    expect(source).not.toContain(
      'const workspaceInvalidationPoller = createWorkspaceInvalidationPoller({',
    );
    expect(source).not.toContain(
      'workspaceHubSubscriptions.setAmbientWorkspace(',
    );
    expect(source).not.toContain('activeWorkspace.subscribe(');
    expect(source).toContain(
      'const workspaceInvalidationPollerFor = (workspaceIdInput: string) => {',
    );
  });

  it('never lets display cache readers infer scope from workspaceContext current or lastKnown', () => {
    const projectsStart = source.indexOf('const teamProjectsForDisplay = async (');
    const projectsEnd = source.indexOf('const teamProjectsForRequest = async (', projectsStart);
    const projectsBody = source.slice(projectsStart, projectsEnd);
    expect(projectsBody).not.toContain('workspaceContext.current');
    expect(projectsBody).not.toContain('lastKnown');

    const membersStart = source.indexOf('const teamMembersForDisplay = async (');
    const membersEnd = source.indexOf('let workspaceHubSubscriptions:', membersStart);
    const membersBody = source.slice(membersStart, membersEnd);
    expect(membersBody).not.toContain('workspaceContext.current');
    expect(membersBody).not.toContain('lastKnown');
  });

  it('serves repeated collab status owner reads from the explicit display cache while revocation stays fresh', () => {
    const freshOwnerStart = source.indexOf(
      'const resolveSharedProjectOwner = async (',
    );
    const statusOwnerStart = source.indexOf(
      'const resolveSharedProjectOwnerForStatus = async (',
      freshOwnerStart,
    );
    const verificationStart = source.indexOf(
      'const sharedProjectPullProfiling',
      statusOwnerStart,
    );
    expect(freshOwnerStart).toBeGreaterThan(-1);
    expect(statusOwnerStart).toBeGreaterThan(freshOwnerStart);
    expect(verificationStart).toBeGreaterThan(statusOwnerStart);
    const freshOwnerBody = source.slice(freshOwnerStart, statusOwnerStart);
    const statusOwnerBody = source.slice(statusOwnerStart, verificationStart);

    expect(statusOwnerBody).toContain(
      'await teamProjectsDisplayCache(explicitScope)',
    );
    expect(statusOwnerBody).not.toContain(
      'await teamProjectsLister(explicitScope.workspaceId)',
    );
    expect(freshOwnerBody).toContain(
      'await teamProjectsLister(explicitScope.workspaceId)',
    );
    expect(freshOwnerBody).not.toContain('teamProjectsDisplayCache');

    const pullStart = source.indexOf('const resolveSharedProject = async (');
    expect(pullStart).toBeGreaterThan(-1);
    expect(pullStart).toBeLessThan(freshOwnerStart);
    const pullBody = source.slice(pullStart, freshOwnerStart);
    expect(pullBody).toContain(
      'await teamProjectsLister(scope.workspaceId)',
    );
    expect(pullBody).not.toContain('teamProjectsDisplayCache');
  });

});
