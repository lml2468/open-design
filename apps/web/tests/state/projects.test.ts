import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlugin,
  cacheTabsLocally,
  createConversation,
  createDesignSystemProjectFromProject,
  createProject,
  ProjectCreateError,
  createPluginShareProject,
  deleteProject,
  duplicatePluginAsProject,
  duplicateProject,
  getProject,
  getProjectDetail,
  importClaudeDesignZip,
  importFolderProject,
  deleteTemplate,
  listTemplates,
  installGeneratedPluginFolder,
  installPluginSource,
  listPlugins,
  listPluginsFresh,
  listMessages,
  invalidatePluginCatalogCache,
  listProjects,
  loadTabs,
  patchProject,
  pickLocalFolderPath,
  startGeneratedPluginShareTask,
  uploadPluginFolder,
  waitGeneratedPluginShareTask,
} from '../../src/state/projects';
import {
  designBrowserHistoryStorageKey,
  designBrowserViewportStorageKey,
} from '../../src/components/design-browser-storage';

describe('listMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a failed read instead of reporting an authoritative empty transcript', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      error: {
        code: 'WORKSPACE_CONTEXT_REQUIRED',
        message: 'workspace context is required',
        retryable: true,
      },
    }, { status: 401 })));

    await expect(listMessages('project-1', 'conversation-1')).rejects.toMatchObject({
      name: 'ProjectMessageListError',
      status: 401,
      code: 'WORKSPACE_CONTEXT_REQUIRED',
      retryable: true,
      message: 'workspace context is required',
    });
  });
});

describe('createProject local plugin identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the selected local plugin source in the create payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      project: {
        id: 'project-local-plugin',
        name: 'Local plugin project',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conversation-1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createProject({
      name: 'Local plugin project',
      skillId: null,
      designSystemId: null,
      pluginId: 'shared-plugin-id',
      pluginSource: 'local:personal:shared-plugin-id',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pluginId: 'shared-plugin-id',
      pluginSource: 'local:personal:shared-plugin-id',
    });
  });

  it('preserves an automatic OD Next task profile without synthesizing plugin fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      project: {
        id: 'project-automatic-strategy',
        name: 'Automatic strategy project',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      conversationId: 'conversation-1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createProject({
      name: 'Automatic strategy project',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
      automaticStrategyTaskProfile: 'prototype',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      automaticStrategyTaskProfile: 'prototype',
      metadata: { kind: 'prototype' },
    });
    expect(body).not.toHaveProperty('pluginId');
    expect(body).not.toHaveProperty('pluginSource');
    expect(body).not.toHaveProperty('appliedPluginSnapshotId');
    expect(body).not.toHaveProperty('pluginInputs');
  });

});

