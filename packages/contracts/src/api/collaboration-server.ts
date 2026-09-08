import { z } from 'zod';
import type { PreviewComment } from './comments.js';

export const CollaborationAuthorityModeSchema = z.enum([
  'local-authoritative',
  'cloud-authoritative',
]);
export type CollaborationAuthorityMode = z.infer<typeof CollaborationAuthorityModeSchema>;

export const CollaborationServerCapabilitiesSchema = z
  .object({
    apiVersion: z.literal('v1'),
    minimumDesktopVersion: z.string().min(1).max(64),
    bundleSchemaVersions: z.array(z.number().int().positive()).min(1),
    authModes: z.array(z.enum(['local', 'oidc'])).min(1),
    projectAuthorityModes: z.array(CollaborationAuthorityModeSchema).min(1),
    features: z.array(
      z.enum([
        'publish',
        'review-comments',
        'reviewer-agent',
        'owner-transfer',
        'audit-export',
      ]),
    ),
  })
  .strict();
export type CollaborationServerCapabilities = z.infer<
  typeof CollaborationServerCapabilitiesSchema
>;

export const CollaborationUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    displayName: z.string().min(1).max(120),
  })
  .strict();
export type CollaborationUser = z.infer<typeof CollaborationUserSchema>;

export const CollaborationRemoteSessionSchema = z
  .object({
    user: CollaborationUserSchema,
    sessionId: z.string().min(1),
    accessToken: z.string().min(32),
    refreshToken: z.string().min(32),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().min(60),
  })
  .strict();
export type CollaborationRemoteSession = z.infer<typeof CollaborationRemoteSessionSchema>;

export const CollaborationProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(160),
    createdByUserId: z.string().min(1),
    ownerUserId: z.string().min(1),
    callerRole: z.enum(['owner', 'reviewer']),
    authorityMode: CollaborationAuthorityModeSchema,
    sourceProjectId: z.string().nullable(),
    status: z.enum(['active', 'transfer_locked', 'archived']),
    revision: z.number().int().positive(),
    publishedVersionId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollaborationProject = z.infer<typeof CollaborationProjectSchema>;

export const CollaborationProjectMemberSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string().min(1).max(120),
    email: z.string().email(),
    role: z.enum(['owner', 'reviewer']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CollaborationProjectMember = z.infer<typeof CollaborationProjectMemberSchema>;

export const CollaborationProjectMembersSchema = z
  .object({ members: z.array(CollaborationProjectMemberSchema) })
  .strict();
export type CollaborationProjectMembers = z.infer<typeof CollaborationProjectMembersSchema>;

export const CollaborationProjectInvitationSummarySchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    email: z.string().email(),
    expiresAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CollaborationProjectInvitationSummary = z.infer<
  typeof CollaborationProjectInvitationSummarySchema
>;

export const CollaborationProjectInvitationsSchema = z
  .object({ invitations: z.array(CollaborationProjectInvitationSummarySchema) })
  .strict();
export type CollaborationProjectInvitations = z.infer<
  typeof CollaborationProjectInvitationsSchema
>;

export const CollaborationProjectInvitationSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    email: z.string().email(),
    role: z.literal('reviewer'),
    expiresAt: z.string().datetime(),
    desktopDeepLink: z.string().url().startsWith('opendesign://collaboration/invite/continue'),
  })
  .strict();
export type CollaborationProjectInvitation = z.infer<
  typeof CollaborationProjectInvitationSchema
>;

export const CreateCollaborationProjectInvitationSchema = z
  .object({ email: z.string().trim().email() })
  .strict();
export type CreateCollaborationProjectInvitation = z.infer<
  typeof CreateCollaborationProjectInvitationSchema
>;

export const AcceptCollaborationProjectInvitationSchema = z
  .object({
    origin: z.string().trim().min(1).max(2048),
    invitationId: z.string().min(1).max(200),
    token: z.string().min(32).max(512),
    displayName: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(12).max(1024),
    deviceName: z.string().trim().min(1).max(160),
  })
  .strict();
export type AcceptCollaborationProjectInvitation = z.infer<
  typeof AcceptCollaborationProjectInvitationSchema
>;

export const CollaborationInvitationAcceptanceSchema = z
  .object({
    session: CollaborationRemoteSessionSchema,
    project: CollaborationProjectSchema,
    role: z.literal('reviewer'),
  })
  .strict();
export type CollaborationInvitationAcceptance = z.infer<
  typeof CollaborationInvitationAcceptanceSchema
>;

export const CollaborationRemoteProjectListSchema = z
  .object({ projects: z.array(CollaborationProjectSchema) })
  .strict();

