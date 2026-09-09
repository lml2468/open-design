import { describe, expect, it } from 'vitest';
import {
  CollaborationProjectBindingStateSchema,
  CollaborationConfirmedReviewCommentBatchSchema,
  CollaborationPendingReviewCommentBatchResultSchema,
  CollaborationPendingReviewCommentBatchesSchema,
  CollaborationPublishCandidateSchema,
  CollaborationReviewCommentBatchSchema,
  CollaborationReviewSnapshotSchema,
  CollaborationRemoteSessionSchema,
  CollaborationServerCapabilitiesSchema,
  CollaborationServerStateSchema,
  ProjectCollaborationCommentProjectionRequestSchema,
} from '../src/api/collaboration-server.js';

const capabilities = {
  apiVersion: 'v1',
  minimumDesktopVersion: '0.22.0',
  bundleSchemaVersions: [1],
  authModes: ['local'],
  projectAuthorityModes: ['local-authoritative'],
  features: ['owner-transfer', 'publish', 'review-comments'],
} as const;

describe('collaboration server contracts', () => {
  it('accepts the v1 capability surface and preserves future authority parsing', () => {
    expect(CollaborationServerCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(
      CollaborationServerCapabilitiesSchema.parse({
        ...capabilities,
        projectAuthorityModes: ['local-authoritative', 'cloud-authoritative'],
      }).projectAuthorityModes,
    ).toEqual(['local-authoritative', 'cloud-authoritative']);
  });

  it('keeps bearer credentials out of the renderer-facing state', () => {
    const remoteSession = CollaborationRemoteSessionSchema.parse({
      user: { id: 'usr_1', email: 'owner@example.com', displayName: 'Owner' },
      sessionId: 'ses_1',
      accessToken: 'a'.repeat(32),
      refreshToken: 'r'.repeat(32),
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    const state = CollaborationServerStateSchema.parse({
      profile: {
        id: 'default',
        origin: 'https://design.example.test',
        capabilities,
        checkedAt: '2026-09-06T10:00:00.000Z',
      },
      session: { sessionId: remoteSession.sessionId, user: remoteSession.user },
    });
    expect(JSON.stringify(state)).not.toContain(remoteSession.accessToken);
    expect(JSON.stringify(state)).not.toContain(remoteSession.refreshToken);
  });

  it('rejects undeclared remote capability fields', () => {
    expect(
      CollaborationServerCapabilitiesSchema.safeParse({
        ...capabilities,
        cloudDraftEnabled: true,
      }).success,
    ).toBe(false);
  });

  it('models a local Project binding without filesystem paths or credentials', () => {
    const state = CollaborationProjectBindingStateSchema.parse({
      localProjectId: 'local-project-42',
      binding: {
        localProjectId: 'local-project-42',
        serverOrigin: 'https://design.example.test',
        remoteProjectId: 'prj_42',
        authorityMode: 'local-authoritative',
        remoteRevision: 2,
        publishedVersionId: 'ver_1',
        lastPublishedVersionNumber: 1,
        createdAt: '2026-09-06T10:00:00.000Z',
        updatedAt: '2026-09-06T10:02:00.000Z',
      },
    });
    expect(JSON.stringify(state)).not.toContain('baseDir');
    expect(JSON.stringify(state)).not.toContain('token');
  });

  it('requires preview-only candidate paths and content fingerprints', () => {
    expect(CollaborationPublishCandidateSchema.parse({
      schemaVersion: 1,
      mode: 'preview-only',
      entrypoint: 'preview/index.html',
      files: [{
        path: 'preview/index.html',
        role: 'preview',
        sha256: 'a'.repeat(64),
        size: 12,
        mimeType: 'text/html',
      }],
      totalBytes: 12,
      fingerprint: 'b'.repeat(64),
    }).mode).toBe('preview-only');
  });

  it('models immutable review Snapshots without local filesystem paths', () => {
    const snapshot = CollaborationReviewSnapshotSchema.parse({
      snapshotId: 'f'.repeat(64),
      project: {
        id: 'prj_1',
        name: 'Launch deck',
        createdByUserId: 'usr_1',
        ownerUserId: 'usr_1',
        callerRole: 'reviewer',
        authorityMode: 'local-authoritative',
        sourceProjectId: 'local_1',
        status: 'active',
        revision: 2,
        publishedVersionId: 'ver_1',
        createdAt: '2026-09-06T10:00:00.000Z',
        updatedAt: '2026-09-06T11:00:00.000Z',
      },
      version: {
        id: 'ver_1',
        projectId: 'prj_1',
        number: 1,
        mode: 'preview-only',
        entrypoint: 'preview/index.html',
        manifestSha256: 'a'.repeat(64),
        bundleSha256: 'b'.repeat(64),
        createdByUserId: 'usr_1',
        createdAt: '2026-09-06T11:00:00.000Z',
      },
      manifest: {
        schemaVersion: 1,
        mode: 'preview-only',
        project: { sourceProjectId: 'local_1', name: 'Launch deck' },
        createdAt: '2026-09-06T11:00:00.000Z',
        entrypoint: 'preview/index.html',
        files: [{
          path: 'preview/index.html',
          role: 'preview',
          sha256: 'c'.repeat(64),
          size: 12,
          mimeType: 'text/html',
        }],
      },
      entrypointUrl: `/api/collaboration/review-snapshots/${'f'.repeat(64)}/files/preview/index.html`,
      cachedAt: '2026-09-06T11:01:00.000Z',
    });
    expect(JSON.stringify(snapshot)).not.toContain('/Users/');
  });

  it('requires Agent provenance for Agent-generated review comments', () => {
    const comment = {
      versionId: 'ver_1',
      target: {
        filePath: 'preview/index.html',
        selectionKind: 'visual',
        position: { x: 0.5, y: 0.25, width: 0, height: 0 },
      },
      note: 'Increase contrast',
      source: 'agent',
      attachmentIds: [],
    };
    expect(CollaborationReviewCommentBatchSchema.safeParse({ comments: [comment] }).success).toBe(false);
    const agentComment = {
      ...comment,
      agent: { name: 'Reviewer Agent', model: 'review-model' },
    };
    expect(CollaborationReviewCommentBatchSchema.safeParse({ comments: [agentComment] }).success).toBe(true);
    expect(CollaborationReviewCommentBatchSchema.safeParse({
      comments: [{ ...agentComment, source: 'human', agent: undefined }],
    }).success).toBe(false);
    expect(CollaborationReviewCommentBatchSchema.safeParse({
      comments: [agentComment, { ...agentComment, versionId: 'ver_2' }],
    }).success).toBe(false);

    const pendingBatch = {
      id: 'batch-1',
      remoteProjectId: 'project-1',
      versionId: 'ver_1',
      comments: [agentComment],
      createdAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-10T00:00:00.000Z',
    };
    expect(CollaborationPendingReviewCommentBatchResultSchema.parse({ batch: pendingBatch }))
      .toEqual({ batch: pendingBatch });
    expect(CollaborationPendingReviewCommentBatchesSchema.parse({ batches: [pendingBatch] }))
      .toEqual({ batches: [pendingBatch] });
    expect(CollaborationConfirmedReviewCommentBatchSchema.parse({ comments: [] }))
      .toEqual({ comments: [] });
  });

  it('requires a unique non-empty Owner selection when projecting review comments', () => {
    const selection = {
      conversationId: 'conversation-1',
      versionId: 'version-1',
      commentIds: ['comment-1'],
    };
    expect(ProjectCollaborationCommentProjectionRequestSchema.parse(selection)).toEqual(selection);
    expect(ProjectCollaborationCommentProjectionRequestSchema.safeParse({
      ...selection,
      commentIds: ['comment-1', 'comment-1'],
    }).success).toBe(false);
  });
});
