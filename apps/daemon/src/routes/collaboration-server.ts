import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  AcceptCollaborationProjectInvitationSchema,
  BindCollaborationProjectSchema,
  CollaborationReviewCommentBatchSchema,
  CollaborationReviewSnapshotRequestSchema,
  CollaborationPublishCandidateRequestSchema,
  ConfigureCollaborationServerSchema,
  CreateCollaborationProjectInvitationSchema,
  CreateCollaborationReviewCommentSchema,
  LoginCollaborationServerSchema,
  PublishCollaborationProjectSchema,
  ProjectCollaborationCommentProjectionRequestSchema,
  TransitionCollaborationReviewCommentSchema,
  type ApiErrorCode,
  type CollaborationReviewComment,
  type CollaborationReviewVersion,
  type PreviewComment,
} from '@open-design/contracts';
import {
  CollaborationProjectBindingConflictError,
  CollaborationProjectBindingStore,
} from '../collaboration/project-binding.js';
import {
  CollaborationReviewCommentBatchStore,
  type CollaborationReviewCommentBatchScope,
} from '../collaboration/review-comment-batches.js';
import {
  buildCollaborationPublishCandidate,
  buildCollaborationReviewBundle,
  CollaborationBundleError,
  type CollaborationProjectFile,
} from '../collaboration/review-bundle.js';
import {
  CollaborationReviewSnapshotError,
  CollaborationReviewSnapshotStore,
} from '../collaboration/review-snapshot.js';
import {
  CollaborationServerClient,
  CollaborationServerRequestError,
  normalizeCollaborationServerOrigin,
} from '../collaboration/server-client.js';
import {
  CollaborationServerProfileStore,
  type CollaborationStoredSession,
  type CollaborationStoredState,
} from '../collaboration/server-profile.js';

type AuthenticatedStoredState = {
  profile: NonNullable<CollaborationStoredState['profile']>;
  session: CollaborationStoredSession;
};

export interface RegisterCollaborationServerRoutesDeps {
  runtimeDataDir: string;
  requireLocalDaemonRequest: RequestHandler;
  sendApiError: (
    res: Response,
    status: number,
    code: ApiErrorCode,
    message: string,
    init?: { retryable?: boolean; requestId?: string },
  ) => Response;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  getProject?: (projectId: string) => {
    id: string;
    name: string;
    metadata?: unknown;
  } | null;
  listProjectFiles?: (
    projectId: string,
    metadata: unknown,
  ) => Promise<CollaborationProjectFile[]>;
  projectReviewComments?: (input: {
    localProjectId: string;
    conversationId: string;
    serverOrigin: string;
    remoteProjectId: string;
    version: CollaborationReviewVersion;
    comments: CollaborationReviewComment[];
  }) => PreviewComment[] | null;
}

