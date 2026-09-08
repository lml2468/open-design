import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall } from '../src/mcp.js';
import { _resetMcpWorkspaceContextCacheForTests } from '../src/mcp-workspace-context.js';

const originalFetch = globalThis.fetch;
const BASE = 'http://127.0.0.1:19001';

const DIRECTORY = {
  items: [
    {
      workspaceId: 'ws-personal',
      workspaceName: 'Personal',
      workspaceType: 'personal',
      workspaceMemberId: 'mem-1',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
    },
  ],
  activeWorkspaceId: null,
};

function directoryResponse(): Response {
  return new Response(JSON.stringify(DIRECTORY), { status: 200 });
}

function firstJson<T>(result: { content: Array<{ text: string }> }): T {
  const item = result.content[0];
  if (!item) throw new Error('expected MCP text content');
  return JSON.parse(item.text) as T;
}

afterEach(() => {
  _resetMcpWorkspaceContextCacheForTests();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('MCP workspace-scoped project tools (#6569)', () => {
  it('list_projects reads the complete local catalog without resolving a Workspace', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/projects')) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: '22222222-2222-2222-2222-222222222222',
                name: 'Local Demo',
                metadata: { kind: 'prototype' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(BASE, 'list_projects', {});

    expect(calls).toEqual([{ url: `${BASE}/api/projects`, init: undefined }]);
    const body = firstJson<{ projects: Array<{ id: string; name: string }> }>(result);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.name).toBe('Local Demo');
  });

  it('get_project sends workspace headers on the bound-project read', async () => {
    const projectId = '11111111-1111-1111-1111-111111111111';
    const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/workspace/directory')) return directoryResponse();
      if (url.endsWith('/api/mcp/install-info')) {
        return new Response(JSON.stringify({ webBaseUrl: null }), { status: 200 });
      }
      if (url.includes(`/api/projects/${projectId}/conversations`)) {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url.includes(`/api/projects/${projectId}`)) {
        return new Response(
          JSON.stringify({
            project: { id: projectId, name: 'Demo', metadata: { entryFile: 'index.html' } },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleMcpToolCall(BASE, 'get_project', { project: projectId });

    const projectCall = seen.find((c) => c.url.includes(`/api/projects/${projectId}`) && !c.url.includes('conversations'));
    expect(projectCall).toBeTruthy();
    expect((projectCall?.init?.headers as Record<string, string>)['x-od-workspace-id']).toBe('ws-personal');
    expect((projectCall?.init?.headers as Record<string, string>)['x-od-workspace-member-id']).toBe('mem-1');
  });

  it('write_file sends workspace headers on the project-file write', async () => {
    const projectId = '11111111-1111-1111-1111-111111111111';
    const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/workspace/directory')) return directoryResponse();
      if (url.includes(`/api/projects/${projectId}/files`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleMcpToolCall(BASE, 'write_file', {
      project: projectId,
      path: 'index.html',
      content: '<h1>hi</h1>',
    });

    const writeCall = seen.find((c) => c.url.includes(`/api/projects/${projectId}/files`) && c.init?.method === 'POST');
    expect(writeCall).toBeTruthy();
    expect((writeCall?.init?.headers as Record<string, string>)['x-od-workspace-id']).toBe('ws-personal');
  });

  it('create_project sends workspace headers and falls back headerless on workspace denial', async () => {
    let createCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/workspace/directory')) return directoryResponse();
      if (url.endsWith('/api/projects') && init?.method === 'POST') {
        createCalls += 1;
        if (createCalls === 1) {
          // Workspace-bound create rejected (stale membership).
          return new Response(
            JSON.stringify({ error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED', message: 'denied' } }),
            { status: 403 },
          );
        }
        return new Response(JSON.stringify({ id: 'new-project', name: 'New' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(BASE, 'create_project', { name: 'New' });

    expect(createCalls).toBe(2);
    expect(firstJson<{ id: string }>(result).id).toBe('new-project');
  });

  it('name resolution uses the local catalog while the project read stays scoped', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/workspace/directory')) return directoryResponse();
      if (url.endsWith('/api/projects')) {
        return new Response(
          JSON.stringify({
            projects: [
              { id: '33333333-3333-3333-3333-333333333333', name: 'Local Demo' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/mcp/install-info')) {
        return new Response(JSON.stringify({ webBaseUrl: null }), { status: 200 });
      }
      if (url.includes('/api/projects/33333333-3333-3333-3333-333333333333')) {
        return new Response(
          JSON.stringify({
            project: { id: '33333333-3333-3333-3333-333333333333', name: 'Bound Demo' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(BASE, 'get_project', { project: 'Local Demo' });

    const catalogCall = seen.find((c) => c.url.endsWith('/api/projects'));
    expect(catalogCall).toBeTruthy();
    expect(catalogCall?.init).toBeUndefined();
    const body = firstJson<{ id: string }>(result);
    expect(body.id).toBe('33333333-3333-3333-3333-333333333333');
  });
});

describe('MCP local project catalog', () => {
  it('list_projects never depends on Workspace directory availability', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/workspace/directory')) {
        return new Response(JSON.stringify({ items: [], activeWorkspaceId: null }), { status: 200 });
      }
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [{ id: 'u1', name: 'Unbound' }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(BASE, 'list_projects', {});

    const catalog = seen.find((c) => c.url.endsWith('/api/projects'));
    expect(seen).toHaveLength(1);
    expect(catalog).toBeTruthy();
    expect(catalog?.init).toBeUndefined();
    const body = firstJson<{ projects: Array<{ name: string }> }>(result);
    expect(body.projects[0]?.name).toBe('Unbound');
  });
});
