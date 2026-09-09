import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { startServer } from '../src/server.js';
import { openDatabase } from '../src/db.js';
import { seedLegacyWorkspaceResource } from './helpers/legacy-workspace-resources.js';
import { upsertInstalledPlugin } from '../src/plugins/registry.js';
import {
  __resetPluginEventBufferForTests,
  recordPluginEvent,
} from '../src/plugins/events.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

function fakePlugin(
  id: string,
  sourceKind: InstalledPluginRecord['sourceKind'] = 'local',
): InstalledPluginRecord {
  const now = Date.now();
  return {
    id,
    title: id,
    version: '1.0.0',
    sourceKind,
    source: `/private/plugins/${id}`,
    trust: sourceKind === 'bundled' ? 'bundled' : 'trusted',
    capabilitiesGranted: [],
    manifest: { name: id, title: id, version: '1.0.0' } as InstalledPluginRecord['manifest'],
    fsPath: `/private/plugins/${id}`,
    installedAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
  const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });

  for (const plugin of [
    fakePlugin('event-bundled', 'bundled'),
    fakePlugin('event-unbound'),
    fakePlugin('event-historically-bound'),
  ]) upsertInstalledPlugin(db, plugin);

  seedLegacyWorkspaceResource(db, {
    resourceType: 'plugin',
    resourceId: 'event-historically-bound',
    workspaceId: 'legacy-workspace',
    visibility: 'team',
    resourceState: 'deleted',
    createdByWorkspaceMemberId: 'legacy-owner',
  });

  __resetPluginEventBufferForTests();
  for (const pluginId of [
    'event-bundled',
    'event-unbound',
    'event-historically-bound',
    'event-not-installed',
    '',
  ]) {
    recordPluginEvent({
      kind: pluginId ? 'plugin.installed' : 'plugin.marketplace-refreshed',
      pluginId,
      details: { source: `/private/source/${pluginId || 'global'}` },
    });
  }
});

afterAll(async () => {
  __resetPluginEventBufferForTests();
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('plugin events use the local catalog', () => {
  it('returns events for every installed plugin and ignores legacy Workspace bindings', async () => {
    const response = await fetch(`${baseUrl}/api/plugins/events/snapshot`, {
      headers: {
        'x-od-workspace-id': 'ignored-workspace',
        'x-od-workspace-member-id': 'ignored-member',
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      events: Array<{ pluginId: string }>;
    };
    expect(body.events.map((event) => event.pluginId).sort()).toEqual([
      'event-bundled',
      'event-historically-bound',
      'event-unbound',
    ]);
  });

  it('summarizes the local installed-plugin event slice', async () => {
    const response = await fetch(`${baseUrl}/api/plugins/events/stats`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stats: {
        total: 3,
        byPluginId: {
          'event-bundled': 1,
          'event-historically-bound': 1,
          'event-unbound': 1,
        },
      },
    });
  });

  it('emits live events only when the plugin remains installed locally', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/plugins/events?since=10000`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    recordPluginEvent({
      kind: 'plugin.upgraded',
      pluginId: 'event-not-installed',
      details: { source: '/private/source/not-installed-live' },
    });
    recordPluginEvent({
      kind: 'plugin.upgraded',
      pluginId: 'event-historically-bound',
      details: { source: '/private/source/installed-live' },
    });

    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for local plugin event')), 2_000);
      }),
    ]);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event-historically-bound');
    expect(text).not.toContain('event-not-installed');
  });
});