export const CollaborationProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.string(),
    detail: z.string().optional(),
    requestId: z.string(),
    retryable: z.boolean().default(false),
  })
  .strict();
export type CollaborationProblem = z.infer<typeof CollaborationProblemSchema>;

export const ConfigureCollaborationServerSchema = z
  .object({ origin: z.string().trim().min(1).max(2048) })
  .strict();
export type ConfigureCollaborationServer = z.infer<
  typeof ConfigureCollaborationServerSchema
>;

export const LoginCollaborationServerSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(12).max(1024),
    deviceName: z.string().min(1).max(160),
  })
  .strict();
export type LoginCollaborationServer = z.infer<typeof LoginCollaborationServerSchema>;

export const CollaborationServerProfileSchema = z
  .object({
    id: z.literal('default'),
    origin: z.string().url(),
    capabilities: CollaborationServerCapabilitiesSchema,
    checkedAt: z.string().datetime(),
  })
  .strict();
export type CollaborationServerProfile = z.infer<typeof CollaborationServerProfileSchema>;

export const CollaborationSessionSummarySchema = z
  .object({
    sessionId: z.string().min(1),
    user: CollaborationUserSchema,
  })
  .strict();
export type CollaborationSessionSummary = z.infer<typeof CollaborationSessionSummarySchema>;

export const CollaborationServerStateSchema = z
  .object({
    profile: CollaborationServerProfileSchema.nullable(),
    session: CollaborationSessionSummarySchema.nullable(),
  })
  .strict();
export type CollaborationServerState = z.infer<typeof CollaborationServerStateSchema>;

export const CollaborationProjectListSchema = z
  .object({
    projects: z.array(CollaborationProjectSchema),
  })
  .strict();
export type CollaborationProjectList = z.infer<typeof CollaborationProjectListSchema>;

export const CollaborationReviewFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    role: z.enum(['preview', 'review-source', 'screenshot']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    mimeType: z.string().min(1).max(255),
  })
  .strict();
export type CollaborationReviewFile = z.infer<typeof CollaborationReviewFileSchema>;

export const CollaborationReviewBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('preview-only'),
    project: z
      .object({
        sourceProjectId: z.string().min(1).max(200),
        name: z.string().min(1).max(160),
      })
      .strict(),
    createdAt: z.string().datetime(),
    entrypoint: z.string().startsWith('preview/').max(1024),
    publisher: z
      .object({
        openDesignVersion: z.string().min(1).max(64).optional(),
        bundleBuilderVersion: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    files: z.array(CollaborationReviewFileSchema).min(1).max(500),
  })
  .strict();
export type CollaborationReviewBundleManifest = z.infer<
  typeof CollaborationReviewBundleManifestSchema
>;

export const CollaborationReviewVersionSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    number: z.number().int().positive(),
    mode: z.enum(['preview-only', 'include-review-source']),
    entrypoint: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdByUserId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CollaborationReviewVersion = z.infer<typeof CollaborationReviewVersionSchema>;

export const CollaborationRemotePublishResultSchema = z
  .object({
    version: CollaborationReviewVersionSchema,
    projectRevision: z.number().int().positive(),
    publishedVersionId: z.string().min(1),
    desktopDeepLink: z.string().url().startsWith('opendesign://'),
  })
  .strict();
export type CollaborationRemotePublishResult = z.infer<
  typeof CollaborationRemotePublishResultSchema
>;

export const CollaborationProjectBindingSchema = z
  .object({
    localProjectId: z.string().min(1).max(200),
    serverOrigin: z.string().url(),
    remoteProjectId: z.string().min(1),
    authorityMode: z.literal('local-authoritative'),
    remoteRevision: z.number().int().positive(),
    publishedVersionId: z.string().nullable(),
    lastPublishedVersionNumber: z.number().int().positive().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollaborationProjectBinding = z.infer<typeof CollaborationProjectBindingSchema>;

export const CollaborationProjectBindingStateSchema = z
  .object({
    localProjectId: z.string().min(1).max(200),
    binding: CollaborationProjectBindingSchema.nullable(),
  })
  .strict();
export type CollaborationProjectBindingState = z.infer<
  typeof CollaborationProjectBindingStateSchema
>;

export const CollaborationProjectInvitationMutationResultSchema = z
  .object({
    invitation: CollaborationProjectInvitationSchema,
    binding: CollaborationProjectBindingSchema,
  })
  .strict();
export type CollaborationProjectInvitationMutationResult = z.infer<
  typeof CollaborationProjectInvitationMutationResultSchema
>;

export const CollaborationInvitationAcceptanceResultSchema = z
  .object({
    state: CollaborationServerStateSchema,
    project: CollaborationProjectSchema,
    role: z.literal('reviewer'),
  })
  .strict();
export type CollaborationInvitationAcceptanceResult = z.infer<
  typeof CollaborationInvitationAcceptanceResultSchema
>;

export const BindCollaborationProjectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create') }).strict(),
  z
    .object({
      mode: z.literal('existing'),
      remoteProjectId: z.string().min(1),
    })
    .strict(),
]);
export type BindCollaborationProject = z.infer<typeof BindCollaborationProjectSchema>;

