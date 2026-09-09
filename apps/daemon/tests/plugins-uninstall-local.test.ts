import type http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import {
  defaultRegistryRoots,
  resolvePluginFolder,
  upsertInstalledPlugin,
} from '../src/plugins/registry.js';
import { openDatabase } from '../src/db.js';
import { seedLegacyWorkspaceResource } from './helpers/legacy-workspace-resources.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedPluginFolder(pluginId: string): Promise<string> {
  const pluginsRoot = defaultRegistryRoots().userPluginsRoot;
  const folder = path.join(pluginsRoot, pluginId);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'open-design.json'),
    JSON.stringify({ name: pluginId, title: pluginId, version: '1.0.0' }),
  );
  const resolved = await resolvePluginFolder({
    folder,
    folderId: pluginId,
    sourceKind: 'local',
    source: folder,
  });
  if (!resolved.ok) throw new Error(resolved.errors.join('; '));
  const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
  upsertInstalledPlugin(db, resolved.record);
  return folder;
}

describe('POST /api/plugins/:id/uninstall local ownership', () => {
  it('uninstalls an installed plugin regardless of legacy Workspace metadata', async () => {
    const pluginId = `local-uninstall-bound-${Date.now()}`;
    const folder = await seedPluginFolder(pluginId);
    const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
    seedLegacyWorkspaceResource(db, {
      resourceType: 'plugin',
      resourceId: pluginId,
      workspaceId: 'legacy-workspace',
      visibility: 'personal',
      resourceState: 'deleted',
      createdByWorkspaceMemberId: 'legacy-owner',
    });

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/uninstall`, {
      method: 'POST',
      headers: {
        'x-od-workspace-id': 'different-workspace',
        'x-od-workspace-member-id': 'different-member',
      },
    });

    expect(response.status).toBe(200);
    expect(existsSync(folder)).toBe(false);
  });

  it('uninstalls an unbound local plugin without Workspace identity', async () => {
    const pluginId = `local-uninstall-unbound-${Date.now()}`;
    const folder = await seedPluginFolder(pluginId);

    const response = await fetch(`${baseUrl}/api/plugins/${pluginId}/uninstall`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(existsSync(folder)).toBe(false);
  });
});
