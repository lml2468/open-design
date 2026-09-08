import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  resolveLocalPluginBySource,
  resolvePluginFolder,
  upsertInstalledPlugin,
} from '../src/plugins/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe('resolveLocalPluginBySource', () => {
  it('returns only the exact installed local source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-local-plugin-source-'));
    roots.push(root);
    const folder = path.join(root, 'plugin');
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, 'open-design.json'),
      JSON.stringify({ name: 'local-id', title: 'Local plugin', version: '1.0.0' }),
    );
    const resolved = await resolvePluginFolder({
      folder,
      folderId: 'local-id',
      sourceKind: 'local',
      source: 'local:personal:local-id',
    });
    if (!resolved.ok) throw new Error(resolved.errors.join('; '));

    const db = openDatabase(root, { dataDir: path.join(root, 'data') });
    upsertInstalledPlugin(db, resolved.record);

    await expect(resolveLocalPluginBySource({
      db,
      id: 'local-id',
      source: 'local:personal:local-id',
      userPluginsRoot: path.join(root, 'data', 'plugins'),
    })).resolves.toMatchObject({ id: 'local-id', title: 'Local plugin' });
    await expect(resolveLocalPluginBySource({
      db,
      id: 'local-id',
      source: 'team:plugin:workspace-a:local-id',
      userPluginsRoot: path.join(root, 'data', 'plugins'),
    })).resolves.toBeNull();
  });
});
