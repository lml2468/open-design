import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollaborationReviewSnapshotError,
  CollaborationReviewSnapshotStore,
  normalizeSnapshotPath,
} from '../../src/collaboration/review-snapshot.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CollaborationReviewSnapshotStore', () => {
  it('materializes a verified immutable Snapshot without exposing remote credentials or paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-review-snapshot-'));
    roots.push(root);
    const store = new CollaborationReviewSnapshotStore(root);
    const html = Buffer.from('<h1>Review me</h1>');
    const readRemoteFile = vi.fn(async () => html);

    const snapshot = await store.materialize({
      serverOrigin: 'https://design.example.test',
      cachedForUserId: 'reviewer-1',
      project: project(),
      version: version(),
      manifest: manifest(html),
      cachedAt: '2026-09-06T12:00:00.000Z',
      readRemoteFile,
    });

    expect(snapshot.entrypointUrl).toContain(snapshot.snapshotId);
    expect(snapshot.entrypointUrl.endsWith('/preview/index.html')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expect(JSON.stringify(snapshot)).not.toContain('token');
    expect((await store.readSnapshotFile(snapshot.snapshotId, 'preview/index.html')).bytes).toEqual(html);
    await expect(
      store.readSnapshotFile(snapshot.snapshotId, 'preview/index.html', 'different-user'),
    ).rejects.toMatchObject({ code: 'COLLABORATION_REVIEW_UNAVAILABLE' });
    expect(readRemoteFile).toHaveBeenCalledTimes(1);

    await store.materialize({
      serverOrigin: 'https://design.example.test',
      cachedForUserId: 'reviewer-1',
      project: project(),
      version: version(),
      manifest: manifest(html),
      cachedAt: '2026-09-06T12:01:00.000Z',
      readRemoteFile,
    });
    expect(readRemoteFile).toHaveBeenCalledTimes(1);
    expect(await readFile(
      path.join(root, 'collaboration-review-snapshots', snapshot.snapshotId, 'preview', 'index.html'),
      'utf8',
    )).toBe('<h1>Review me</h1>');
  });

  it('rejects traversal and checksum mismatches before a Snapshot is readable', async () => {
    expect(() => normalizeSnapshotPath('../secret')).toThrow(CollaborationReviewSnapshotError);
    expect(() => normalizeSnapshotPath('preview/../secret')).toThrow(CollaborationReviewSnapshotError);

    const root = await mkdtemp(path.join(tmpdir(), 'od-review-snapshot-'));
    roots.push(root);
    const store = new CollaborationReviewSnapshotStore(root);
    await expect(store.materialize({
      serverOrigin: 'https://design.example.test',
      cachedForUserId: 'reviewer-1',
      project: project(),
      version: version(),
      manifest: manifest(Buffer.from('expected')),
      cachedAt: '2026-09-06T12:00:00.000Z',
      readRemoteFile: async () => Buffer.from('tampered'),
    })).rejects.toMatchObject({ code: 'COLLABORATION_SNAPSHOT_UNSAFE' });
  });
});

function project() {
  return {
    id: 'project-1',
    name: 'Launch Website',
    createdByUserId: 'user-1',
    ownerUserId: 'user-1',
    callerRole: 'reviewer' as const,
    authorityMode: 'local-authoritative' as const,
    sourceProjectId: 'local-project-1',
    status: 'active' as const,
    revision: 2,
    publishedVersionId: 'version-1',
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T11:00:00.000Z',
  };
}

function version() {
  return {
    id: 'version-1',
    projectId: 'project-1',
    number: 1,
    mode: 'preview-only' as const,
    entrypoint: 'preview/index.html',
    manifestSha256: 'a'.repeat(64),
    bundleSha256: 'b'.repeat(64),
    createdByUserId: 'user-1',
    createdAt: '2026-09-06T11:00:00.000Z',
  };
}

function manifest(bytes: Buffer) {
  return {
    schemaVersion: 1 as const,
    mode: 'preview-only' as const,
    project: { sourceProjectId: 'local-project-1', name: 'Launch Website' },
    createdAt: '2026-09-06T11:00:00.000Z',
    entrypoint: 'preview/index.html',
    files: [{
      path: 'preview/index.html',
      role: 'preview' as const,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      mimeType: 'text/html',
    }],
  };
}
