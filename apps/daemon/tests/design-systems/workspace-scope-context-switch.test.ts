// Design-system catalog/create are daemon-local operations. Workspace identity
// may be present for neighboring collaboration calls, but it must not filter,
// claim, or deny local design-system resources.

import type http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';

type StartedServer = {
  url: string;
  server: http.Server;
  shutdown?: () => Promise<void> | void;
};

const CONTEXT_WS1 = {
  workspaceMemberId: 'member-switch',
  workspaceId: 'ws-switch-one',
  workspaceType: 'team',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};

const CONTEXT_WS2 = {
  workspaceMemberId: 'member-switch',
  workspaceId: 'ws-switch-two',
  workspaceType: 'personal',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};

function workspaceHeaders(context: typeof CONTEXT_WS1 | typeof CONTEXT_WS2): Record<string, string> {
  return {
    'x-od-workspace-id': context.workspaceId,
    'x-od-workspace-member-id': context.workspaceMemberId,
    'x-od-workspace-type': context.workspaceType,
    'x-od-workspace-role': context.role,
    'x-od-workspace-member-status': context.memberStatus,
    'x-od-workspace-lifecycle-state': context.lifecycleState,
  };
}

describe('GET/POST /api/design-systems — daemon-local catalog', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the same local system with or without Workspace headers', async () => {
    const title = `local unbound ${Date.now()}`;
    const createdResponse = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      workspaceId?: string;
    };
    expect(created.workspaceId).toBeUndefined();

    const listedResponse = await fetch(`${baseUrl}/api/design-systems`);
    expect(listedResponse.status).toBe(200);
    const listed = (await listedResponse.json()) as {
      designSystems: Array<{ id: string }>;
    };
    expect(listed.designSystems.some((item) => item.id === created.id)).toBe(true);

    const scopedResponse = await fetch(`${baseUrl}/api/design-systems`, {
      headers: workspaceHeaders(CONTEXT_WS1),
    });
    expect(scopedResponse.status).toBe(200);
    const scoped = (await scopedResponse.json()) as {
      designSystems: Array<{ id: string }>;
    };
    expect(scoped.designSystems.some((item) => item.id === created.id)).toBe(true);

    const scopedDetailResponse = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(created.id)}`,
      { headers: workspaceHeaders(CONTEXT_WS1) },
    );
    expect(scopedDetailResponse.status).toBe(200);

    const scopedFilesResponse = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(created.id)}/files`,
      { headers: workspaceHeaders(CONTEXT_WS1) },
    );
    expect(scopedFilesResponse.status).toBe(200);
  });

  it('ignores a half-specified Workspace identity on catalog reads', async () => {
    const response = await fetch(`${baseUrl}/api/design-systems`, {
      headers: { 'x-od-workspace-id': 'ws-switch-one' },
    });
    expect(response.status).toBe(200);
  });

  it('keeps catalog contents stable across explicit Workspace request headers', async () => {
    const createResp1 = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...workspaceHeaders(CONTEXT_WS1),
      },
      body: JSON.stringify({ title: `ws1 system ${Date.now()}` }),
    });
    expect(createResp1.status).toBe(201);
    const createdInWs1 = (await createResp1.json()) as { id: string; workspaceId?: string };
    expect(createdInWs1.workspaceId).toBeUndefined();

    const workspaceResp = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(createdInWs1.id)}/workspace`,
      {
        method: 'POST',
        headers: workspaceHeaders(CONTEXT_WS1),
      },
    );
    expect(workspaceResp.status).toBe(201);
    const workspaceBody = await workspaceResp.json() as {
      project: { id: string };
    };
    const projectsResp = await fetch(`${baseUrl}/api/projects`);
    expect(projectsResp.status).toBe(200);
    const projectsBody = await projectsResp.json() as {
      projects: Array<{
        id: string;
      }>;
    };
    expect(
      projectsBody.projects.find((project) => project.id === workspaceBody.project.id),
    ).toMatchObject({ id: workspaceBody.project.id });

    const listResp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: workspaceHeaders(CONTEXT_WS1),
    });
    const listBody = (await listResp.json()) as {
      designSystems: Array<{ id: string; workspaceId?: string }>;
    };
    expect(listBody.designSystems.some((d) => d.id === createdInWs1.id)).toBe(true);

    const createResp2 = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...workspaceHeaders(CONTEXT_WS2),
      },
      body: JSON.stringify({ title: `ws2 system ${Date.now()}` }),
    });
    expect(createResp2.status).toBe(201);
    const createdInWs2 = (await createResp2.json()) as { id: string; workspaceId?: string };
    expect(createdInWs2.workspaceId).toBeUndefined();

    const listWs1Resp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: workspaceHeaders(CONTEXT_WS1),
    });
    const listWs1Body = (await listWs1Resp.json()) as { designSystems: Array<{ id: string }> };
    expect(listWs1Body.designSystems.some((d) => d.id === createdInWs1.id)).toBe(true);
    expect(listWs1Body.designSystems.some((d) => d.id === createdInWs2.id)).toBe(true);
  });
});

describe('historical Design System Workspace metadata', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const dataDir = process.env.OD_DATA_DIR!;
    const dsDir = path.join(dataDir, 'design-systems', 'pinned-claim');
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(path.join(dsDir, 'DESIGN.md'), '# Pinned claim\n\nSeeded directly on disk.\n');
    writeFileSync(
      path.join(dsDir, 'metadata.json'),
      `${JSON.stringify({ title: 'Pinned claim', workspaceId: 'ws-stale-pin' }, null, 2)}\n`,
    );

    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('exposes a local system carrying historical Workspace metadata', async () => {
    const resp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: workspaceHeaders(CONTEXT_WS2),
    });
    const body = (await resp.json()) as { designSystems: Array<{ id: string }> };
    expect(body.designSystems.some((d) => d.id === 'user:pinned-claim')).toBe(true);
  });

  it('ignores historical metadata workspaceId fields', async () => {
    const resp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: workspaceHeaders({
        ...CONTEXT_WS1,
        workspaceId: 'ws-stale-pin',
      }),
    });
    const body = (await resp.json()) as { designSystems: Array<{ id: string }> };
    const designSystem = body.designSystems.find((d) => d.id === 'user:pinned-claim');
    expect(designSystem).toBeDefined();
    expect(designSystem).not.toHaveProperty('workspaceId');
  });
});