describe('createConversation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a persisted conversation fork request compact', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      conversation: {
        id: 'fork-1',
        projectId: 'project-1',
        title: 'Fork',
        createdAt: 2,
        updatedAt: 2,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createConversation('project-1', 'Fork', {
      seedFromConversationId: 'source-1',
      forkAfterMessageId: 'assistant-1',
      forkFallbackMessage: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        events: [{ kind: 'raw', line: 'large diagnostic payload' }],
      },
    })).resolves.toMatchObject({ id: 'fork-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      seedFromConversationId: 'source-1',
      forkAfterMessageId: 'assistant-1',
    });
    expect(body.seedMessages).toBeUndefined();
    expect(body.forkFallbackMessage).toBeUndefined();
  });

  it('retries an unpersisted fork point with one compact fallback message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (fetchMock.mock.calls.length === 1) {
        expect(body.seedMessages).toBeUndefined();
        expect(body.forkFallbackMessage).toBeUndefined();
        return Response.json({ error: 'fork message not found' }, { status: 404 });
      }
      return Response.json({
        conversation: {
          id: 'fork-recovered',
          projectId: 'project-1',
          title: 'Fork',
          createdAt: 2,
          updatedAt: 2,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createConversation('project-1', 'Fork', {
      seedFromConversationId: 'source-1',
      forkAfterMessageId: 'assistant-missing',
      forkFallbackPredecessorMessageId: 'user-before-missing',
      forkFallbackMessage: {
        id: 'assistant-missing',
        role: 'assistant',
        content: 'Partial answer',
        runId: 'failed-run',
        runStatus: 'failed',
        events: [{ kind: 'raw', line: 'large diagnostic payload' }],
        producedFiles: [],
      },
    })).resolves.toMatchObject({ id: 'fork-recovered' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      seedMessages?: unknown;
      forkFallbackMessage?: Record<string, unknown>;
      forkFallbackPredecessorMessageId?: string;
    };
    expect(retryBody.seedMessages).toBeUndefined();
    expect(retryBody.forkFallbackMessage).toEqual({
      id: 'assistant-missing',
      role: 'assistant',
      content: 'Partial answer',
    });
    expect(retryBody.forkFallbackPredecessorMessageId).toBe('user-before-missing');
  });

  it('surfaces the daemon error for an interactive conversation write', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      error: {
        code: 'FORBIDDEN',
        message: 'project mutation is not allowed',
      },
    }, { status: 403 })));

    await expect(createConversation('project-1', 'Fork', {
      seedFromConversationId: 'source-1',
      forkAfterMessageId: 'assistant-1',
      throwOnError: true,
    })).rejects.toMatchObject({
      message: 'project mutation is not allowed',
      status: 403,
    });
  });
});

describe('project detail reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a formerly bound Project without Workspace authority headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      project: {
        id: 'project-bound',
        name: 'Bound project',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
        workspaceId: 'workspace-detail',
      },
      resolvedDir: '/tmp/project-bound',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await getProject('project-bound');
    await getProjectDetail('project-bound', { ensureDir: true });

    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.has('x-od-workspace-id')).toBe(false);
      expect(headers.has('x-od-workspace-member-id')).toBe(false);
    }
  });

  it('preserves headerless reads for an ordinary local project', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      project: {
        id: 'legacy-project',
        name: 'Legacy',
        skillId: null,
        designSystemId: null,
        createdAt: 1,
        updatedAt: 1,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await getProject('legacy-project');
    await getProjectDetail('legacy-project');

    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).has('x-od-workspace-id')).toBe(false);
    }
  });
});

describe('applyPlugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the current locale to the daemon apply endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        query: '生成一份简报。',
        contextItems: [],
        inputs: [],
        assets: [],
        mcpServers: [],
        projectMetadata: {},
        trust: 'trusted',
        capabilitiesGranted: [],
        capabilitiesRequired: [],
        appliedPlugin: {
          snapshotId: 'snap-1',
          pluginId: 'sample-plugin',
          pluginVersion: '1.0.0',
          manifestSourceDigest: 'a'.repeat(64),
          inputs: {},
          resolvedContext: { items: [] },
          capabilitiesGranted: [],
          capabilitiesRequired: [],
          assetsStaged: [],
          taskKind: 'new-generation',
          appliedAt: 0,
          connectorsRequired: [],
          connectorsResolved: [],
          mcpServers: [],
          status: 'fresh',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await applyPlugin('sample-plugin', { locale: 'zh-CN' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      inputs: {},
      grantCaps: [],
      locale: 'zh-CN',
    });
  });

  it('uses the selected local source without Workspace headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await applyPlugin('shared-plugin-id', {
      pluginSource: 'local:personal:shared-plugin-id',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/plugins/shared-plugin-id/apply-local');
    expect(new Headers(init?.headers).has('x-od-workspace-id')).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      source: 'local:personal:shared-plugin-id',
      inputs: {},
      grantCaps: [],
    });
  });

  it('does not let an old daemon substitute an exact selected source', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/apply-local')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyPlugin('bundled-plugin', {
      pluginSource: 'bundled:bundled-plugin',
    })).resolves.toBeNull();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/plugins/bundled-plugin/apply-local',
    ]);
  });

  it('does not fall back when the new local resolver rejects a source', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'plugin not found' }),
      { status: 404, headers: { 'x-od-plugin-apply-local': '1' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyPlugin('shared-plugin-id', {
      pluginSource: 'local:personal:shared-plugin-id',
    })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies an installed plugin without Workspace authority headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await applyPlugin('shared-plugin-id');

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('x-od-workspace-id')).toBe(false);
    expect(headers.has('x-od-workspace-member-id')).toBe(false);
  });
});

