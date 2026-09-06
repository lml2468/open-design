import {
  CollaborationProblemSchema,
  CollaborationProjectSchema,
  CollaborationReviewBundleManifestSchema,
  CollaborationReviewCommentSchema,
  CollaborationReviewCommentsSchema,
  CollaborationReviewVersionListSchema,
  CollaborationReviewVersionSchema,
  CollaborationRemotePublishResultSchema,
  CollaborationRemoteProjectListSchema,
  CollaborationRemoteSessionSchema,
  CollaborationServerCapabilitiesSchema,
  type CollaborationProjectList,
  type CollaborationProject,
  type CollaborationReviewBundleManifest,
  type CollaborationReviewComment,
  type CollaborationReviewComments,
  type CollaborationReviewVersion,
  type CollaborationReviewVersionList,
  type CreateCollaborationReviewComment,
  type TransitionCollaborationReviewComment,
  type CollaborationRemotePublishResult,
  type CollaborationRemoteSession,
  type CollaborationServerCapabilities,
} from '@open-design/contracts';

type RuntimeSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class CollaborationServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CollaborationServerRequestError';
  }
}

export function normalizeCollaborationServerOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new CollaborationServerRequestError(400, 'INVALID_SERVER_ORIGIN', 'Server URL is invalid');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new CollaborationServerRequestError(
      400,
      'INVALID_SERVER_ORIGIN',
      'Server URL must be an origin without credentials, path, query, or fragment',
    );
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new CollaborationServerRequestError(
      400,
      'INVALID_SERVER_ORIGIN',
      'Server URL must use HTTPS except for loopback development',
    );
  }
  return parsed.origin;
}

export class CollaborationServerClient {
  constructor(
    readonly origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  getCapabilities(): Promise<CollaborationServerCapabilities> {
    return this.request('/api/v1/capabilities', CollaborationServerCapabilitiesSchema);
  }

  login(input: { email: string; password: string; deviceName: string }): Promise<CollaborationRemoteSession> {
    return this.request('/api/v1/auth/session', CollaborationRemoteSessionSchema, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  refresh(refreshToken: string): Promise<CollaborationRemoteSession> {
    return this.request('/api/v1/auth/session/refresh', CollaborationRemoteSessionSchema, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  }

  async logout(accessToken: string): Promise<void> {
    await this.requestEmpty('/api/v1/auth/session', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  listProjects(accessToken: string): Promise<CollaborationProjectList> {
    return this.request('/api/v1/projects', CollaborationRemoteProjectListSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  createProject(
    accessToken: string,
    input: { name: string; sourceProjectId: string },
    idempotencyKey: string,
  ): Promise<CollaborationProject> {
    return this.request('/api/v1/projects', CollaborationProjectSchema, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        name: input.name,
        authorityMode: 'local-authoritative',
        sourceProjectId: input.sourceProjectId,
      }),
    });
  }

  getProject(accessToken: string, projectId: string): Promise<CollaborationProject> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      CollaborationProjectSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  publishProject(
    accessToken: string,
    input: {
      projectId: string;
      projectRevision: number;
      idempotencyKey: string;
      manifest: unknown;
      archive: Buffer;
    },
  ): Promise<CollaborationRemotePublishResult> {
    const body = new FormData();
    body.append('manifest', JSON.stringify(input.manifest));
    body.append(
      'bundle',
      new Blob([new Uint8Array(input.archive)], { type: 'application/zip' }),
      'review-bundle.zip',
    );
    return this.request(
      `/api/v1/projects/${encodeURIComponent(input.projectId)}/publishes`,
      CollaborationRemotePublishResultSchema,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': input.idempotencyKey,
          'if-match': String(input.projectRevision),
        },
        body,
      },
    );
  }

  listVersions(accessToken: string, projectId: string): Promise<CollaborationReviewVersionList> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/versions`,
      CollaborationReviewVersionListSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  getPublishedVersion(
    accessToken: string,
    projectId: string,
  ): Promise<CollaborationReviewVersion> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/published`,
      CollaborationReviewVersionSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  getVersion(
    accessToken: string,
    projectId: string,
    versionId: string,
  ): Promise<CollaborationReviewVersion> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
      CollaborationReviewVersionSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  getVersionManifest(
    accessToken: string,
    projectId: string,
    versionId: string,
  ): Promise<CollaborationReviewBundleManifest> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/manifest`,
      CollaborationReviewBundleManifestSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  readVersionFile(
    accessToken: string,
    projectId: string,
    versionId: string,
    filePath: string,
  ): Promise<Buffer> {
    const query = new URLSearchParams({ path: filePath });
    return this.requestBytes(
      `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/file?${query}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  listComments(
    accessToken: string,
    projectId: string,
    versionId?: string,
  ): Promise<CollaborationReviewComments> {
    const query = versionId ? `?${new URLSearchParams({ versionId })}` : '';
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/comments${query}`,
      CollaborationReviewCommentsSchema,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  }

  createComment(
    accessToken: string,
    projectId: string,
    input: CreateCollaborationReviewComment,
    idempotencyKey: string,
  ): Promise<CollaborationReviewComment> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/comments`,
      CollaborationReviewCommentSchema,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
  }

  transitionComment(
    accessToken: string,
    projectId: string,
    commentId: string,
    input: TransitionCollaborationReviewComment,
  ): Promise<CollaborationReviewComment> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}/status`,
      CollaborationReviewCommentSchema,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'if-match': `"comment-${input.expectedRevision}"`,
        },
        body: JSON.stringify({
          status: input.status,
          ...(input.addressedInVersionId
            ? { addressedInVersionId: input.addressedInVersionId }
            : {}),
        }),
      },
    );
  }

  private async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw remoteError(response.status, payload);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new CollaborationServerRequestError(
        502,
        'COLLABORATION_SERVER_INCOMPATIBLE',
        'Collaboration Server returned an incompatible response',
      );
    }
    return parsed.data;
  }

  private async requestEmpty(path: string, init: RequestInit): Promise<void> {
    const response = await this.fetch(path, init);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw remoteError(response.status, payload);
    }
  }

  private async requestBytes(path: string, init: RequestInit): Promise<Buffer> {
    const response = await this.fetch(path, init);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw remoteError(response.status, payload);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      return await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (error instanceof CollaborationServerRequestError) throw error;
      throw new CollaborationServerRequestError(
        502,
        'COLLABORATION_SERVER_UNAVAILABLE',
        'Collaboration Server is unavailable',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function remoteError(status: number, payload: unknown): CollaborationServerRequestError {
  const problem = CollaborationProblemSchema.safeParse(payload);
  if (problem.success) {
    return new CollaborationServerRequestError(
      status,
      problem.data.code,
      problem.data.detail ?? problem.data.title,
      problem.data.retryable,
      problem.data.requestId,
    );
  }
  return new CollaborationServerRequestError(
    status,
    status === 401 ? 'COLLABORATION_AUTH_REQUIRED' : 'COLLABORATION_SERVER_UNAVAILABLE',
    status === 401 ? 'Collaboration Server authentication is required' : 'Collaboration Server request failed',
    status >= 500,
  );
}
