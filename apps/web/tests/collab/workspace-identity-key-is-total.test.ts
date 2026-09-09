// Local Project resources no longer partition reads by Workspace authority.
// The transitional helpers must stay total while every legacy caller converges
// on the single local cache identity.

import { describe, expect, it } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import {
  beginWorkspaceScopedRead,
} from '../../src/collab/useWorkspaceContext';

/** A context missing `permissions` entirely — the shape many fixtures build. */
const partial = { workspaceId: 'ws-1', workspaceMemberId: 'wm-1' } as unknown as
  WorkspaceCollabContext;

const complete = {
  workspaceId: 'ws-1',
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  permissions: { canShareProjects: true, canWriteSyncedFiles: true },
} as unknown as WorkspaceCollabContext;

describe('local workspace identity compatibility', () => {
  // The path that actually broke CI: the guard runs long after the request, so
  // it must tolerate whatever context is current by then.
  it('lets a late commit-time guard compare a partial context without throwing', () => {
    const read = beginWorkspaceScopedRead(complete);
    expect(() => read.isStillCurrent(partial)).not.toThrow();
    expect(read.isStillCurrent(partial)).toBe(true);
    expect(read.isStillCurrent(complete)).toBe(true);

    const fromPartial = beginWorkspaceScopedRead(partial);
    expect(() => fromPartial.isStillCurrent(undefined)).not.toThrow();
    expect(fromPartial.isStillCurrent(partial)).toBe(true);
  });
});