describe('listProjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the default fail-soft behavior for background app startup', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects()).resolves.toEqual([]);
  });

  it('can reject transport failures for refresh paths that must preserve current state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects({ throwOnError: true })).rejects.toThrow('projects 503');
  });

  it('coalesces a burst of identical reads into a single request', async () => {
    // Several separately-mounted surfaces can request the local catalog on the
    // same render pass. Identical in-flight reads must share one request.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ projects: [{ id: 'p1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([listProjects(), listProjects(), listProjects()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual([{ id: 'p1' }]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('uses one local catalog for concurrent strict reads', async () => {
    const projects = [{ id: 'p1', name: 'Local project' }];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [fromA, fromB] = await Promise.all([
      listProjects({ throwOnError: true }),
      listProjects({ throwOnError: true }),
    ]);

    expect(fromA).toEqual(projects);
    expect(fromB).toBe(fromA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects');
  });
});

describe('createProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon validation messages from non-2xx create responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: {
          message: 'draft design systems cannot be used by projects',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({
      name: 'Draft DS project',
      skillId: null,
      designSystemId: 'user:draft-system',
    })).rejects.toThrow('draft design systems cannot be used by projects');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('creates a local Project without Workspace authority or identity payloads', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        project: { id: 'scoped-project' },
        conversationId: 'scoped-conversation',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      name: 'Scoped project',
      skillId: null,
      designSystemId: null,
    };
    await createProject(input);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toMatchObject(input);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('workspaceContext');
  });

  it('uses a caller-minted project id for an optimistic route handoff', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        project: { id: body.id },
        conversationId: 'optimistic-conversation',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const created = await createProject({
      id: 'optimistic-project',
      name: 'Optimistic project',
      skillId: null,
      designSystemId: null,
    });

    expect(created.project.id).toBe('optimistic-project');
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { id: string };
    expect(body.id).toBe('optimistic-project');
  });

  it('does not replay a local Project create when the daemon returns a retryable error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'local project storage is temporarily unavailable',
          retryable: true,
        },
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({
      name: 'Retry me',
      skillId: null,
      designSystemId: null,
    })).rejects.toMatchObject({
      status: 503,
      retryable: true,
      message: 'local project storage is temporarily unavailable',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 503 that is not marked retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'nope' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({
      name: 'x',
      skillId: null,
      designSystemId: null,
    })).rejects.toThrow('nope');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the structured agent auth error for the caller instead of reducing it to text', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: {
          code: 'AGENT_AUTH_REQUIRED',
          message: 'Sign in again to continue.',
          retryable: false,
          requestId: 'req-expired-1',
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await createProject({
      name: 'Auth expired',
      skillId: null,
      designSystemId: null,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProjectCreateError);
    expect(failure).toMatchObject({
      status: 401,
      code: 'AGENT_AUTH_REQUIRED',
      retryable: false,
      requestId: 'req-expired-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies the web proxy connection-refused 502 as a daemon transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      'connect ECONNREFUSED 127.0.0.1:17660',
      { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )));

    await expect(createProject({
      name: 'Daemon offline',
      skillId: null,
      designSystemId: null,
    })).rejects.toMatchObject({
      status: null,
      code: null,
    });
  });

  it('does not misclassify an ordinary business 502 as a daemon transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { message: 'billing gateway rejected the request' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )));

    await expect(createProject({
      name: 'Business failure',
      skillId: null,
      designSystemId: null,
    })).rejects.toMatchObject({
      status: 502,
      message: 'billing gateway rejected the request',
    });
  });

});