export function registerCollaborationServerRoutes(
  app: Express,
  deps: RegisterCollaborationServerRoutesDeps,
): void {
  const profiles = new CollaborationServerProfileStore(deps.runtimeDataDir);
  const bindings = new CollaborationProjectBindingStore(deps.runtimeDataDir);
  const snapshots = new CollaborationReviewSnapshotStore(deps.runtimeDataDir);
  const reviewCommentBatches = new CollaborationReviewCommentBatchStore(deps.runtimeDataDir);
  const now = deps.now ?? (() => new Date());
  const clientFor = (origin: string) =>
    new CollaborationServerClient(origin, deps.fetchImpl);
  const sessionRefreshes = new Map<string, Promise<CollaborationStoredSession>>();
  const withAuthenticatedSession = <T>(
    operation: (client: CollaborationServerClient, accessToken: string) => Promise<T>,
  ) => withAuthenticatedClient(
    profiles,
    reviewCommentBatches,
    sessionRefreshes,
    clientFor,
    now,
    operation,
  );

  app.get('/api/collaboration/server', deps.requireLocalDaemonRequest, async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await profiles.readPublicState());
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  app.put('/api/collaboration/server', deps.requireLocalDaemonRequest, async (req, res) => {
    const parsed = ConfigureCollaborationServerSchema.safeParse(req.body);
    if (!parsed.success) {
      return deps.sendApiError(res, 400, 'BAD_REQUEST', 'A valid Collaboration Server URL is required');
    }
    try {
      const origin = normalizeCollaborationServerOrigin(parsed.data.origin);
      const capabilities = await clientFor(origin).getCapabilities();
      if (!capabilities.projectAuthorityModes.includes('local-authoritative')) {
        return deps.sendApiError(
          res,
          409,
          'COLLABORATION_SERVER_INCOMPATIBLE',
          'Server does not support local-authoritative Projects',
        );
      }
      if (!capabilities.features.includes('publish') || !capabilities.bundleSchemaVersions.includes(1)) {
        return deps.sendApiError(
          res,
          409,
          'COLLABORATION_SERVER_INCOMPATIBLE',
          'Server does not support preview-only Publish Bundle schema version 1',
        );
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json(
        await profiles.setProfile({
          origin,
          capabilities,
          checkedAt: now().toISOString(),
        }),
      );
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  app.post('/api/collaboration/login', deps.requireLocalDaemonRequest, async (req, res) => {
    const parsed = LoginCollaborationServerSchema.safeParse(req.body);
    if (!parsed.success) {
      return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Email, password, and device name are required');
    }
    try {
      const stored = await profiles.readCredentials();
      if (!stored.profile) {
        return deps.sendApiError(
          res,
          409,
          'COLLABORATION_SERVER_NOT_CONFIGURED',
          'Configure a Collaboration Server before signing in',
        );
      }
      if (!stored.profile.capabilities.authModes.includes('local')) {
        return deps.sendApiError(
          res,
          409,
          'COLLABORATION_SERVER_INCOMPATIBLE',
          'Configured server does not support local sign-in',
        );
      }
      const session = await clientFor(stored.profile.origin).login(parsed.data);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await profiles.setSession(session, now().getTime()));
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  app.post('/api/collaboration/invitations/accept', deps.requireLocalDaemonRequest, async (req, res) => {
    const parsed = AcceptCollaborationProjectInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      return deps.sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'Server, invitation, password, and device name are required',
      );
    }
    try {
      const origin = normalizeCollaborationServerOrigin(parsed.data.origin);
      const client = clientFor(origin);
      const capabilities = await client.getCapabilities();
      if (
        !capabilities.authModes.includes('local')
        || !capabilities.projectAuthorityModes.includes('local-authoritative')
      ) {
        return deps.sendApiError(
          res,
          409,
          'COLLABORATION_SERVER_INCOMPATIBLE',
          'Invitation Server does not support local-authoritative Desktop access',
        );
      }
      const accepted = await client.acceptInvitation({
        token: parsed.data.token,
        password: parsed.data.password,
        deviceName: parsed.data.deviceName,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      });
      await profiles.setProfile({
        origin,
        capabilities,
        checkedAt: now().toISOString(),
      });
      const state = await profiles.setSession(accepted.session, now().getTime());
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        state,
        project: accepted.project,
        role: accepted.role,
      });
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  app.delete('/api/collaboration/session', deps.requireLocalDaemonRequest, async (_req, res) => {
    try {
      const stored = await profiles.readCredentials();
      if (stored.profile && stored.session) {
        await clientFor(stored.profile.origin)
          .logout(stored.session.accessToken)
          .catch(() => undefined);
      }
      if (stored.profile && stored.session) {
        await reviewCommentBatches.clearSession(reviewBatchScope(stored));
      }
      await profiles.clearSession();
      return res.status(204).end();
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  app.get('/api/collaboration/projects', deps.requireLocalDaemonRequest, async (_req, res) => {
    try {
      const result = await withAuthenticatedSession((client, accessToken) =>
        client.listProjects(accessToken),
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      return sendCollaborationError(res, deps, error);
    }
  });

  const reviewOperations = new Map<string, Promise<unknown>>();

  app.get(
    '/api/collaboration/projects/:remoteProjectId/versions',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      try {
        const result = await withAuthenticatedSession((client, accessToken) =>
          client.listVersions(accessToken, remoteProjectIdParam(req)),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/collaboration/projects/:remoteProjectId/review-snapshot',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = CollaborationReviewSnapshotRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review Version id is invalid');
      }
      const remoteProjectId = remoteProjectIdParam(req);
      try {
        const snapshot = await withProjectOperation(
          reviewOperations,
          `snapshot:${remoteProjectId}:${parsed.data.versionId ?? 'published'}`,
          async () => {
            const stored = await profiles.readCredentials();
            if (!stored.profile?.capabilities.features.includes('review-comments')) {
              throw new CollaborationServerRequestError(
                409,
                'COLLABORATION_SERVER_INCOMPATIBLE',
                'Configured Collaboration Server does not support review comments',
              );
            }
            return withAuthenticatedSession(async (client, accessToken) => {
              const project = await client.getProject(accessToken, remoteProjectId);
              const version = parsed.data.versionId
                ? await client.getVersion(accessToken, remoteProjectId, parsed.data.versionId)
                : await client.getPublishedVersion(accessToken, remoteProjectId);
              const manifest = await client.getVersionManifest(
                accessToken,
                remoteProjectId,
                version.id,
              );
              return snapshots.materialize({
                serverOrigin: client.origin,
                cachedForUserId: stored.session!.user.id,
                project,
                version,
                manifest,
                cachedAt: now().toISOString(),
                readRemoteFile: (filePath) => client.readVersionFile(
                  accessToken,
                  remoteProjectId,
                  version.id,
                  filePath,
                ),
              });
            });
          },
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(snapshot);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.get(
    '/api/collaboration/review-snapshots/:snapshotId/files/*splat',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      try {
        const stored = await profiles.readCredentials();
        if (!stored.session) {
          throw new CollaborationServerRequestError(
            401,
            'COLLABORATION_AUTH_REQUIRED',
            'Sign in to the Collaboration Server before opening a Review Snapshot',
          );
        }
        const splat = (req.params as { splat?: string | string[] }).splat;
        const requestedPath = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
        const result = await snapshots.readSnapshotFile(
          routeParam(req, 'snapshotId'),
          requestedPath,
          stored.session.user.id,
        );
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const contentType = reviewContentType(result.file.mimeType);
        res.setHeader('Content-Type', contentType);
        if (contentType === 'text/html; charset=utf-8') {
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'",
          );
        }
        return res.send(result.bytes);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.get(
    '/api/collaboration/projects/:remoteProjectId/review-comments',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
      try {
        const result = await withAuthenticatedSession((client, accessToken) =>
          client.listComments(accessToken, remoteProjectIdParam(req), versionId),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/collaboration/projects/:remoteProjectId/review-comments',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = CreateCollaborationReviewCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review comment is invalid');
      }
      if (parsed.data.source === 'agent') {
        return deps.sendApiError(
          res,
          409,
          'CONFLICT',
          'Agent review comments must be staged and confirmed by a person before submission',
        );
      }
      try {
        const idempotencyKey = randomUUID();
        const result = await withAuthenticatedSession((client, accessToken) =>
          client.createComment(
            accessToken,
            remoteProjectIdParam(req),
            parsed.data,
            idempotencyKey,
          ),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.status(201).json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/collaboration/projects/:remoteProjectId/review-comments/batch',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = CollaborationReviewCommentBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review comment batch is invalid');
      }
      try {
        const stored = await profiles.readCredentials();
        const batch = await reviewCommentBatches.stage({
          scope: reviewBatchScope(stored),
          remoteProjectId: remoteProjectIdParam(req),
          batch: parsed.data,
          now: now(),
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(202).json({ batch });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.get(
    '/api/collaboration/projects/:remoteProjectId/review-comments/batches',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
      if (versionId !== undefined && (versionId.length < 1 || versionId.length > 128)) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review Version id is invalid');
      }
      try {
        const stored = await profiles.readCredentials();
        const batches = await reviewCommentBatches.list({
          scope: reviewBatchScope(stored),
          remoteProjectId: remoteProjectIdParam(req),
          ...(versionId ? { versionId } : {}),
          now: now(),
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ batches });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/collaboration/projects/:remoteProjectId/review-comments/batches/:batchId/confirm',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const remoteProjectId = remoteProjectIdParam(req);
      const batchId = routeParam(req, 'batchId');
      try {
        const result = await withProjectOperation(
          reviewOperations,
          `review-comment-batch:${batchId}`,
          async () => {
            const stored = await profiles.readCredentials();
            const scope = reviewBatchScope(stored);
            const batch = await reviewCommentBatches.read({
              scope,
              remoteProjectId,
              batchId,
              now: now(),
            });
            if (!batch) {
              throw new CollaborationServerRequestError(
                404,
                'COLLABORATION_REVIEW_BATCH_NOT_FOUND',
                'Pending review comment batch was not found',
              );
            }
            if (batch.status === 'confirmed') {
              return batch.comments.map(({ result: comment }) => comment!);
            }
            await withAuthenticatedSession(async (client, accessToken) => {
              for (const [index, pendingComment] of batch.comments.entries()) {
                if (pendingComment.result) continue;
                const comment = await client.createComment(
                  accessToken,
                  remoteProjectId,
                  pendingComment.input,
                  pendingComment.idempotencyKey,
                );
                pendingComment.result = comment;
                await reviewCommentBatches.recordSubmitted({
                  scope,
                  remoteProjectId,
                  batchId,
                  commentIndex: index,
                  result: comment,
                  now: now(),
                });
              }
            });
            return reviewCommentBatches.markConfirmed({
              scope,
              remoteProjectId,
              batchId,
              now: now(),
            });
          },
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ comments: result });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.delete(
    '/api/collaboration/projects/:remoteProjectId/review-comments/batches/:batchId',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      try {
        const stored = await profiles.readCredentials();
        const discarded = await reviewCommentBatches.discard({
          scope: reviewBatchScope(stored),
          remoteProjectId: remoteProjectIdParam(req),
          batchId: routeParam(req, 'batchId'),
          now: now(),
        });
        if (!discarded) {
          return deps.sendApiError(
            res,
            404,
            'NOT_FOUND',
            'Pending review comment batch was not found',
          );
        }
        return res.status(204).end();
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/collaboration/projects/:remoteProjectId/review-comments/:commentId/status',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = TransitionCollaborationReviewCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review comment transition is invalid');
      }
      try {
        const comment = await withAuthenticatedSession((client, accessToken) =>
          client.transitionComment(
            accessToken,
            remoteProjectIdParam(req),
            routeParam(req, 'commentId'),
            parsed.data,
          ),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(comment);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  if (!deps.getProject || !deps.listProjectFiles) return;
  const projectOperations = new Map<string, Promise<unknown>>();

  const loadOwnerBinding = async (localProjectId: string) => {
    const binding = await bindings.read(localProjectId);
    if (!binding) {
      throw new CollaborationServerRequestError(
        409,
        'COLLABORATION_SERVER_NOT_CONFIGURED',
        'Bind this local Project to a Collaboration Project first',
      );
    }
    const stored = await profiles.readCredentials();
    if (!stored.profile || stored.profile.origin !== binding.serverOrigin) {
      throw new CollaborationServerRequestError(
        409,
        'COLLABORATION_SERVER_NOT_CONFIGURED',
        'Switch to the Collaboration Server used by this Project binding',
      );
    }
    return { binding, stored };
  };

  const loadOwnerReview = async (localProjectId: string, versionId?: string) => {
    const binding = await bindings.read(localProjectId);
    if (!binding) {
      throw new CollaborationServerRequestError(
        409,
        'COLLABORATION_SERVER_NOT_CONFIGURED',
        'Bind this local Project to a Collaboration Project first',
      );
    }
    const stored = await profiles.readCredentials();
    if (!stored.profile || stored.profile.origin !== binding.serverOrigin) {
      throw new CollaborationServerRequestError(
        409,
        'COLLABORATION_SERVER_NOT_CONFIGURED',
        'Switch to the Collaboration Server used by this Project binding',
      );
    }
    return withAuthenticatedSession(async (client, accessToken) => {
      const remoteProject = await client.getProject(accessToken, binding.remoteProjectId);
      validateRemoteBindingProject(remoteProject, localProjectId);
      const version = versionId
        ? await client.getVersion(accessToken, binding.remoteProjectId, versionId)
        : await client.getPublishedVersion(accessToken, binding.remoteProjectId);
      const review = await client.listComments(accessToken, binding.remoteProjectId, version.id);
      return { binding, serverOrigin: stored.profile!.origin, version, review };
    });
  };

  app.get(
    '/api/projects/:id/collaboration',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        localProjectId: project.id,
        binding: await bindings.read(project.id),
      });
    },
  );

  app.post(
    '/api/projects/:id/collaboration',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = BindCollaborationProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'A valid Collaboration binding mode is required');
      }
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const binding = await withProjectOperation(projectOperations, project.id, async () => {
          const stored = await profiles.readCredentials();
          if (!stored.profile) {
            throw new CollaborationServerRequestError(
              409,
              'COLLABORATION_SERVER_NOT_CONFIGURED',
              'Configure a Collaboration Server first',
            );
          }
          const existing = await bindings.read(project.id);
          if (existing) {
            if (existing.serverOrigin !== stored.profile.origin) {
              throw new CollaborationProjectBindingConflictError(
                'Local Project is already bound to a different Collaboration Server',
              );
            }
            return existing;
          }
          const remote = await withAuthenticatedSession(
            (client, accessToken) => parsed.data.mode === 'create'
              ? client.createProject(
                  accessToken,
                  { name: project.name, sourceProjectId: project.id },
                  createProjectIdempotencyKey(stored.profile!.origin, project.id),
                )
              : client.getProject(accessToken, parsed.data.remoteProjectId),
          );
          validateRemoteBindingProject(remote, project.id);
          return bindings.create({
            localProjectId: project.id,
            serverOrigin: stored.profile.origin,
            remoteProjectId: remote.id,
            remoteRevision: remote.revision,
            publishedVersionId: remote.publishedVersionId,
            now: now().toISOString(),
          });
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(201).json({ localProjectId: project.id, binding });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.delete(
    '/api/projects/:id/collaboration',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      await bindings.remove(project.id);
      return res.status(204).end();
    },
  );

  app.get(
    '/api/projects/:id/collaboration/members',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const { binding } = await loadOwnerBinding(project.id);
        const result = await withAuthenticatedSession(async (client, accessToken) => {
          const remote = await client.getProject(accessToken, binding.remoteProjectId);
          validateRemoteBindingProject(remote, project.id);
          return client.listProjectMembers(accessToken, binding.remoteProjectId);
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.get(
    '/api/projects/:id/collaboration/invitations',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const { binding } = await loadOwnerBinding(project.id);
        const result = await withAuthenticatedSession(async (client, accessToken) => {
          const remote = await client.getProject(accessToken, binding.remoteProjectId);
          validateRemoteBindingProject(remote, project.id);
          return client.listProjectInvitations(accessToken, binding.remoteProjectId);
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/projects/:id/collaboration/invitations',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = CreateCollaborationProjectInvitationSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'A valid Reviewer email is required');
      }
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const result = await withProjectOperation(projectOperations, project.id, async () => {
          const { binding } = await loadOwnerBinding(project.id);
          return withAuthenticatedSession(async (client, accessToken) => {
            const remote = await client.getProject(accessToken, binding.remoteProjectId);
            validateRemoteBindingProject(remote, project.id);
            const invitation = await client.createProjectInvitation(accessToken, {
              projectId: binding.remoteProjectId,
              projectRevision: remote.revision,
              email: parsed.data.email,
              idempotencyKey: randomUUID(),
            });
            const updated = await client.getProject(accessToken, binding.remoteProjectId);
            const nextBinding = await bindings.recordRemoteProject({
              localProjectId: project.id,
              serverOrigin: binding.serverOrigin,
              remoteProjectId: binding.remoteProjectId,
              remoteRevision: updated.revision,
              publishedVersionId: updated.publishedVersionId,
              now: now().toISOString(),
            });
            return { invitation, binding: nextBinding };
          });
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(201).json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.delete(
    '/api/projects/:id/collaboration/invitations/:invitationId',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const binding = await withProjectOperation(projectOperations, project.id, async () => {
          const current = await loadOwnerBinding(project.id);
          return withAuthenticatedSession(async (client, accessToken) => {
            const remote = await client.getProject(accessToken, current.binding.remoteProjectId);
            validateRemoteBindingProject(remote, project.id);
            await client.revokeProjectInvitation(accessToken, {
              projectId: current.binding.remoteProjectId,
              invitationId: routeParam(req, 'invitationId'),
              projectRevision: remote.revision,
            });
            const updated = await client.getProject(accessToken, current.binding.remoteProjectId);
            return bindings.recordRemoteProject({
              localProjectId: project.id,
              serverOrigin: current.binding.serverOrigin,
              remoteProjectId: current.binding.remoteProjectId,
              remoteRevision: updated.revision,
              publishedVersionId: updated.publishedVersionId,
              now: now().toISOString(),
            });
          });
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ localProjectId: project.id, binding });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.delete(
    '/api/projects/:id/collaboration/members/:userId',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const binding = await withProjectOperation(projectOperations, project.id, async () => {
          const current = await loadOwnerBinding(project.id);
          return withAuthenticatedSession(async (client, accessToken) => {
            const remote = await client.getProject(accessToken, current.binding.remoteProjectId);
            validateRemoteBindingProject(remote, project.id);
            await client.removeProjectReviewer(accessToken, {
              projectId: current.binding.remoteProjectId,
              userId: routeParam(req, 'userId'),
              projectRevision: remote.revision,
            });
            const updated = await client.getProject(accessToken, current.binding.remoteProjectId);
            return bindings.recordRemoteProject({
              localProjectId: project.id,
              serverOrigin: current.binding.serverOrigin,
              remoteProjectId: current.binding.remoteProjectId,
              remoteRevision: updated.revision,
              publishedVersionId: updated.publishedVersionId,
              now: now().toISOString(),
            });
          });
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ localProjectId: project.id, binding });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.get(
    '/api/projects/:id/collaboration/review-comments',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      const versionId = typeof req.query.versionId === 'string' && req.query.versionId.trim()
        ? req.query.versionId.trim()
        : undefined;
      try {
        const { version, review } = await loadOwnerReview(project.id, versionId);
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ...review, version });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/projects/:id/collaboration/preview-comments',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = ProjectCollaborationCommentProjectionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Review comment selection is invalid');
      }
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      if (!deps.projectReviewComments) {
        return deps.sendApiError(res, 501, 'INTERNAL_ERROR', 'Review comment projection is unavailable');
      }
      try {
        const { binding, serverOrigin, version, review } = await loadOwnerReview(
          project.id,
          parsed.data.versionId,
        );
        const byId = new Map(review.comments.map((comment) => [comment.id, comment]));
        const selected = parsed.data.commentIds.map((commentId) => byId.get(commentId));
        if (selected.some((comment) => !comment)) {
          return deps.sendApiError(res, 404, 'NOT_FOUND', 'One or more Review comments were not found');
        }
        const actionable = selected as CollaborationReviewComment[];
        if (actionable.some((comment) => comment.status !== 'open' && comment.status !== 'reopened')) {
          return deps.sendApiError(res, 409, 'CONFLICT', 'Only open or reopened comments can be sent to the Owner Agent');
        }
        const comments = deps.projectReviewComments({
          localProjectId: project.id,
          conversationId: parsed.data.conversationId,
          serverOrigin,
          remoteProjectId: binding.remoteProjectId,
          version,
          comments: actionable,
        });
        if (!comments) {
          return deps.sendApiError(res, 404, 'NOT_FOUND', 'Conversation not found for this Project');
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ comments });
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/projects/:id/collaboration/publish-candidate',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = CollaborationPublishCandidateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Publish entrypoint is invalid');
      }
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const files = await deps.listProjectFiles!(project.id, project.metadata);
        const candidate = await buildCollaborationPublishCandidate({
          files,
          ...(parsed.data.entrypoint ? { entrypoint: parsed.data.entrypoint } : {}),
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json(candidate);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );

  app.post(
    '/api/projects/:id/collaboration/publish',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const parsed = PublishCollaborationProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        return deps.sendApiError(res, 400, 'BAD_REQUEST', 'Confirmed Publish candidate is invalid');
      }
      const project = deps.getProject!(projectIdParam(req));
      if (!project) return deps.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
      try {
        const result = await withProjectOperation(projectOperations, project.id, async () => {
          const binding = await bindings.read(project.id);
          if (!binding) {
            throw new CollaborationServerRequestError(
              409,
              'COLLABORATION_SERVER_NOT_CONFIGURED',
              'Bind this local Project to a Collaboration Project before publishing',
            );
          }
          const stored = await profiles.readCredentials();
          if (!stored.profile || stored.profile.origin !== binding.serverOrigin) {
            throw new CollaborationServerRequestError(
              409,
              'COLLABORATION_SERVER_NOT_CONFIGURED',
              'Switch to the Collaboration Server used by this Project binding',
            );
          }
          if (!stored.profile.capabilities.features.includes('publish')) {
            throw new CollaborationServerRequestError(
              409,
              'COLLABORATION_SERVER_INCOMPATIBLE',
              'Configured Collaboration Server does not support Publish',
            );
          }
          const files = await deps.listProjectFiles!(project.id, project.metadata);
          const bundle = await buildCollaborationReviewBundle({
            sourceProjectId: project.id,
            projectName: project.name,
            files,
            ...(parsed.data.entrypoint ? { entrypoint: parsed.data.entrypoint } : {}),
            expectedFingerprint: parsed.data.candidateFingerprint,
            confirmedPaths: parsed.data.confirmedPaths,
            createdAt: now().toISOString(),
          });
          const published = await withAuthenticatedSession(
            async (client, accessToken) => {
              const remote = await client.getProject(accessToken, binding.remoteProjectId);
              validateRemoteBindingProject(remote, project.id);
              return client.publishProject(accessToken, {
                projectId: binding.remoteProjectId,
                projectRevision: remote.revision,
                idempotencyKey: randomUUID(),
                manifest: bundle.manifest,
                archive: bundle.archive,
              });
            },
          );
          const nextBinding = await bindings.recordPublish({
            localProjectId: project.id,
            serverOrigin: binding.serverOrigin,
            remoteProjectId: binding.remoteProjectId,
            remoteRevision: published.projectRevision,
            publishedVersionId: published.publishedVersionId,
            versionNumber: published.version.number,
            now: now().toISOString(),
          });
          return { binding: nextBinding, ...published };
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(201).json(result);
      } catch (error) {
        return sendCollaborationError(res, deps, error);
      }
    },
  );
}

function projectIdParam(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : '';
}

function remoteProjectIdParam(req: Request): string {
  return routeParam(req, 'remoteProjectId');
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : '';
}

function reviewContentType(remoteMimeType: string): string {
  const mimeType = remoteMimeType.split(';', 1)[0]?.trim().toLowerCase();
  switch (mimeType) {
    case 'text/html':
      return 'text/html; charset=utf-8';
    case 'text/css':
    case 'application/javascript':
    case 'text/javascript':
    case 'application/json':
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
    case 'image/svg+xml':
    case 'font/woff':
    case 'font/woff2':
    case 'application/font-woff':
    case 'audio/mpeg':
    case 'video/mp4':
      return mimeType;
    default:
      return 'application/octet-stream';
  }
}

async function withProjectOperation<T>(
  locks: Map<string, Promise<unknown>>,
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  locks.set(projectId, task);
  try {
    return await task;
  } finally {
    if (locks.get(projectId) === task) locks.delete(projectId);
  }
}

function createProjectIdempotencyKey(serverOrigin: string, localProjectId: string): string {
  return `desktop-create-${createHash('sha256')
    .update(`${serverOrigin}\0${localProjectId}`)
    .digest('hex')}`;
}

function validateRemoteBindingProject(
  project: {
    callerRole: 'owner' | 'reviewer';
    authorityMode: 'local-authoritative' | 'cloud-authoritative';
    sourceProjectId: string | null;
    status: 'active' | 'transfer_locked' | 'archived';
  },
  localProjectId: string,
): void {
  if (project.callerRole !== 'owner') {
    throw new CollaborationServerRequestError(
      403,
      'COLLABORATION_BINDING_FORBIDDEN',
      'Only the remote Project owner may bind a local editable Project',
    );
  }
  if (
    project.authorityMode !== 'local-authoritative'
    || project.sourceProjectId !== localProjectId
    || project.status !== 'active'
  ) {
    throw new CollaborationServerRequestError(
      409,
      'COLLABORATION_BINDING_CONFLICT',
      'Remote Project is not an active local-authoritative match for this local Project',
    );
  }
}

function reviewBatchScope(stored: {
  profile?: { origin: string };
  session?: { sessionId: string; user: { id: string } };
}): CollaborationReviewCommentBatchScope {
  if (!stored.profile) {
    throw new CollaborationServerRequestError(
      409,
      'COLLABORATION_SERVER_NOT_CONFIGURED',
      'Configure a Collaboration Server first',
    );
  }
  if (!stored.session) {
    throw new CollaborationServerRequestError(
      401,
      'COLLABORATION_AUTH_REQUIRED',
      'Sign in to the Collaboration Server first',
    );
  }
  return {
    serverOrigin: stored.profile.origin,
    sessionId: stored.session.sessionId,
    userId: stored.session.user.id,
  };
}

async function withAuthenticatedClient<T>(
  profiles: CollaborationServerProfileStore,
  reviewCommentBatches: CollaborationReviewCommentBatchStore,
  sessionRefreshes: Map<string, Promise<CollaborationStoredSession>>,
  clientFor: (origin: string) => CollaborationServerClient,
  now: () => Date,
  operation: (client: CollaborationServerClient, accessToken: string) => Promise<T>,
): Promise<T> {
  let stored = await profiles.readCredentials();
  if (!stored.profile) {
    throw new CollaborationServerRequestError(
      409,
      'COLLABORATION_SERVER_NOT_CONFIGURED',
      'Configure a Collaboration Server first',
    );
  }
  if (!stored.session) {
    throw new CollaborationServerRequestError(
      401,
      'COLLABORATION_AUTH_REQUIRED',
      'Sign in to the Collaboration Server first',
    );
  }

  const authenticatedStored: AuthenticatedStoredState = {
    profile: stored.profile,
    session: stored.session,
  };
  const client = clientFor(authenticatedStored.profile.origin);
  let session = authenticatedStored.session;
  if (session.accessExpiresAt <= now().getTime() + 30_000) {
    session = await refreshAuthenticatedSession(
      profiles,
      reviewCommentBatches,
      sessionRefreshes,
      client,
      authenticatedStored,
      now,
    );
  }

  try {
    return await operation(client, session.accessToken);
  } catch (error) {
    if (!isRemoteAuthenticationError(error)) throw error;
    session = await refreshAuthenticatedSession(
      profiles,
      reviewCommentBatches,
      sessionRefreshes,
      client,
      { ...authenticatedStored, session },
      now,
    );
    try {
      return await operation(client, session.accessToken);
    } catch (retryError) {
      if (isRemoteAuthenticationError(retryError)) {
        await clearRejectedSession(profiles, reviewCommentBatches, { ...authenticatedStored, session });
      }
      throw retryError;
    }
  }
}

async function refreshAuthenticatedSession(
  profiles: CollaborationServerProfileStore,
  reviewCommentBatches: CollaborationReviewCommentBatchStore,
  sessionRefreshes: Map<string, Promise<CollaborationStoredSession>>,
  client: CollaborationServerClient,
  stored: AuthenticatedStoredState,
  now: () => Date,
): Promise<CollaborationStoredSession> {
  const key = `${stored.profile.origin}\0${stored.session.sessionId}`;
  const active = sessionRefreshes.get(key);
  if (active) return active;

  const refresh = (async () => {
    const current = await profiles.readCredentials();
    if (!current.profile || current.profile.origin !== stored.profile.origin || !current.session) {
      throw new CollaborationServerRequestError(
        401,
        'COLLABORATION_AUTH_REQUIRED',
        'Sign in to the Collaboration Server again',
      );
    }
    const authenticatedCurrent: AuthenticatedStoredState = {
      profile: current.profile,
      session: current.session,
    };
    if (authenticatedCurrent.session.refreshToken !== stored.session.refreshToken) {
      return authenticatedCurrent.session;
    }
    try {
      const refreshedAt = now().getTime();
      const refreshed = await client.refresh(authenticatedCurrent.session.refreshToken);
      await profiles.setSession(refreshed, refreshedAt);
      return { ...refreshed, accessExpiresAt: refreshedAt + refreshed.expiresIn * 1_000 };
    } catch (error) {
      if (isRemoteAuthenticationError(error)) {
        await clearRejectedSession(profiles, reviewCommentBatches, authenticatedCurrent);
      }
      throw error;
    }
  })();
  sessionRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (sessionRefreshes.get(key) === refresh) sessionRefreshes.delete(key);
  }
}

async function clearRejectedSession(
  profiles: CollaborationServerProfileStore,
  reviewCommentBatches: CollaborationReviewCommentBatchStore,
  stored: AuthenticatedStoredState,
): Promise<void> {
  const cleared = await profiles.clearSessionIfMatches({
    sessionId: stored.session.sessionId,
    refreshToken: stored.session.refreshToken,
  });
  if (cleared) await reviewCommentBatches.clearSession(reviewBatchScope(stored));
}

function isRemoteAuthenticationError(error: unknown): error is CollaborationServerRequestError {
  return error instanceof CollaborationServerRequestError && error.status === 401;
}

function sendCollaborationError(
  res: Response,
  deps: RegisterCollaborationServerRoutesDeps,
  error: unknown,
): Response {
  if (error instanceof CollaborationServerRequestError) {
    const code = localErrorCode(error);
    return deps.sendApiError(res, error.status, code, error.message, {
      retryable: error.retryable,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
  }
  if (error instanceof CollaborationBundleError) {
    const status = error.code === 'COLLABORATION_BUNDLE_TOO_LARGE'
      ? 413
      : error.code === 'COLLABORATION_PUBLISH_CANDIDATE_CHANGED'
        ? 409
        : 422;
    return deps.sendApiError(res, status, error.code, error.message);
  }
  if (error instanceof CollaborationProjectBindingConflictError) {
    return deps.sendApiError(res, 409, 'CONFLICT', error.message);
  }
  if (error instanceof CollaborationReviewSnapshotError) {
    return deps.sendApiError(
      res,
      error.code === 'COLLABORATION_REVIEW_UNAVAILABLE' ? 404 : 422,
      error.code,
      error.message,
    );
  }
  return deps.sendApiError(
    res,
    500,
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : 'Collaboration operation failed',
  );
}

function localErrorCode(error: CollaborationServerRequestError): ApiErrorCode {
  switch (error.code) {
    case 'COLLABORATION_SERVER_NOT_CONFIGURED':
    case 'COLLABORATION_AUTH_REQUIRED':
    case 'COLLABORATION_SERVER_UNAVAILABLE':
    case 'COLLABORATION_SERVER_INCOMPATIBLE':
      return error.code;
    case 'INVALID_SERVER_ORIGIN':
      return 'BAD_REQUEST';
    default:
      if (error.status === 401) return 'COLLABORATION_AUTH_REQUIRED';
      if (error.status === 403) return 'FORBIDDEN';
      if (error.status === 404) return 'NOT_FOUND';
      if (error.status === 413) return 'PAYLOAD_TOO_LARGE';
      if (error.status === 409 || error.status === 412) return 'CONFLICT';
      return error.status >= 500 ? 'COLLABORATION_SERVER_UNAVAILABLE' : 'BAD_REQUEST';
  }
}
