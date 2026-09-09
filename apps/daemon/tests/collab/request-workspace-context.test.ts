import { describe, expect, it } from 'vitest';
import {
  verifyWorkspaceRequestContext,
  workspaceRequestContextFromRequest,
} from '../../src/collab/request-workspace-context.js';

function fakeReq(headers: Record<string, string> = {}) {
  return {
    get(name: string) {
      return headers[name];
    },
  };
}

describe('workspaceRequestContextFromRequest', () => {
  it('distinguishes absent, partial, and complete identity pairs', () => {
    expect(workspaceRequestContextFromRequest(fakeReq())).toBeNull();
    expect(workspaceRequestContextFromRequest(fakeReq({
      'x-od-workspace-id': 'workspace-a',
    }))).toBe('missing');
    expect(workspaceRequestContextFromRequest(fakeReq({
      'x-od-workspace-id': ' workspace-a ',
      'x-od-workspace-member-id': ' member-a ',
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    }))).toMatchObject({
      workspaceId: 'workspace-a',
      workspaceMemberId: 'member-a',
      workspaceType: 'team',
      workspaceTypeAsserted: 'team',
      role: 'owner',
    });
  });
});

describe('verifyWorkspaceRequestContext', () => {
  it('uses the directory as the authority for role and lifecycle state', async () => {
    const result = await verifyWorkspaceRequestContext({
      req: fakeReq({
        'x-od-workspace-id': 'workspace-a',
        'x-od-workspace-member-id': 'member-a',
        'x-od-workspace-role': 'owner',
        'x-od-workspace-lifecycle-state': 'active',
      }),
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          workspaceType: 'team',
          workspaceMemberId: 'member-a',
          role: 'member',
          memberStatus: 'active',
          lifecycleState: 'billing_past_due',
        }],
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      context: {
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-a',
        role: 'member',
        lifecycleState: 'billing_past_due',
      },
    });
  });

  it('fails closed when the directory is unavailable', async () => {
    const result = await verifyWorkspaceRequestContext({
      req: fakeReq({
        'x-od-workspace-id': 'workspace-a',
        'x-od-workspace-member-id': 'member-a',
      }),
      fetchWorkspaceDirectory: async () => ({
        ok: false,
        items: [],
        reason: 'network',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rejects a member absent from the requested Workspace', async () => {
    const result = await verifyWorkspaceRequestContext({
      req: fakeReq({
        'x-od-workspace-id': 'workspace-a',
        'x-od-workspace-member-id': 'member-a',
      }),
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [],
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'WORKSPACE_ACCESS_DENIED',
    });
  });
});
