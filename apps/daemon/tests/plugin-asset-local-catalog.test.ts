import express from 'express';
import type http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, ensureWorkspaceResource, openDatabase } from '../src/db.js';
import { upsertInstalledPlugin } from '../src/plugins/registry.js';
import { registerPluginAssetRoutes } from '../src/routes/plugins/assets.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  closeDatabase();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-asset-local-'));
  roots.push(root);
  const pluginDir = path.join(root, 'same-plugin');
  await mkdir(path.join(pluginDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(pluginDir, 'preview.html'),
    '<img src="./assets/content.txt"><p>local-plugin</p>',
  );
  await writeFile(path.join(pluginDir, 'assets', 'content.txt'), 'local-bytes');

  const db = openDatabase(root, { dataDir: root });
  const now = Date.now();
  upsertInstalledPlugin(db, {
    id: 'same-plugin',
    title: 'Same plugin',
    version: '1.0.0',
    sourceKind: 'local',
    source: pluginDir,
    trust: 'trusted',
    capabilitiesGranted: [],
    manifest: {
      name: 'same-plugin',
      title: 'Same plugin',
      version: '1.0.0',
      od: { preview: { entry: 'preview.html' } },
    },
    fsPath: pluginDir,
    installedAt: now,
    updatedAt: now,
  });
  ensureWorkspaceResource(db, 'plugin', 'legacy-workspace', 'same-plugin', {
    visibility: 'personal',
    resourceState: 'deleted',
    createdByWorkspaceMemberId: 'legacy-owner',
  });

  const app = express();
  registerPluginAssetRoutes(app, {
    db,
    pluginAssetCache: {
      get: async () => {
        throw new Error('unused');
      },
    },
    AssetCacheError: class extends Error {
      status = 502;
      constructor(...args: unknown[]) {
        super(String(args[0] ?? 'asset cache error'));
      }
    },
    assetCacheRewriteUrl: (url) => url,
    isCacheableExternalUrl: () => false,
    assembleExample: (template, slides) =>
      template.replace('<!-- SLIDES_HERE -->', slides),
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

describe('Plugin preview and asset local catalog', () => {
  it('serves local plugin bytes without carrying legacy Workspace scope into nested URLs', async () => {
    const baseUrl = await fixture();
    const preview = await fetch(
      `${baseUrl}/api/plugins/same-plugin/preview?workspaceId=legacy-workspace&workspaceMemberId=legacy-owner`,
    );

    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('local-plugin');
    expect(html).toContain('/api/plugins/same-plugin/asset/assets/content.txt');
    expect(html).not.toContain('workspaceId=');

    const asset = await fetch(
      `${baseUrl}/api/plugins/same-plugin/asset/assets/content.txt`,
      {
        headers: {
          'x-od-workspace-id': 'ignored-workspace',
          'x-od-workspace-member-id': 'ignored-member',
        },
      },
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('local-bytes');
  });
});
