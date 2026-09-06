import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CollaborationProjectBindingConflictError,
  CollaborationProjectBindingStore,
} from '../../src/collaboration/project-binding.js';

const temporaryRoots: string[] = [];

async function storeFixture(): Promise<{ root: string; store: CollaborationProjectBindingStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-collaboration-bindings-'));
  temporaryRoots.push(root);
  return { root, store: new CollaborationProjectBindingStore(root) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CollaborationProjectBindingStore', () => {
  it('stores one binding per local Project without local paths or credentials', async () => {
    const { root, store } = await storeFixture();
    const binding = await store.create({
      localProjectId: 'local-project-42',
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'prj_42',
      remoteRevision: 1,
      publishedVersionId: null,
      now: '2026-09-06T10:00:00.000Z',
    });

    expect(await store.read('local-project-42')).toEqual(binding);
    const file = path.join(root, 'collaboration-project-bindings.json');
    const body = await readFile(file, 'utf8');
    expect(body).not.toContain('accessToken');
    expect(body).not.toContain('refreshToken');
    expect(body).not.toContain('baseDir');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects replacing a local Project binding without an explicit unbind', async () => {
    const { store } = await storeFixture();
    await store.create({
      localProjectId: 'local-project-42',
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'prj_42',
      remoteRevision: 1,
      publishedVersionId: null,
      now: '2026-09-06T10:00:00.000Z',
    });

    await expect(store.create({
      localProjectId: 'local-project-42',
      serverOrigin: 'https://other.example.test',
      remoteProjectId: 'prj_other',
      remoteRevision: 1,
      publishedVersionId: null,
      now: '2026-09-06T10:01:00.000Z',
    })).rejects.toBeInstanceOf(CollaborationProjectBindingConflictError);
  });

  it('records the remote revision and immutable version receipt after Publish', async () => {
    const { store } = await storeFixture();
    await store.create({
      localProjectId: 'local-project-42',
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'prj_42',
      remoteRevision: 1,
      publishedVersionId: null,
      now: '2026-09-06T10:00:00.000Z',
    });
    const updated = await store.recordPublish({
      localProjectId: 'local-project-42',
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'prj_42',
      remoteRevision: 2,
      publishedVersionId: 'ver_1',
      versionNumber: 1,
      now: '2026-09-06T10:02:00.000Z',
    });

    expect(updated).toMatchObject({
      remoteRevision: 2,
      publishedVersionId: 'ver_1',
      lastPublishedVersionNumber: 1,
    });
  });
});