describe('deleteProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes through the local Project endpoint without Workspace headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('local-only-project');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toEqual({ method: 'DELETE' });
  });

  it('reports failure when the daemon refuses the delete', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })));

    await expect(deleteProject('someone-elses-project')).rejects.toMatchObject({
      name: 'ProjectDeleteError',
      status: 403,
    });
  });

  it('preserves the daemon error code for analytics drill-down', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'local project storage is temporarily unavailable',
        retryable: true,
      },
    }), { status: 503 })));

    await expect(deleteProject('project-1')).rejects.toMatchObject({
      name: 'ProjectDeleteError',
      status: 503,
      code: 'INTERNAL_ERROR',
      message: 'local project storage is temporarily unavailable',
    });
  });

  it('treats a structured missing-project response as an idempotent success', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'not found',
      },
    }), { status: 404 })));

    await expect(deleteProject('already-deleted')).resolves.toBe(true);
  });

  it('does not hide an unstructured 404 from an incompatible daemon', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })));

    await expect(deleteProject('project-1')).rejects.toMatchObject({
      name: 'ProjectDeleteError',
      status: 404,
    });
  });
});

describe('duplicateProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('duplicates through the local Project endpoint with only JSON headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ project: { id: 'dup-1' }, conversationId: 'conv-1', copiedFiles: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await duplicateProject('local-only-project');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('patchProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('patches through the local Project endpoint with only JSON headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'local-only-project', name: 'Renamed' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await patchProject('local-only-project', { name: 'Renamed' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reports failure when the daemon refuses the patch', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })));

    await expect(
      patchProject('someone-elses-project', { name: 'Renamed' }),
    ).resolves.toBeNull();
  });
});

describe('createDesignSystemProjectFromProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the derived Project with only JSON headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          project: { id: 'ds-1' },
          conversationId: 'conv-1',
          designSystemId: 'ds-sys-1',
          copiedFiles: [],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDesignSystemProjectFromProject('local-project');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/local-project/design-system-copy',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

describe('listPlugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides plugins marked od.hidden from UI-facing lists', async () => {
    const visible = {
      id: 'od-new-generation',
      title: 'New generation',
      manifest: { od: { kind: 'scenario' } },
    };
    const hidden = {
      id: 'od-default',
      title: 'Default design router',
      manifest: { od: { kind: 'scenario', hidden: true } },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ plugins: [hidden, visible] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const rows = await listPlugins();

    expect(rows.map((row) => row.id)).toEqual(['od-new-generation']);
  });

  it('can include hidden plugins for installed-entry matching', async () => {
    const visible = {
      id: 'od-new-generation',
      title: 'New generation',
      manifest: { od: { kind: 'scenario' } },
    };
    const hidden = {
      id: 'od-default',
      title: 'Default design router',
      manifest: { od: { kind: 'scenario', hidden: true } },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ plugins: [hidden, visible] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const rows = await listPlugins({ includeHidden: true });

    expect(rows.map((row) => row.id)).toEqual(['od-default', 'od-new-generation']);
  });

  it('keeps the daemon-local catalog request headerless', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ plugins: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await listPluginsFresh();

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins');
  });

  it('reuses one warm daemon-local catalog until it is invalidated', async () => {
    let fetchSequence = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      fetchSequence += 1;
      return new Response(JSON.stringify({
        plugins: [{ id: `fetch-${fetchSequence}`, manifest: {} }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await listPluginsFresh();
    expect(await listPluginsFresh()).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidatePluginCatalogCache();
    const refreshed = await listPluginsFresh();
    expect(refreshed).not.toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated in-flight plugin read overwrite the fresh cache', async () => {
    let resolveStale!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => { resolveStale = resolve; });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce(Response.json({
        plugins: [{ id: 'fresh', manifest: {} }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const oldRead = listPlugins();
    invalidatePluginCatalogCache();
    const fresh = await listPluginsFresh();
    resolveStale(Response.json({ plugins: [{ id: 'stale', manifest: {} }] }));
    await oldRead;

    expect(await listPluginsFresh()).toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest-started plugin read cached when responses finish in reverse order', async () => {
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const newerResponse = new Promise<Response>((resolve) => { resolveNewer = resolve; });
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(olderResponse)
      .mockReturnValueOnce(newerResponse);
    vi.stubGlobal('fetch', fetchMock);
    const olderRead = listPlugins();
    const newerRead = listPlugins();
    resolveNewer(Response.json({ plugins: [{ id: 'newer-snapshot', manifest: {} }] }));
    const newerRows = await newerRead;
    resolveOlder(Response.json({ plugins: [{ id: 'older-snapshot', manifest: {} }] }));
    await olderRead;

    expect(await listPluginsFresh()).toEqual(newerRows);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('installGeneratedPluginFolder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs a project-relative generated plugin folder', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        plugin: { id: 'generated-plugin', title: 'Generated Plugin' },
        warnings: [],
        message: 'Installed Generated Plugin.',
        log: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await installGeneratedPluginFolder(
      'project-1',
      'generated-plugin',
    );

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/plugins/install-folder',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'generated-plugin' }),
      }),
    );
    expect(dispatchEvent).toHaveBeenCalled();
  });

  it('evicts the daemon-local plugin catalog even when no listener is mounted', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    let installed = false;
    let pluginReads = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/plugins/install-folder')) {
        installed = true;
        return Response.json({
          ok: true,
          plugin: { id: 'generated-plugin', title: 'Generated Plugin' },
          warnings: [],
          message: 'Installed Generated Plugin.',
          log: [],
        });
      }
      pluginReads += 1;
      return Response.json({
        plugins: [{
          id: installed ? 'after-install' : 'before-install',
          manifest: {},
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await listPluginsFresh())[0]?.id).toBe('before-install');
    expect((await listPluginsFresh())[0]?.id).toBe('before-install');

    const outcome = await installGeneratedPluginFolder(
      'project-1',
      'generated-plugin',
    );

    expect(outcome.ok).toBe(true);
    expect((await listPluginsFresh())[0]?.id).toBe('after-install');
    expect(pluginReads).toBe(2);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('preserves install diagnostics from non-2xx project folder responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: false,
        warnings: ['Missing open-design.json'],
        message: 'Plugin validation failed.',
        log: ['Validating generated-plugin'],
      }),
      { status: 400, headers: { 'content-type': 'application/json' }, statusText: 'Bad Request' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await installGeneratedPluginFolder('project-1', 'generated-plugin');

    expect(outcome).toMatchObject({
      ok: false,
      warnings: ['Missing open-design.json'],
      message: 'Plugin validation failed.',
      log: ['Validating generated-plugin'],
    });
  });
});

describe('installPluginSource diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops a syntactically valid but unknown SSE error code', async () => {
    const event = JSON.stringify({
      kind: 'error',
      code: 'UPSTREAM_abc123',
      message: 'Unknown upstream failure',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${event}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    await expect(installPluginSource('github:owner/repo')).resolves.toEqual({
      ok: false,
      warnings: [],
      message: 'Unknown upstream failure',
      log: ['Unknown upstream failure'],
    });
  });
});

describe('importClaudeDesignZip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon import errors from non-2xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'Unable to unpack Claude export.' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['zip-bytes'], 'claude-design.zip', {
      type: 'application/zip',
    });

    await expect(importClaudeDesignZip(file)).rejects.toThrow(
      'Unable to unpack Claude export.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/import/claude-design',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    );
  });

  it('imports a ZIP without Workspace authority headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        project: { id: 'claude-project', name: 'Claude import' },
        conversationId: 'claude-conversation',
        entryFile: 'index.html',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await importClaudeDesignZip(
      new File(['zip-bytes'], 'claude-design.zip', { type: 'application/zip' }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
  });
});

describe('generated plugin share tasks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts and polls a generated plugin share task', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          taskId: 'task-1',
          action: 'publish-github',
          path: 'generated-plugin',
          status: 'running',
          startedAt: 10,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          taskId: 'task-1',
          action: 'publish-github',
          path: 'generated-plugin',
          status: 'done',
          startedAt: 10,
          endedAt: 20,
          progress: [],
          nextSince: 1,
          result: { message: 'Published' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchMock);
    const task = await startGeneratedPluginShareTask(
      'project-1',
      'generated-plugin',
      'publish-github',
    );
    await waitGeneratedPluginShareTask(task.taskId, 0, 25_000);

    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('content-type')).toBe('application/json');
    }
  });
});

