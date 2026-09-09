import express from 'express';
import type http from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InstalledPluginRecord,
  Project,
} from '@open-design/contracts';
import { sendApiError } from '../src/http/api-errors.js';
import { closeDatabase } from '../src/db.js';
import { duplicatePluginExampleIntoProject } from '../src/plugins/duplicate-project.js';
import { registerPluginRoutes } from '../src/routes/plugins/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  closeDatabase();
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makePreviewPlugin(root: string, id = 'duplicate-fixture'): Promise<InstalledPluginRecord> {
  const pluginRoot = path.join(root, id);
  await mkdir(path.join(pluginRoot, 'preview'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, 'preview', 'index.html'),
    '<!doctype html><html><body><h1>Duplicable</h1></body></html>',
    'utf8',
  );
  return {
    id,
    title: 'Duplicate Fixture',
    fsPath: pluginRoot,
    manifest: {
      name: id,
      title: 'Duplicate Fixture',
      od: { preview: { entry: 'preview/index.html' } },
    },
  } as InstalledPluginRecord;
}

describe('plugin project duplication', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects duplicates that would skip a required symlinked file',
    async () => {
      const root = await makeTempRoot('od-plugin-duplicate-helper-');
      const projectsRoot = path.join(root, 'projects');
      const plugin = await makePreviewPlugin(root);
      await writeFile(path.join(plugin.fsPath, 'preview', 'target.txt'), 'asset', 'utf8');
      await symlink('target.txt', path.join(plugin.fsPath, 'preview', 'linked.txt'));

      await expect(
        duplicatePluginExampleIntoProject({
          plugin,
          projectsRoot,
          projectId: 'symlink-project',
          metadata: { kind: 'prototype' },
          assembleExample: (templateHtml) => templateHtml,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'DUPLICATE_COPY_INCOMPLETE',
      });
    },
  );

  it('duplicates an installed plugin into a local project', async () => {
    const root = await makeTempRoot('od-plugin-duplicate-authority-');
    const projectsRoot = path.join(root, 'projects');
    const plugin = await makePreviewPlugin(root, 'authority-plugin-fixture');
    const projectId = 'authority-plugin-project';
    const project = {
      id: projectId,
      name: 'Authority Plugin Fixture',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Project;
    const randomId = vi.fn()
      .mockReturnValueOnce(projectId)
      .mockReturnValueOnce('authority-plugin-conversation');
    const app = express();
    app.use(express.json());
    registerPluginRoutes(app, {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
          run: () => undefined,
        }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: {
        PROJECTS_DIR: projectsRoot,
        PLUGIN_REGISTRY_ROOTS: [],
        PLUGIN_LOCKFILE_PATH: path.join(root, 'plugins.lock'),
      },
      ids: { randomId },
      projectStore: {
        insertProject: vi.fn(() => project),
        getProject: vi.fn(() => project),
        dbDeleteProject: vi.fn(),
        removeProjectDir: async (rootDir: string, id: string) => {
          await rm(path.join(rootDir, id), { recursive: true, force: true });
        },
      },
      conversations: { insertConversation: vi.fn() },
      plugins: {
        getInstalledPlugin: vi.fn(() => plugin),
        listInstalledPlugins: vi.fn(() => []),
      },
      helpers: {
        requireLocalDaemonRequest: ((_req, _res, next) => next()) as express.RequestHandler,
        assembleExample: (templateHtml: string) => templateHtml,
        applyBakedPreviews: (records: unknown[]) => records,
        sendApiError,
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);
    const server = await listen(app);
    try {
      const resp = await fetch(
        `${server.url}/api/plugins/${encodeURIComponent(plugin.id)}/duplicate-project`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      );

      expect(resp.status).toBe(201);
      expect(randomId).toHaveBeenCalledTimes(2);
    } finally {
      await close(server.server);
    }
  });

  it('persists the remixed Project and seed conversation in one local transaction', async () => {
    const root = await makeTempRoot('od-plugin-duplicate-workspace-');
    const projectsRoot = path.join(root, 'projects');
    const plugin = await makePreviewPlugin(root, 'workspace-plugin-fixture');
    (plugin.manifest.od as { mode?: string }).mode = 'deck';
    const projectId = 'workspace-plugin-project';
    const project = {
      id: projectId,
      name: 'Workspace Plugin Fixture',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Project;
    const transactionSteps: string[] = [];
    const db = {
      prepare: () => ({
        all: () => [],
        get: () => null,
        run: () => undefined,
      }),
      transaction: (run: () => unknown) => () => {
        transactionSteps.push('transaction:start');
        const result = run();
        transactionSteps.push('transaction:commit');
        return result;
      },
    };
    const insertProjectMock = vi.fn(() => {
      transactionSteps.push('project:insert');
      return project;
    });
    const app = express();
    app.use(express.json());
    registerPluginRoutes(app, {
      db,
      paths: {
        PROJECTS_DIR: projectsRoot,
        PLUGIN_REGISTRY_ROOTS: [],
        PLUGIN_LOCKFILE_PATH: path.join(root, 'plugins.lock'),
      },
      ids: {
        randomId: vi.fn()
          .mockReturnValueOnce(projectId)
          .mockReturnValueOnce('workspace-plugin-conversation'),
      },
      projectStore: {
        insertProject: insertProjectMock,
        getProject: vi.fn(() => project),
        dbDeleteProject: vi.fn(),
        removeProjectDir: async (rootDir: string, id: string) => {
          await rm(path.join(rootDir, id), { recursive: true, force: true });
        },
      },
      conversations: {
        insertConversation: vi.fn(() => {
          transactionSteps.push('conversation:insert');
        }),
      },
      plugins: {
        getInstalledPlugin: vi.fn(() => plugin),
        listInstalledPlugins: vi.fn(() => []),
      },
      helpers: {
        requireLocalDaemonRequest: ((_req, _res, next) => next()) as express.RequestHandler,
        assembleExample: (templateHtml: string) => templateHtml,
        applyBakedPreviews: (records: unknown[]) => records,
        sendApiError,
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);
    const server = await listen(app);
    try {
      const resp = await fetch(
        `${server.url}/api/plugins/${encodeURIComponent(plugin.id)}/duplicate-project`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'Workspace Plugin Fixture' }),
        },
      );
      expect(resp.status).toBe(201);
      expect(insertProjectMock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          metadata: expect.objectContaining({ kind: 'deck' }),
        }),
      );
      expect(transactionSteps).toEqual([
        'transaction:start',
        'project:insert',
        'conversation:insert',
        'transaction:commit',
      ]);
    } finally {
      await close(server.server);
    }
  });

});

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
