// `listInstalledPlugins`'s workspace-scoped filter (registry.ts): a plugin
// bound into a DIFFERENT workspace than the one asked about is hidden, but an
// UNBOUND plugin (no `workspace_resources` row — every plugin installed
// before workspace isolation shipped looks like this) stays visible from
// every workspace. Mirrors design-systems' `designSystemVisibleFromWorkspace`
// rule (design-systems/index.ts) applied to the generic `workspace_resources`
// table instead of a metadata.json sidecar.
//
// spec 04 §10 addendum: `workspaceId` OMITTED (the argument not passed at
// all) and `workspaceId: null` (passed explicitly, e.g. by `GET /api/plugins`
// when the request carries no `x-od-workspace-id` header) are DIFFERENT
// signals. Omitted means an internal caller (`od plugin list`, inventory
// stats, the bundled-scenario scan) never asked to be scoped — stays
// unfiltered. Explicit `null` means an HTTP caller DID ask to be scoped but
// has no identity to offer, and must now see only UNBOUND plugins, not
// everything — "no scope" must not mean "trust everything"
// (recvqbeDjAsejl / recvqbklNGDqYY).

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
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-plugins-workspace-scope-'));
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

describe('listInstalledPlugins workspace scope', () => {
  it('returns every plugin, unfiltered, when the workspaceId ARGUMENT IS OMITTED (backward compat)', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-unbound'));
    upsertInstalledPlugin(db, fakePlugin('plugin-bound'));
    ensureWorkspaceResource(db, 'plugin', 'ws-1', 'plugin-bound', { createdByWorkspaceMemberId: 'member-a' });

    const all = listInstalledPlugins(db);
    expect(all.map((p) => p.id).sort()).toEqual(['plugin-bound', 'plugin-unbound']);
  });

  it('hides a bound plugin when the caller passes an explicit null workspaceId (spec 04 §10)', () => {
    // `headerValue()` returns `null` (never `undefined`) when a request
    // carries no `x-od-workspace-id` header, so `GET /api/plugins` always
    // passes a DEFINED second argument. That must reach the workspace filter
    // the same as a real workspace id would, not silently take the "omitted"
    // unfiltered path above — otherwise a signed-out / headerless caller
    // could still see every workspace's claimed plugins.
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-unbound'));
    upsertInstalledPlugin(db, fakePlugin('plugin-bound'));
    ensureWorkspaceResource(db, 'plugin', 'ws-1', 'plugin-bound', { createdByWorkspaceMemberId: 'member-a' });

    const scoped = listInstalledPlugins(db, null);
    expect(scoped.map((p) => p.id)).toEqual(['plugin-unbound']);
  });

  it('quarantines an unbound user plugin from every explicit workspace', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-legacy'));

    expect(listInstalledPlugins(db, 'ws-1', 'member-a').map((p) => p.id)).not.toContain('plugin-legacy');
    expect(listInstalledPlugins(db, 'ws-2', 'member-b').map((p) => p.id)).not.toContain('plugin-legacy');
    expect(listInstalledPlugins(db, null, null).map((p) => p.id)).toContain('plugin-legacy');
    expect(listInstalledPlugins(db).map((p) => p.id)).toContain('plugin-legacy');
  });

  it('keeps bundled plugins visible in every explicit workspace', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-bundled', 'bundled'));

    expect(listInstalledPlugins(db, 'ws-1', 'member-a').map((p) => p.id)).toContain('plugin-bundled');
    expect(listInstalledPlugins(db, 'ws-2', 'member-b').map((p) => p.id)).toContain('plugin-bundled');
  });

  it('hides a plugin bound to a different workspace, but shows it from its own', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-claimed'));
    ensureWorkspaceResource(db, 'plugin', 'ws-1', 'plugin-claimed', { createdByWorkspaceMemberId: 'member-a' });

    expect(listInstalledPlugins(db, 'ws-1', 'member-a').map((p) => p.id)).toContain('plugin-claimed');
    expect(listInstalledPlugins(db, 'ws-2', 'member-a').map((p) => p.id)).not.toContain('plugin-claimed');
  });

  it('hides an unshared personal plugin from another member in the same workspace', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-personal'));
    ensureWorkspaceResource(db, 'plugin', 'ws-team', 'plugin-personal', {
      visibility: 'personal',
      createdByWorkspaceMemberId: 'member-owner',
    });

    expect(listInstalledPlugins(db, 'ws-team', 'member-owner').map((p) => p.id))
      .toContain('plugin-personal');
    expect(listInstalledPlugins(db, 'ws-team', 'member-other').map((p) => p.id))
      .not.toContain('plugin-personal');
  });

  it('keeps historical Team bindings out of the active plugin catalog', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    upsertInstalledPlugin(db, fakePlugin('plugin-team'));
    ensureWorkspaceResource(db, 'plugin', 'ws-team', 'plugin-team', {
      visibility: 'team',
      createdByWorkspaceMemberId: 'member-owner',
    });

    expect(listInstalledPlugins(db, 'ws-team', 'member-other').map((p) => p.id))
      .not.toContain('plugin-team');
  });
});