describe('createPluginShareProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an agent-backed share project for an installed plugin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        project: {
          id: 'project-1',
          name: 'Publish to GitHub: Sample Plugin',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
          pendingPrompt: 'Publish it',
          metadata: { kind: 'prototype' },
        },
        conversationId: 'conversation-1',
        appliedPluginSnapshotId: 'snapshot-1',
        actionPluginId: 'od-plugin-publish-github',
        sourcePluginId: 'sample-plugin',
        stagedPath: 'plugin-source/sample-plugin',
        prompt: 'Publish it',
        message: 'Created a Publish to GitHub task.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createPluginShareProject(
      'sample-plugin',
      'publish-github',
      'zh-CN',
    );

    expect(outcome).toMatchObject({
      ok: true,
      project: { id: 'project-1' },
      appliedPluginSnapshotId: 'snapshot-1',
      stagedPath: 'plugin-source/sample-plugin',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/sample-plugin/share-project',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'publish-github', locale: 'zh-CN' }),
      }),
    );
  });

  it('surfaces share project errors from the daemon', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: false,
        code: 'share-action-plugin-missing',
        message: 'Restart the daemon.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createPluginShareProject(
      'sample-plugin',
      'contribute-open-design',
    );

    expect(outcome).toEqual({
      ok: false,
      code: 'share-action-plugin-missing',
      message: 'Restart the daemon.',
    });
  });
});

describe('importFolderProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the project on success', async () => {
    const response = {
      project: { id: 'p-1', name: 'My Folder' },
      conversationId: 'conv-1',
      entryFile: 'index.html',
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const result = await importFolderProject({ baseDir: '/home/user/project' });
    expect(result).toMatchObject({ project: { id: 'p-1' }, entryFile: 'index.html' });
  });

  it('imports a browser folder with only JSON headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        project: { id: 'p-workspace', name: 'Workspace folder' },
        conversationId: 'conv-workspace',
        entryFile: 'index.html',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await importFolderProject({ baseDir: '/home/user/project' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('throws with daemon error message for filesystem root', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'cannot import the filesystem root' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/' }))
      .rejects.toThrow('cannot import the filesystem root');
  });

  it('throws with daemon error message for non-existent folder', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'folder not found' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/abc/xyz/notexist' }))
      .rejects.toThrow('folder not found');
  });

  it('throws with daemon error message for file path', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'path must be a directory' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/etc/hosts' }))
      .rejects.toThrow('path must be a directory');
  });

  it('throws a fallback message when response body has no error detail', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      'Internal Server Error',
      { status: 500 },
    )));

    await expect(importFolderProject({ baseDir: '/some/path' }))
      .rejects.toThrow('Failed to import folder');
  });
});

describe('duplicatePluginAsProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('duplicates from the daemon-local plugin without Workspace authority', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        projectId: 'plugin-project',
        conversationId: 'plugin-conversation',
        relPath: 'index.html',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await duplicatePluginAsProject(
      'plugin-a',
      { name: 'Plugin A' },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('x-od-workspace-id')).toBe(false);
    expect(headers.has('x-od-workspace-member-id')).toBe(false);
  });
});

