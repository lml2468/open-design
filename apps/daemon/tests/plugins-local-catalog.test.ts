import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  ensureWorkspaceResource,
  openDatabase,
} from '../src/db.js';
import {
  listInstalledPlugins,
  upsertInstalledPlugin,
} from '../src/plugins/registry.js';
import type { InstalledPluginRecord } from '@open-design/contracts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-plugins-local-catalog-'));
});

afterEach(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

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
    source: `/tmp/${id}`,
    trust: 'trusted',
    capabilitiesGranted: [],
    manifest: { name: id, title: id, version: '1.0.0' } as InstalledPluginRecord['manifest'],
    fsPath: `/tmp/${id}`,
    installedAt: now,
    updatedAt: now,
  };
}

describe('listInstalledPlugins local catalog', () => {
  it('returns installed plugins regardless of historical Workspace bindings', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    for (const plugin of [
      fakePlugin('plugin-unbound'),
      fakePlugin('plugin-personal'),
      fakePlugin('plugin-team'),
      fakePlugin('plugin-tombstoned'),
      fakePlugin('plugin-bundled', 'bundled'),
    ]) {
      upsertInstalledPlugin(db, plugin);
    }
    ensureWorkspaceResource(db, 'plugin', 'legacy-workspace', 'plugin-personal', {
      visibility: 'personal',
      createdByWorkspaceMemberId: 'legacy-owner',
    });
    ensureWorkspaceResource(db, 'plugin', 'legacy-workspace', 'plugin-team', {
      visibility: 'team',
      createdByWorkspaceMemberId: 'legacy-owner',
    });
    ensureWorkspaceResource(db, 'plugin', 'legacy-workspace', 'plugin-tombstoned', {
      visibility: 'personal',
      resourceState: 'deleted',
      createdByWorkspaceMemberId: 'legacy-owner',
    });

    expect(listInstalledPlugins(db).map((plugin) => plugin.id).sort()).toEqual([
      'plugin-bundled',
      'plugin-personal',
      'plugin-team',
      'plugin-tombstoned',
      'plugin-unbound',
    ]);
  });
});
