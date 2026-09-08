import { describe, expect, it } from 'vitest';
import { createAuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';

describe('local Project request authority', () => {
  it.each([
    { mode: 'read' as const },
    { mode: 'write' as const, capability: 'writeFiles' as const },
    { mode: 'write' as const, capability: 'rename' as const },
    { mode: 'write' as const, capability: 'delete' as const },
    { mode: 'write' as const, capability: 'duplicate' as const },
    { mode: 'write' as const, capability: 'comment' as const },
  ])('allows $mode access without Workspace identity', async (options) => {
    const authorize = createAuthorizeProjectRequest();

    await expect(authorize(
      { query: {}, get: () => undefined },
      {} as never,
      'local-project',
      options,
    )).resolves.toBe(true);
  });

  it('ignores conflicting legacy Workspace headers and navigation scope', async () => {
    const authorize = createAuthorizeProjectRequest();
    const req = {
      query: {
        workspaceId: 'workspace-query',
        workspaceMemberId: 'member-query',
      },
      get(name: string) {
        if (name.toLowerCase() === 'x-od-workspace-id') return 'workspace-header';
        if (name.toLowerCase() === 'x-od-workspace-member-id') return 'member-header';
        return undefined;
      },
    };

    await expect(authorize(
      req,
      {} as never,
      'local-project',
      { mode: 'read', allowNavigationQuery: true },
    )).resolves.toBe(true);
  });
});