describe('pickLocalFolderPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the selected native folder path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: '/Users/me/Site' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pickLocalFolderPath()).resolves.toBe('/Users/me/Site');
    expect(fetchMock).toHaveBeenCalledWith('/api/dialog/open-folder', {
      method: 'POST',
    });
  });

  it('returns null when the native picker is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).resolves.toBeNull();
  });

  it('throws with the daemon picker error message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'cross-origin request rejected' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).rejects.toThrow('cross-origin request rejected');
  });
});

describe('project list cache invalidation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates the unscoped project list after a successful patch', async () => {
    let listReads = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'PATCH') {
        return Response.json({ project: { id: 'p1', name: 'After rename' } });
      }
      listReads += 1;
      return Response.json({
        projects: [{ id: 'p1', name: listReads === 1 ? 'Before rename' : 'After rename' }],
      });
    }));

    await expect(listProjects()).resolves.toMatchObject([{ name: 'Before rename' }]);
    await expect(patchProject('p1', { name: 'After rename' }))
      .resolves.toMatchObject({ id: 'p1', name: 'After rename' });
    await expect(listProjects()).resolves.toMatchObject([{ name: 'After rename' }]);
    expect(listReads).toBe(2);
  });
});

describe('plugin upload diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a bounded daemon error code on folder upload failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      ok: false,
      warnings: [],
      message: 'Plugin manifest is missing at /Users/example/private-plugin',
      errorCode: 'INVALID_MANIFEST',
      log: [],
    }, { status: 400 })));

    await expect(uploadPluginFolder([
      new File(['readme'], 'README.md', { type: 'text/markdown' }),
    ])).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_MANIFEST',
    });
  });
});

describe('deleteProject local caches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tabsKey = 'open-design:project-tabs:v1:p1';
  const historyKey = designBrowserHistoryStorageKey('p1');
  const viewportKey = designBrowserViewportStorageKey('p1');

  function stubWindowStore(): Map<string, string> {
    const store = new Map<string, string>([
      [tabsKey, JSON.stringify({ tabs: [], active: null })],
      [historyKey, JSON.stringify([{ url: 'https://example.com', title: 'Example', lastVisitedAt: 1 }])],
      [viewportKey, 'mobile'],
    ]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
    return store;
  }

  it('prunes tabs and Design Browser caches on a successful delete', async () => {
    const store = stubWindowStore();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })));
    await expect(deleteProject('p1')).resolves.toBe(true);
    expect(store.has(tabsKey)).toBe(false);
    expect(store.has(historyKey)).toBe(false);
    expect(store.has(viewportKey)).toBe(false);
  });

  it('keeps tabs and Design Browser caches when the delete fails', async () => {
    const store = stubWindowStore();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })));
    await expect(deleteProject('p1')).rejects.toMatchObject({
      name: 'ProjectDeleteError',
      status: 500,
    });
    expect(store.has(tabsKey)).toBe(true);
    expect(store.has(historyKey)).toBe(true);
    expect(store.has(viewportKey)).toBe(true);
  });
});

