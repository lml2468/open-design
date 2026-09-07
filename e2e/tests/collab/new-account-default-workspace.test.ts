// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

const DEFAULT_WORKSPACE = {
  workspaceId: 'ws-new-account-personal',
  workspaceName: 'Ada workspace',
  workspaceType: 'personal' as const,
  workspaceMemberId: 'mem-new-account-personal',
  role: 'owner' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

const DEFAULT_WORKSPACE_HEADERS = {
  'x-od-workspace-id': DEFAULT_WORKSPACE.workspaceId,
  'x-od-workspace-member-id': DEFAULT_WORKSPACE.workspaceMemberId,
};

let authority: Server;
let authorityUrl: string;

beforeAll(async () => {
  authority = createServer((req, res) => {
    if (req.url === '/api/v1/workspaces' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [DEFAULT_WORKSPACE] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve));
  const address = authority.address();
  if (address == null || typeof address === 'string') throw new Error('mock authority has no port');
  authorityUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => authority.close(() => resolve()));
});

describe('new account default workspace bootstrap', () => {
  test(
    'uses nickname workspace as the default personal workspace',
    { timeout: 240_000 },
    async () => {
      const suite = await createSmokeSuite('collab-new-account-default-workspace');

      await suite.with.toolsDev(
        async ({ webUrl }) => {
          const firstContext = await requestJson<{
            context: {
              workspaceId: string;
              workspaceName?: string;
              workspaceType: string;
            } | null;
          }>(webUrl, '/api/workspace/context', {
            headers: DEFAULT_WORKSPACE_HEADERS,
          });

          // Fresh-account path: the explicit caller selects the personal
          // directory item without mutating a process-global active pointer.
          expect(firstContext.context?.workspaceId).toBe(DEFAULT_WORKSPACE.workspaceId);
          expect(firstContext.context?.workspaceName).toBe('Ada workspace');
          expect(firstContext.context?.workspaceType).toBe('personal');

          const directory = await requestJson<{
            activeWorkspaceId: string | null;
            items: Array<typeof DEFAULT_WORKSPACE>;
          }>(webUrl, '/api/workspace/directory');
          expect(directory.activeWorkspaceId).toBeNull();
          expect(directory.items).toEqual([DEFAULT_WORKSPACE]);

          // A second exact read remains on the same directory membership.
          const settledContext = await requestJson<{
            context: {
              workspaceId: string;
              workspaceName?: string;
              workspaceType: string;
            } | null;
          }>(webUrl, '/api/workspace/context', {
            headers: DEFAULT_WORKSPACE_HEADERS,
          });
          expect(settledContext.context).toMatchObject({
            workspaceId: DEFAULT_WORKSPACE.workspaceId,
            workspaceName: 'Ada workspace',
            workspaceType: 'personal',
          });
        },
        {
          env: {
            AMR_HOME: join(suite.scratchDir, 'empty-amr-home'),
            OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
            VELA_API_URL: authorityUrl,
            VELA_CONTROL_KEY: 'e2e-new-account-control-key',
          },
        },
      );
    },
  );
});
