import { describe, expect, it } from 'vitest';
import { projectCollaborationReviewComment } from '../../src/collaboration/comment-projection.js';

const version = {
  id: 'version-2',
  projectId: 'remote-project-1',
  number: 2,
  mode: 'preview-only' as const,
  entrypoint: 'preview/index.html',
  manifestSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
  createdByUserId: 'owner-1',
  createdAt: '2026-09-06T00:00:00.000Z',
};

const comment = {
  id: 'comment-1',
  projectId: 'remote-project-1',
  versionId: version.id,
  target: {
    filePath: 'preview/index.html',
    selectionKind: 'visual' as const,
    label: 'Hero review point',
    position: { x: 0.25, y: 0.4, width: 0, height: 0 },
  },
  note: 'Increase the headline contrast',
  source: 'agent' as const,
  agent: { name: 'Reviewer Bot', model: 'review-model', reviewRunId: 'run-1' },
  attachments: [],
  authorUserId: 'reviewer-1',
  status: 'open' as const,
  addressedInVersionId: null,
  revision: 3,
  createdAt: '2026-09-06T00:01:00.000Z',
  updatedAt: '2026-09-06T00:02:00.000Z',
};

describe('projectCollaborationReviewComment', () => {
  it('creates a stable local PreviewComment identity and retains immutable review provenance', () => {
    const input = {
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'remote-project-1',
      conversationId: 'conversation-1',
      version,
      comment,
    };
    const first = projectCollaborationReviewComment(input);
    const second = projectCollaborationReviewComment(input);

    expect(second.id).toBe(first.id);
    expect(first.target).toMatchObject({
      filePath: 'index.html',
      anchoredVersion: 2,
      position: comment.target.position,
    });
    expect(first.reviewSource).toMatchObject({
      kind: 'collaboration-review',
      remoteVersionId: 'version-2',
      remoteCommentId: 'comment-1',
      remoteCommentRevision: 3,
      authorUserId: 'reviewer-1',
      source: 'agent',
      targetSelectionKind: 'visual',
      targetPosition: comment.target.position,
      agent: { name: 'Reviewer Bot', model: 'review-model', reviewRunId: 'run-1' },
    });
  });

  it('uses a different local identity for the same feedback attached to another conversation', () => {
    const first = projectCollaborationReviewComment({
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'remote-project-1',
      conversationId: 'conversation-1',
      version,
      comment,
    });
    const second = projectCollaborationReviewComment({
      serverOrigin: 'https://design.example.test',
      remoteProjectId: 'remote-project-1',
      conversationId: 'conversation-2',
      version,
      comment,
    });
    expect(second.id).not.toBe(first.id);
  });
});