export const CollaborationPublishCandidateRequestSchema = z
  .object({ entrypoint: z.string().min(1).max(1024).optional() })
  .strict();
export type CollaborationPublishCandidateRequest = z.infer<
  typeof CollaborationPublishCandidateRequestSchema
>;

export const CollaborationPublishCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('preview-only'),
    entrypoint: z.string().startsWith('preview/').max(1024),
    files: z.array(CollaborationReviewFileSchema).min(1).max(500),
    totalBytes: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CollaborationPublishCandidate = z.infer<
  typeof CollaborationPublishCandidateSchema
>;

export const PublishCollaborationProjectSchema = z
  .object({
    candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedPaths: z.array(z.string().min(1).max(1024)).min(1).max(500),
    entrypoint: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type PublishCollaborationProject = z.infer<typeof PublishCollaborationProjectSchema>;

export const CollaborationPublishResultSchema = z
  .object({
    binding: CollaborationProjectBindingSchema,
    version: CollaborationReviewVersionSchema,
    projectRevision: z.number().int().positive(),
    publishedVersionId: z.string().min(1),
    desktopDeepLink: z.string().url().startsWith('opendesign://'),
  })
  .strict();
export type CollaborationPublishResult = z.infer<typeof CollaborationPublishResultSchema>;

export const CollaborationReviewVersionListSchema = z
  .object({ versions: z.array(CollaborationReviewVersionSchema) })
  .strict();
export type CollaborationReviewVersionList = z.infer<
  typeof CollaborationReviewVersionListSchema
>;

export const CollaborationReviewPositionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .strict();
export type CollaborationReviewPosition = z.infer<
  typeof CollaborationReviewPositionSchema
>;

export const CollaborationReviewAnnotationStyleSchema = z
  .object({
    color: z.string().max(256).optional(),
    backgroundColor: z.string().max(256).optional(),
    fontSize: z.string().max(256).optional(),
    fontWeight: z.string().max(256).optional(),
    lineHeight: z.string().max(256).optional(),
    textAlign: z.string().max(256).optional(),
    fontFamily: z.string().max(256).optional(),
    paddingTop: z.string().max(256).optional(),
    paddingRight: z.string().max(256).optional(),
    paddingBottom: z.string().max(256).optional(),
    paddingLeft: z.string().max(256).optional(),
    borderRadius: z.string().max(256).optional(),
  })
  .strict();

const CollaborationReviewPodMemberSchema = z
  .object({
    selector: z.string().min(1).max(2048),
    label: z.string().max(300).optional(),
    currentText: z.string().max(4000).optional(),
    style: CollaborationReviewAnnotationStyleSchema.optional(),
    position: CollaborationReviewPositionSchema,
  })
  .strict();

export const CollaborationReviewTargetSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .max(512)
      .regex(/^(preview|source|screenshots)\/[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/),
    selectionKind: z.enum(['element', 'pod', 'visual']),
    elementId: z.string().max(512).optional(),
    selector: z.string().max(2048).optional(),
    label: z.string().max(300).optional(),
    currentText: z.string().max(4000).optional(),
    htmlHint: z.string().max(8000).optional(),
    style: CollaborationReviewAnnotationStyleSchema.optional(),
    position: CollaborationReviewPositionSchema,
    slideIndex: z.number().int().min(0).max(10_000).optional(),
    podMembers: z.array(CollaborationReviewPodMemberSchema).min(1).max(8).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectionKind === 'element' && !value.selector) {
      context.addIssue({ code: 'custom', path: ['selector'], message: 'selector is required' });
    }
    if (value.selectionKind === 'pod' && !value.podMembers) {
      context.addIssue({ code: 'custom', path: ['podMembers'], message: 'podMembers is required' });
    }
  });
export type CollaborationReviewTarget = z.infer<typeof CollaborationReviewTargetSchema>;

export const CollaborationAgentProvenanceSchema = z
  .object({
    name: z.string().min(1).max(120),
    model: z.string().max(160).optional(),
    reviewRunId: z.string().max(160).optional(),
  })
  .strict();