describe('project tabs cache reconciliation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not reconcile a newer local cache when reconciliation is disabled', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
    cacheTabsLocally(
      'project-read-only-tabs',
      { tabs: ['local.html'], active: 'local.html' },
    );
    expect([...store.keys()][0]).toBe('open-design:project-tabs:v1:project-read-only-tabs');
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      return Response.json({
        tabs: ['daemon.html'],
        active: 'daemon.html',
        updatedAt: 1,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await loadTabs(
      'project-read-only-tabs',
      { reconcileNewerCacheToDaemon: false },
    );
    await Promise.resolve();

    expect(loaded.active).toBe('local.html');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
});

describe('listTemplates request coalescing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it('collapses concurrent template-list reads into a single request', async () => {
    // Same launch-burst shape as the design-system catalog: App's one-shot
    // bootstrap and the home-route effect both want the list on the same pass,
    // and both must keep their own read — one settles the entry view, the other
    // exists to pick up a template saved inside a project. On the wire they are
    // one request, and on a cold Home load they land together.
    const gate = deferred<Response>();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      reads += 1;
      return gate.promise;
    }));

    const inFlight = [listTemplates(), listTemplates(), listTemplates()];
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(reads).toBe(1);

    gate.resolve(new Response(
      JSON.stringify({ templates: [{ id: 'tpl-1', name: 'Landing page' }] }),
      { status: 200 },
    ));
    for (const read of inFlight) {
      await expect(read).resolves.toEqual([
        expect.objectContaining({ id: 'tpl-1' }),
      ]);
    }
  });

  it('re-reads the template list for a call issued after the previous settled', async () => {
    // Single-flight only, never a shared settled answer: returning Home re-reads
    // precisely so a template saved inside a project shows up, and the save
    // handler awaits its own refresh. A cached list would hand both of them the
    // list they were fired to replace.
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1;
      return new Response(
        JSON.stringify({ templates: reads > 1 ? [{ id: 'tpl-new', name: 'Saved' }] : [] }),
        { status: 200 },
      );
    }));

    await expect(listTemplates()).resolves.toEqual([]);
    await expect(listTemplates()).resolves.toEqual([
      expect.objectContaining({ id: 'tpl-new' }),
    ]);
    expect(reads).toBe(2);
  });

  it('starts a fresh template read when a mutation lands mid-flight', async () => {
    // Review catch. `ttl = 0` stops settled-result reuse but not in-flight
    // joining, and the post-mutation refresh is exactly the caller that must
    // never join: `handleDeleteTemplate` awaits `deleteTemplate` and then calls
    // `refreshTemplates`. The daemon answers `/api/templates` from a synchronous
    // `listTemplates(db)` snapshot, so a GET issued before the DELETE returns
    // the row that was just deleted — and joining it would leave the deleted
    // template on screen until something else happened to refetch.
    const pending = deferred<Response>();
    const urls: string[] = [];
    let templateRows = [{ id: 'tpl-doomed', name: 'Doomed' }];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      if ((init?.method ?? 'GET') === 'DELETE') {
        templateRows = [];
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // The first GET is issued before the delete and answers the pre-delete
      // snapshot; it stays pending across the mutation.
      if (urls.filter((u) => u.startsWith('GET')).length === 1) return pending.promise;
      return Promise.resolve(new Response(
        JSON.stringify({ templates: templateRows }),
        { status: 200 },
      ));
    }));

    const inFlightBeforeMutation = listTemplates();
    await expect(deleteTemplate('tpl-doomed')).resolves.toBe(true);

    const afterMutation = listTemplates();
    // Release the pre-delete GET. If the refresh joined it, it now resolves to
    // the stale row instead of issuing its own read.
    pending.resolve(new Response(
      JSON.stringify({ templates: [{ id: 'tpl-doomed', name: 'Doomed' }] }),
      { status: 200 },
    ));

    await expect(afterMutation).resolves.toEqual([]);
    await expect(inFlightBeforeMutation).resolves.toEqual([
      expect.objectContaining({ id: 'tpl-doomed' }),
    ]);
  });

  it('lets the next caller retry instead of joining a failed read', async () => {
    // Failures are never cached: a transient 500 must not leave the entry view
    // with an empty template list until something else happens to refetch.
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ templates: [{ id: 'tpl-2', name: 'Deck' }] }), { status: 200 });
    }));

    await expect(listTemplates()).resolves.toEqual([]);
    await expect(listTemplates()).resolves.toEqual([
      expect.objectContaining({ id: 'tpl-2' }),
    ]);
    expect(reads).toBe(2);
  });
});
