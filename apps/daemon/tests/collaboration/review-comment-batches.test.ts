import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationReviewCommentBatchStore } from '../../src/collaboration/review-comment-batches.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
});

const scope = {
  serverOrigin: 'https://design.example.test',
  sessionId: 'session-1',
  userId: 'reviewer-1',
};

const comment = {
  versionId: 'version-1',
  target: {
    filePath: 'preview/index.html',
    selectionKind: 'visual' as const,
    position: { x: 0.4, y: 0.2, width: 0, height: 0 },
  },
  note: 'Increase contrast',
  source: 'agent' as const,
  agent: { name: 'Review Bot', model: 'review-model' },
  attachmentIds: [],
};

describe('CollaborationReviewCommentBatchStore', () => {
  it('persists pending batches with private permissions and isolates them by session', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-review-batches-'));
    cleanupTasks.push(() => rm(dataDir, { recursive: true, force: true }));
    const now = new Date('2026-09-09T00:00:00.000Z');
    const store = new CollaborationReviewCommentBatchStore(dataDir);
    const staged = await store.stage({
      scope,
      remoteProjectId: 'project-1',
      batch: { comments: [comment] },
      now,
    });

    expect(staged).toMatchObject({
      remoteProjectId: 'project-1',
      versionId: 'version-1',
      comments: [{ source: 'agent', note: 'Increase contrast' }],
      expiresAt: '2026-09-10T00:00:00.000Z',
    });
    expect((await stat(path.join(dataDir, 'collaboration-review-comment-batches.json'))).mode & 0o777)
      .toBe(0o600);

    const reopened = new CollaborationReviewCommentBatchStore(dataDir);
    expect(await reopened.list({ scope, remoteProjectId: 'project-1', now }))
      .toEqual([staged]);
    expect(await reopened.list({
      scope: { ...scope, sessionId: 'session-2' },
      remoteProjectId: 'project-1',
      now,
    })).toEqual([]);
    const internal = await reopened.read({
      scope,
      remoteProjectId: 'project-1',
      batchId: staged.id,
      now,
    });
    expect(internal?.comments[0]?.idempotencyKey).toMatch(/^desktop-review-/);
    expect(JSON.stringify(staged)).not.toContain('idempotencyKey');
  });

  it('expires batches after 24 hours and clears every batch owned by a signed-out session', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-review-batches-'));
    cleanupTasks.push(() => rm(dataDir, { recursive: true, force: true }));
    const store = new CollaborationReviewCommentBatchStore(dataDir);
    const now = new Date('2026-09-09T00:00:00.000Z');
    await store.stage({ scope, remoteProjectId: 'project-1', batch: { comments: [comment] }, now });
    await store.stage({ scope, remoteProjectId: 'project-2', batch: { comments: [comment] }, now });
    await store.clearSession(scope);
    expect(await store.list({ scope, remoteProjectId: 'project-1', now })).toEqual([]);

    await store.stage({ scope, remoteProjectId: 'project-1', batch: { comments: [comment] }, now });
    expect(await store.list({
      scope,
      remoteProjectId: 'project-1',
      now: new Date('2026-09-10T00:00:00.001Z'),
    })).toEqual([]);
  });
});