export type CollaborationAgentProvenance = z.infer<
  typeof CollaborationAgentProvenanceSchema
>;

export const CreateCollaborationReviewCommentSchema = z
  .object({
    versionId: z.string().min(1).max(128),
    target: CollaborationReviewTargetSchema,
    note: z.string().trim().min(1).max(10_000),
    source: z.enum(['human', 'agent']),
    agent: CollaborationAgentProvenanceSchema.optional(),
    attachmentIds: z.array(z.string().min(1).max(200)).max(8).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === 'agent' && !value.agent) {
      context.addIssue({ code: 'custom', path: ['agent'], message: 'agent provenance is required' });
    }
    if (value.source === 'human' && value.agent) {
      context.addIssue({ code: 'custom', path: ['agent'], message: 'human comments cannot claim agent provenance' });
    }
    if (new Set(value.attachmentIds).size !== value.attachmentIds.length) {
      context.addIssue({ code: 'custom', path: ['attachmentIds'], message: 'attachmentIds must be unique' });
    }
  });
export type CreateCollaborationReviewComment = z.infer<
  typeof CreateCollaborationReviewCommentSchema
>;

export const CollaborationReviewCommentStatusSchema = z.enum([
  'open',
  'addressed',
  'resolved',
  'reopened',
]);
export type CollaborationReviewCommentStatus = z.infer<
  typeof CollaborationReviewCommentStatusSchema
>;

export const CollaborationReviewCommentAttachmentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const CollaborationReviewCommentSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    versionId: z.string().min(1),
    target: CollaborationReviewTargetSchema,
    note: z.string().min(1),
    source: z.enum(['human', 'agent']),
    agent: CollaborationAgentProvenanceSchema.optional(),
    attachments: z.array(CollaborationReviewCommentAttachmentSchema).default([]),
    authorUserId: z.string().min(1),
    status: CollaborationReviewCommentStatusSchema,
    addressedInVersionId: z.string().nullable(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollaborationReviewComment = z.infer<
  typeof CollaborationReviewCommentSchema
>;

export const CollaborationReviewCommentsSchema = z
  .object({
    comments: z.array(CollaborationReviewCommentSchema),
    commentRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CollaborationReviewComments = z.infer<
  typeof CollaborationReviewCommentsSchema
>;

export const ProjectCollaborationReviewCommentsSchema = CollaborationReviewCommentsSchema.extend({
  version: CollaborationReviewVersionSchema,
}).strict();
export type ProjectCollaborationReviewComments = z.infer<
  typeof ProjectCollaborationReviewCommentsSchema
>;

export const CollaborationReviewCommentBatchSchema = z
  .object({ comments: z.array(CreateCollaborationReviewCommentSchema).min(1).max(100) })
  .strict();
export type CollaborationReviewCommentBatch = z.infer<
  typeof CollaborationReviewCommentBatchSchema
>;

export const CollaborationReviewCommentBatchResultSchema = z
  .object({ comments: z.array(CollaborationReviewCommentSchema) })
  .strict();
export type CollaborationReviewCommentBatchResult = z.infer<
  typeof CollaborationReviewCommentBatchResultSchema
>;

export const ProjectCollaborationCommentProjectionRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(128),
    commentIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.commentIds).size !== value.commentIds.length) {
      context.addIssue({ code: 'custom', path: ['commentIds'], message: 'commentIds must be unique' });
    }
  });
export type ProjectCollaborationCommentProjectionRequest = z.infer<
  typeof ProjectCollaborationCommentProjectionRequestSchema
>;

export interface ProjectCollaborationCommentProjectionResult {
  comments: PreviewComment[];
}

export const TransitionCollaborationReviewCommentSchema = z
  .object({
    status: CollaborationReviewCommentStatusSchema,
    addressedInVersionId: z.string().min(1).max(128).optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type TransitionCollaborationReviewComment = z.infer<
  typeof TransitionCollaborationReviewCommentSchema
>;

export const CollaborationReviewSnapshotSchema = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    project: CollaborationProjectSchema,
    version: CollaborationReviewVersionSchema,
    manifest: CollaborationReviewBundleManifestSchema,
    entrypointUrl: z.string().startsWith('/api/collaboration/review-snapshots/'),
    cachedAt: z.string().datetime(),
  })
  .strict();
export type CollaborationReviewSnapshot = z.infer<
  typeof CollaborationReviewSnapshotSchema
>;

export const CollaborationReviewSnapshotRequestSchema = z
  .object({ versionId: z.string().min(1).max(128).optional() })
  .strict();
export type CollaborationReviewSnapshotRequest = z.infer<
  typeof CollaborationReviewSnapshotRequestSchema
>;
