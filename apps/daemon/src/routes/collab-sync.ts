import type { Express, Request, Response } from 'express';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLIC_FILE_MANUAL_REVOKE_REQUIRED,
  workspaceContextHasWorkspaceIdentity,
  type PublicFileManualRevokeRequiredResponse,
  type PublicProjectFilePublication,
  type ProjectMetadata,
  type TeamProject,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import type {
  ProjectContentTransferToken,
} from '../collab/project-content-transfer-state.js';
import type {
  VerifiedWorkspaceRequestContextResult,
} from '../collab/request-workspace-context.js';
import type { CollabRuntime } from '../collab/runtime.js';
import {
  contextToResourceHubPrincipal,
  type ResourceHubPrincipal,
} from '../collab/resource-principal.js';
import { isUnmaterializedSharedPlaceholder } from '../collab/shared-project-placeholder.js';
import {
  parseVelaResourceSnapshot,
  runVelaResourceCommand,
} from '../collab/vela-cli-resource-adapter.js';
import {
  createInMemoryPublicFilePublicationStore,
  type PublicFilePublicationScope,
  type PublicFilePublicationStore,
} from '../collab/public-file-publication-store.js';
import { readVelaControlApiContext } from '../integrations/vela.js';
import { readProjectManifest } from '../project-locations.js';
import { redactSecrets } from '../redact.js';
import { findRealElementRange, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';

/** The fields register-on-pull reads out of a pulled project's manifest. */
export interface PulledProjectManifest {
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface RegisterPulledProjectInput {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata?: ProjectMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMirrorPullScope {
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
}

export interface PulledProjectStore {
  get?: (projectId: string) => { name?: string | null; metadata?: unknown } | null;
  has(projectId: string): boolean;
  register(input: RegisterPulledProjectInput): void;
  update?: (input: RegisterPulledProjectInput) => void;
  /**
   * Atomically materialize the project row and its active team binding, then
   * return only after a strict readback proves the mirror is mutation-gated.
   */
  materializeTeamMirror?: (
    input: RegisterPulledProjectInput,
    scope: TeamMirrorPullScope,
  ) => { localRecordChanged: boolean };
}

type CollabSyncPullTimingStatus =
  | 'pulled'
  | 'revoked'
  | 'register_failed'
  | 'threw';

export interface RegisterCollabSyncRoutesDeps {
  collab: Pick<CollabRuntime, 'pullLatest'>;
  resolveSharedProject?: (
    projectId: string,
    scope?: TeamMirrorPullScope | null,
  ) => Promise<TeamProject | null>;
  /**
   * Authorize the request's explicit Workspace selector against the signed-in
   * account's authoritative membership directory, then return the directory-
   * derived context. Client-supplied role/permission headers are never
   * authority. Null is a fail-closed denial.
   */
  verifyWorkspaceRequest?: (
    req: Request,
    projectId?: string,
  ) => Promise<
    | VerifiedWorkspaceRequestContextResult
    | WorkspaceCollabContext
    | null
  >;
  /**
   * Revalidate one already-captured Team pull scope against the authoritative
   * membership directory. This must address `scope.workspaceId` +
   * `scope.viewerMemberId` directly; it must not compare against the daemon's
   * mutable active Workspace.
   */
  verifyWorkspaceScope?: (scope: TeamMirrorPullScope) => Promise<boolean>;
  /** Set/clear the non-destructive "team mirror revoked" flag on a local
   *  project so read routes stop serving a project that has left the team. */
  markTeamProjectRevoked?: (projectId: string, revoked: boolean) => void;
  /**
   * Set/clear the `sharedProjectPlaceholderAt` stamp on a local project's
   * metadata (see collab/shared-project-placeholder.ts). Set when
   * `ensureSharedProjectPlaceholder` registers a placeholder record; cleared
   * exactly once a pull has materialized real hub content locally. While the
   * stamp is set, the publish paths refuse to treat the local copy as content
   * authority (the recvqzaDvUU6B3 fresh-install wipe guard).
   */
  markSharedProjectPlaceholder?: (projectId: string, placeholder: boolean) => void;
  projectStore?: PulledProjectStore;
  resolveProjectDir?: (projectId: string) => string | Promise<string>;
  /** Durable publication metadata used to restore public links after restart. */
  publicFilePublicationStore?: PublicFilePublicationStore;
  resolvePullDir?: (projectId: string) => string;
  /** Begin one exact-scope transfer generation after authorization resolves. */
  beginContentTransfer?: (
    projectId: string,
    scope: TeamMirrorPullScope,
    version?: number,
  ) => ProjectContentTransferToken;
  /** Only the matching exact-scope generation token may complete a transfer. */
  finishContentTransfer?: (
    projectId: string,
    scope: TeamMirrorPullScope,
    token: ProjectContentTransferToken,
    version?: number,
  ) => void;
  /** Persist the actual version after an explicit pull lands. */
  writeMaterializedVersion?: (
    projectId: string,
    scope: TeamMirrorPullScope,
    version: number,
  ) => void | Promise<void>;
  readManifest?: (projectDir: string) => Promise<PulledProjectManifest | null>;
  /**
   * Notify any live `/api/projects/:id/events` SSE subscribers that this
   * project's files changed on disk. Called after a successful
   * `POST /collab/pull` materializes new content.
   *
   * This is NOT redundant with the project's chokidar watcher: the `vela
   * resource pull` transport materializes a pulled project by replacing its
   * ENTIRE directory (a fresh inode every pull, confirmed via `stat` across
   * repeated pulls against a live resource-hub project) rather than updating
   * files in place. A chokidar watch established before that swap keeps
   * watching the OLD (now-orphaned) directory handle and silently stops
   * firing — so the member's own currently-open FileViewer tab never saw
   * `file-changed`, even though `/collab/status` and the file's bytes on disk
   * were both already correct (recvq6CIesNvWZ). Firing this explicit signal
   * right after the pull we know just landed sidesteps the swap entirely
   * instead of depending on chokidar surviving it.
   */
  notifyFilesChanged?: (projectId: string) => void;
  /**
   * Notify any live `/api/projects/:id/events` SSE subscribers that this
   * project's LOCAL record (name / skill / design-system) changed as part of
   * a pull. `registerPulledProject` is what replaces the "共享项目"
   * placeholder record with the real project name — but that write is
   * DB-only, and the only other post-pull signal (`notifyFilesChanged`)
   * refreshes the file list, never the project record. Without this signal a
   * member web that seeded its `projects` state from the placeholder keeps
   * rendering "共享项目" in the sidebar/tab until a full page reload
   * (recvqhwv6RPU1j). Wired to the existing `project-metadata-changed` thin
   * event; fired only when the pull actually registered or updated the local
   * record, so steady-state content pulls emit nothing.
   */
  notifyProjectMetadataChanged?: (projectId: string) => void;
  /** Opt-in, secret-free timing observer. It must not affect pull behavior. */
  onPullTiming?: (event: {
    phase:
      | 'route-started'
      | 'transport-invoke'
      | 'transport-done'
      | 'registration-prepared'
      | 'catalog-revalidated'
      | 'scope-revalidated'
      | 'mirror-materialized'
      | 'version-write-started'
      | 'persisted'
      | 'route-completed';
    projectId: string;
    version?: number;
    receivedAtMs?: number;
    atMs: number;
    status?: CollabSyncPullTimingStatus;
  }) => void;
}

/** Result of one legacy team-mirror materialization. */
export type CollabSyncPullOutcome =
  | { status: 'pulled'; version: number | null }
  | { status: 'revoked' }
  | { status: 'register_failed' };

/** Daemon-internal surface retained until team-mirror materialization is removed. */
export interface CollabSyncRoutesHandle {
  /**
   * Materialize the latest published content for a shared project using an
   * already-authorized daemon-owned scope. Concurrent pulls for the same
   * project and scope coalesce onto one in-flight materialization.
   */
  pullSharedProject(
    projectId: string,
    scope: TeamMirrorPullScope,
  ): Promise<CollabSyncPullOutcome>;
}

const PULLED_PROJECT_PLACEHOLDER_NAME = '共享项目';
const PUBLIC_FILE_RESOURCE_KIND = 'project';
const PUBLIC_FILE_REF = 'published';

const MAX_ERROR_LOG_FIELD_LENGTH = 2_048;

function redactedErrorLogText(value: unknown): string {
  const text = value instanceof Error
    ? value.message || value.name
    : String(value);
  return redactSecrets(text).slice(0, MAX_ERROR_LOG_FIELD_LENGTH);
}

function errorLogFields(error: unknown): {
  errorName: string;
  errorMessage: string;
  errorCause?: string;
} {
  const errorName = redactSecrets(
    error instanceof Error ? error.name : typeof error,
  ).slice(0, MAX_ERROR_LOG_FIELD_LENGTH);
  const errorMessage = redactedErrorLogText(error);
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  return {
    errorName,
    errorMessage,
    ...(cause == null
      ? {}
      : { errorCause: redactedErrorLogText(cause) }),
  };
}

function cleanPulledProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === 'index.html') return null;
  return trimmed;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function inferNameFromSkillManifest(projectDir: string): Promise<string | null> {
  const skillsDir = path.join(projectDir, '.od-skills');
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const manifest = await readJsonObject(path.join(skillsDir, entry, 'open-design.json'));
    const title = cleanPulledProjectName(manifest?.title);
    if (title) return title;
    const name = cleanPulledProjectName(manifest?.name);
    if (name) return name;
  }
  return null;
}

async function inferNameFromHtmlTitle(projectDir: string): Promise<string | null> {
  try {
    const html = await readFile(path.join(projectDir, 'index.html'), 'utf8');
    // The document's own <title>, not one an author stored in a script string
    // or an attribute (nexu-io/open-design#7410). Both ends are located by the
    // parser's rules: the open tag through `endOfTag`, so a `>` in a quoted
    // attribute cannot cut it short, and the close by the raw-text rule, so
    // `</title >` closes it while `</title-page>` does not.
    const range = findRealElementRange(html, HTML_TAG_PATTERNS.titleOpen, 'title');
    if (!range) return null;
    const raw = html.slice(range.contentStart, range.contentEnd);
    return cleanPulledProjectName(raw.replace(/<[^>]*>/g, ''));
  } catch {
    return null;
  }
}

async function resolvePulledProjectName(
  projectDir: string,
  manifest: PulledProjectManifest | null,
): Promise<string> {
  return cleanPulledProjectName(manifest?.name)
    ?? await inferNameFromSkillManifest(projectDir)
    ?? await inferNameFromHtmlTitle(projectDir)
    ?? PULLED_PROJECT_PLACEHOLDER_NAME;
}

function normalizePublicFilePath(raw: string): string | null {
  if (raw.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = raw
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  } catch {
    return null;
  }
  if (decoded.includes('\\')) return null;
  const normalized = decoded.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null;
  }
  return normalized;
}

async function resolvePublicSourceFile(projectDir: string, filePath: string): Promise<string> {
  const [projectRoot, candidate] = await Promise.all([
    realpath(projectDir),
    realpath(path.join(projectDir, filePath)),
  ]);
  const relative = path.relative(projectRoot, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return candidate;
  }
  const error = new Error('public file path escapes project root') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  throw error;
}

function publicFileResourceIdFor(
  projectId: string,
  filePath: string,
  principal: ResourceHubPrincipal,
): string {
  const scoped = Buffer.from(
    JSON.stringify([principal.teamId, principal.memberId, projectId, filePath]),
    'utf8',
  ).toString('base64url');
  return `project-file-${scoped}`;
}

function publicFilePublicationScope(
  projectId: string,
  filePath: string,
  principal: ResourceHubPrincipal,
): PublicFilePublicationScope {
  return {
    resourceTeamId: principal.teamId,
    ownerMemberId: principal.memberId,
    projectId,
    filePath,
  };
}

function encodePublicFileUrlPath(filePath: string): string {
  return filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * The 409 body for a public-file request that has no team workspace behind it.
 *
 * Public links are snapshots in the workspace resource hub, which only a team
 * workspace can address (`workspaceContextHasTeamIdentity`). A personal or
 * signed-out session — and a team session whose context read momentarily fails —
 * lands here. Ship a sentence alongside the code so every surface that is not
 * the web UI (the `od` CLI, embedding agents) states the reason instead of
 * echoing `WORKSPACE_IDENTITY_REQUIRED` at a human. The web UI localizes the
 * code itself; see `publicFilePublishFailureKey` in apps/web.
 */
function workspaceIdentityRequiredBody() {
  return {
    error: 'WORKSPACE_IDENTITY_REQUIRED',
    message:
      'Publishing a public link needs a signed-in workspace. Sign in to OpenDesign Cloud, ' +
      'or use Deploy to publish this file without one.',
  };
}

/**
 * Resource-hub principal for the PUBLIC SINGLE-FILE publish routes.
 *
 * These routes deliberately do NOT use `contextToResourceHubPrincipal`, which
 * requires `workspaceContextHasTeamIdentity` and is still exactly right for team
 * project sharing (a shared project needs teammates to share WITH).
 *
 * A public file link needs no such thing. The hub addresses purely by workspace
 * id, and B stopped refusing a personal workspace on its control-key auth path:
 * `authenticateSession` now mints a principal whose `teamId` IS the workspace id
 * — "a partition of one" — and `resolveAccess` only ever compares that id with
 * the resource's own. So the real requirement here is A workspace, not a TEAM
 * workspace: an id to publish under and a member id to own the resource with.
 *
 * A signed-out session still has neither, and is still refused — this widens the
 * gate, it does not remove it. The web UI must gate its entry point on the SAME
 * rule (`canPublishPublicFile` in apps/web/src/collab/public-file-publish.ts);
 * a button that renders where this returns 409 is the bug this pair exists to
 * prevent.
 */
function publicFilePrincipal(context: WorkspaceCollabContext | null): ResourceHubPrincipal | null {
  if (!workspaceContextHasWorkspaceIdentity(context) || !context) return null;
  // The predicate above already proved both ids are present; this is the type
  // narrowing TS needs, not a second copy of the rule.
  const { workspaceId, workspaceMemberId } = context;
  if (!workspaceId || !workspaceMemberId) return null;
  return {
    memberId: workspaceMemberId,
    // Personal workspaces carry no `teamId`; the workspace id is the scope.
    teamId: context.teamId ?? workspaceId,
    role: context.role,
    lifecycleState: context.lifecycleState,
    workspaceType: context.workspaceType,
  };
}

function publicResourceHubBaseUrl(): string | null {
  return readVelaControlApiContext()?.apiUrl?.trim() || process.env.OD_RESOURCE_HUB_URL?.trim() || null;
}

function publicSnapshotFileUrl(baseUrl: string, slug: string, filePath: string): string {
  const relative = `/api/v1/public/snapshots/${encodeURIComponent(slug)}/files/${encodePublicFileUrlPath(filePath)}`;
  return new URL(relative, baseUrl).toString();
}

async function resolveSharedProjectForPublicFile(
  resolveSharedProject: RegisterCollabSyncRoutesDeps['resolveSharedProject'],
  projectId: string,
  context: WorkspaceCollabContext,
  principal: ResourceHubPrincipal,
): Promise<{ ok: true; project: TeamProject | null } | { ok: false }> {
  try {
    return {
      ok: true,
      project: await resolveSharedProject?.(projectId, {
        workspaceId: context.workspaceId,
        resourceTeamId: principal.teamId,
        viewerMemberId: principal.memberId,
        // This is an ownership lookup, not a pull authorization witness. The
        // catalog result below supplies the authoritative owner.
        ownerMemberId: '',
      }) ?? null,
    };
  } catch (error) {
    console.warn('[od] failed to resolve public file project ownership:', error);
    return { ok: false };
  }
}

type RouteWorkspaceVerification =
  | { ok: true; context: WorkspaceCollabContext | null }
  | Exclude<VerifiedWorkspaceRequestContextResult, { ok: true }>;

function normalizeWorkspaceVerification(
  value:
    | VerifiedWorkspaceRequestContextResult
    | WorkspaceCollabContext
    | null,
): RouteWorkspaceVerification {
  if (value && 'ok' in value) return value;
  if (value) return { ok: true, context: value };
  // Legacy injected test adapters used null as a route-specific denial.
  // Production supplies the structured verifier result above.
  return { ok: true, context: null };
}

function sendWorkspaceVerificationFailure(
  res: Response,
  verification: Exclude<RouteWorkspaceVerification, { ok: true }>,
) {
  return res.status(verification.status).json({
    error: verification.code,
    message: verification.message,
    ...(verification.retryable ? { retryable: true } : {}),
  });
}

export function registerCollabSyncRoutes(
  app: Express,
  deps: RegisterCollabSyncRoutesDeps,
): CollabSyncRoutesHandle {
  const { pullLatest } = deps.collab;
  const {
    projectStore,
    resolveProjectDir,
    resolvePullDir,
    resolveSharedProject,
    markTeamProjectRevoked,
    markSharedProjectPlaceholder,
    notifyFilesChanged,
    notifyProjectMetadataChanged,
  } = deps;
  const readManifest = deps.readManifest ?? readProjectManifest;
  const publicFilePublicationStore =
    deps.publicFilePublicationStore
    ?? createInMemoryPublicFilePublicationStore();
  const reportPullTiming = (
    event: Parameters<NonNullable<RegisterCollabSyncRoutesDeps['onPullTiming']>>[0],
  ): void => {
    try {
      deps.onPullTiming?.(event);
    } catch {
      // Diagnostics are observational and must never affect pull behavior.
    }
  };

  async function verifyWorkspaceContextForRequest(
    req: Request,
    projectId?: string,
    verifier = deps.verifyWorkspaceRequest,
  ): Promise<RouteWorkspaceVerification> {
    if (!verifier) {
      return { ok: true, context: null };
    }
    try {
      return normalizeWorkspaceVerification(
        await verifier(req, projectId),
      );
    } catch {
      return {
        ok: false,
        status: 503,
        code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
        message: 'workspace membership authority is temporarily unavailable',
        retryable: true,
      };
    }
  }

  function verifiedWorkspaceContextForRequest(
    req: Request,
    projectId?: string,
  ): Promise<RouteWorkspaceVerification> {
    return verifyWorkspaceContextForRequest(
      req,
      projectId,
      deps.verifyWorkspaceRequest,
    );
  }

  async function canShareProjectsForRequest(
    req: Request,
    verifiedContext?: WorkspaceCollabContext | null,
  ): Promise<boolean> {
    const verification =
      verifiedContext === undefined
        ? await verifiedWorkspaceContextForRequest(req)
        : { ok: true as const, context: verifiedContext };
    const context = verification.ok ? verification.context : null;
    return context?.permissions.canShareProjects === true;
  }

  async function capturedScopeIsStillAuthorized(scope: TeamMirrorPullScope): Promise<boolean> {
    try {
      return await deps.verifyWorkspaceScope?.(scope) ?? false;
    } catch {
      return false;
    }
  }

  interface PreparedPulledProjectRegistration {
    existing: { name?: string | null } | null;
    fallbackName: string;
    manifest: PulledProjectManifest | null;
    now: number;
    projectId: string;
  }

  async function preparePulledProjectRegistration(
    projectId: string,
    scope: TeamMirrorPullScope | null,
    projectDirOverride?: string,
  ): Promise<PreparedPulledProjectRegistration | null> {
    if (!projectStore || !resolvePullDir) {
      if (scope) throw new Error('team mirror project store unavailable');
      return null;
    }
    const existing = projectStore.get?.(projectId);
    if (!scope) {
      if (!existing && projectStore.has(projectId)) return null;
      if (existing && cleanPulledProjectName(existing.name) !== PULLED_PROJECT_PLACEHOLDER_NAME) return null;
    }
    const projectDir = projectDirOverride ?? resolvePullDir(projectId);
    let manifest: PulledProjectManifest | null = null;
    try {
      manifest = await readManifest(projectDir);
    } catch {
      manifest = null;
    }
    return {
      existing: existing ?? null,
      fallbackName: await resolvePulledProjectName(projectDir, manifest),
      manifest,
      now: Date.now(),
      projectId,
    };
  }

  /**
   * Register/refresh the local project record for a just-pulled shared
   * project. This function is deliberately synchronous: a scoped caller does
   * its final authoritative catalog read and workspace-identity check
   * immediately before entering the SQLite transaction, with no ambient
   * metadata await able to reopen a workspace/unshare race in between.
   */
  function registerPreparedPulledProject(
    prepared: PreparedPulledProjectRegistration | null,
    scope: TeamMirrorPullScope | null,
    teamProject: TeamProject | null,
  ): boolean {
    if (!prepared || !projectStore) return false;
    const { existing, fallbackName, manifest, now, projectId } = prepared;
    const input = {
      id: projectId,
      name: cleanPulledProjectName(teamProject?.name) ?? fallbackName,
      skillId: teamProject?.skillId ?? manifest?.skillId ?? null,
      designSystemId: teamProject?.designSystemId ?? manifest?.designSystemId ?? null,
      ...(teamProject?.metadata ? { metadata: teamProject.metadata } : {}),
      createdAt: typeof teamProject?.createdAt === 'number'
        ? teamProject.createdAt
        : typeof manifest?.createdAt === 'number'
          ? manifest.createdAt
          : now,
      updatedAt: typeof teamProject?.updatedAt === 'number'
        ? teamProject.updatedAt
        : typeof manifest?.updatedAt === 'number'
          ? manifest.updatedAt
          : now,
    };
    if (scope) {
      if (!projectStore.materializeTeamMirror) {
        throw new Error('team mirror materializer unavailable');
      }
      return projectStore.materializeTeamMirror(input, scope).localRecordChanged;
    }
    if (existing) {
      if (!projectStore.update) return false;
      projectStore.update(input);
      return true;
    }
    projectStore.register(input);
    return true;
  }

  app.post(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    if (!projectId || !filePath) {
      return res.status(400).json({ error: 'invalid_file_path' });
    }
    const verification = await verifiedWorkspaceContextForRequest(req, projectId);
    if (!verification.ok) {
      return sendWorkspaceVerificationFailure(res, verification);
    }
    const verifiedContext = verification.context;
    const principal = publicFilePrincipal(verifiedContext);
    if (!verifiedContext || !principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req, verifiedContext)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(
      resolveSharedProject,
      projectId,
      verifiedContext,
      principal,
    );
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    const baseUrl = publicResourceHubBaseUrl();
    if (!baseUrl) {
      return res.status(502).json({ error: 'PUBLIC_FILE_URL_UNAVAILABLE' });
    }
    if (!resolveProjectDir) {
      return res.status(500).json({ error: 'PROJECT_DIR_UNAVAILABLE' });
    }

    const projectDir = await resolveProjectDir(projectId);
    let data: Buffer;
    try {
      const sourceFile = await resolvePublicSourceFile(projectDir, filePath);
      data = await readFile(sourceFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return res.status(code === 'ENOENT' ? 404 : 400).json({
        error: code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNAVAILABLE',
      });
    }

    const resourceId = publicFileResourceIdFor(projectId, filePath, principal);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'od-public-file-'));
    try {
      const targetFile = path.join(tempDir, filePath);
      await mkdir(path.dirname(targetFile), { recursive: true });
      await writeFile(targetFile, data);
      const metadata = {
        source: 'open-design',
        projectId,
        fileName: filePath,
      };
      await runVelaResourceCommand([
        'push',
        PUBLIC_FILE_RESOURCE_KIND,
        resourceId,
        tempDir,
        '--ref',
        PUBLIC_FILE_REF,
        '--metadata-json',
        JSON.stringify(metadata),
        '--json',
      ], principal.teamId);
      const snapshot = parseVelaResourceSnapshot(await runVelaResourceCommand([
        'snapshot',
        resourceId,
        '--ref',
        PUBLIC_FILE_REF,
        '--name',
        path.basename(filePath),
        '--json',
      ], principal.teamId));
      if (!snapshot) {
        return res.status(502).json({ error: 'PUBLIC_SNAPSHOT_UNAVAILABLE' });
      }
      const publication: PublicProjectFilePublication = {
        url: publicSnapshotFileUrl(baseUrl, snapshot.slug, filePath),
        slug: snapshot.slug,
        fileName: filePath,
      };
      try {
        publicFilePublicationStore.set(
          publicFilePublicationScope(projectId, filePath, principal),
          publication,
        );
      } catch (persistenceError) {
        try {
          await runVelaResourceCommand([
            'snapshot-redact',
            resourceId,
            snapshot.slug,
            '--json',
          ], principal.teamId);
        } catch (redactionError) {
          console.warn(
            '[od] failed to persist public project file publication; snapshot compensation also failed:',
            { persistenceError, redactionError },
          );
          const recoveryResponse = {
            error: {
              code: PUBLIC_FILE_MANUAL_REVOKE_REQUIRED,
              message:
                `The public link remains active at ${publication.url}. `
                + 'Run od project revoke-public-link with this project, file path, and URL.',
              data: {
                projectId,
                ...publication,
              },
            },
          } satisfies PublicFileManualRevokeRequiredResponse;
          return res.status(502).json(recoveryResponse);
        }
        throw persistenceError;
      }
      return res.json(publication);
    } catch (error) {
      console.warn('[od] failed to publish public project file:', error);
      return res.status(502).json({ error: 'PUBLIC_FILE_PUBLISH_UNAVAILABLE' });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.delete(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    const slug = typeof (req.body as { slug?: unknown } | undefined)?.slug === 'string'
      ? (req.body as { slug: string }).slug.trim()
      : '';
    if (!projectId || !filePath || !slug) {
      return res.status(400).json({ error: 'invalid_public_file' });
    }
    const verification = await verifiedWorkspaceContextForRequest(req, projectId);
    if (!verification.ok) {
      return sendWorkspaceVerificationFailure(res, verification);
    }
    const verifiedContext = verification.context;
    const principal = publicFilePrincipal(verifiedContext);
    if (!verifiedContext || !principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req, verifiedContext)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(
      resolveSharedProject,
      projectId,
      verifiedContext,
      principal,
    );
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    const resourceId = publicFileResourceIdFor(projectId, filePath, principal);
    try {
      await runVelaResourceCommand([
        'snapshot-redact',
        resourceId,
        slug,
        '--json',
      ], principal.teamId);
      publicFilePublicationStore.delete(
        publicFilePublicationScope(projectId, filePath, principal),
      );
      return res.json({ ok: true, slug, fileName: filePath });
    } catch (error) {
      console.warn('[od] failed to unpublish public project file:', error);
      return res.status(502).json({ error: 'PUBLIC_FILE_UNPUBLISH_UNAVAILABLE' });
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    if (!projectId || !filePath) {
      return res.status(400).json({ error: 'invalid_file_path' });
    }
    const verification = await verifiedWorkspaceContextForRequest(req, projectId);
    if (!verification.ok) {
      return sendWorkspaceVerificationFailure(res, verification);
    }
    const verifiedContext = verification.context;
    const principal = publicFilePrincipal(verifiedContext);
    if (!verifiedContext || !principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req, verifiedContext)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(
      resolveSharedProject,
      projectId,
      verifiedContext,
      principal,
    );
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    return res.json({
      publication: publicFilePublicationStore.get(
        publicFilePublicationScope(projectId, filePath, principal),
      ),
    });
  });

  /** Shared explicit-pull flow used by the HTTP route and local materialization. */
  async function pullSharedProjectOnce(
    projectId: string,
    principal: ResourceHubPrincipal | null,
    scope: TeamMirrorPullScope | null,
  ): Promise<CollabSyncPullOutcome> {
    reportPullTiming({
      phase: 'route-started',
      projectId,
      atMs: Date.now(),
    });
    let terminalStatus: 'pulled' | 'revoked' | 'register_failed' | 'threw' =
      'threw';
    let terminalVersion: number | undefined;
    const complete = (
      outcome: CollabSyncPullOutcome,
    ): CollabSyncPullOutcome => {
      terminalStatus = outcome.status;
      if (outcome.status === 'pulled' && outcome.version != null) {
        terminalVersion = outcome.version;
      }
      return outcome;
    };
    try {
      let authoritativeSharedProject: TeamProject | null = null;
      const initialSharedProjectRead = resolveSharedProject
        ? Promise.resolve()
            .then(() => resolveSharedProject(projectId, scope))
            .then(
              (project) => ({ ok: true as const, project }),
              () => ({ ok: false as const }),
            )
        : null;
      if (scope && !(await capturedScopeIsStillAuthorized(scope))) {
        return complete({ status: 'register_failed' });
      }
      if (initialSharedProjectRead) {
        let stillShared = true;
        const initialSharedProject = await initialSharedProjectRead;
        if (initialSharedProject.ok) {
          authoritativeSharedProject = initialSharedProject.project;
          stillShared = authoritativeSharedProject != null &&
            (!scope || authoritativeSharedProject.ownerMemberId === scope.ownerMemberId);
        } else if (scope) {
          return complete({ status: 'register_failed' });
        }
        if (scope && !(await capturedScopeIsStillAuthorized(scope))) {
          return complete({ status: 'register_failed' });
        }
        if (!stillShared) {
          markTeamProjectRevoked?.(projectId, true);
          return complete({ status: 'revoked' });
        }
      } else if (scope) {
        return complete({ status: 'register_failed' });
      }
    reportPullTiming({
      phase: 'transport-invoke',
      projectId,
      atMs: Date.now(),
    });
    let result: Awaited<ReturnType<typeof pullLatest>>;
    try {
      result = await pullLatest(projectId, principal);
    } catch (error) {
      reportPullTiming({
        phase: 'transport-done',
        projectId,
        atMs: Date.now(),
        status: 'threw',
      });
      throw error;
    }
    reportPullTiming({
      phase: 'transport-done',
      projectId,
      ...(result.version != null ? { version: result.version } : {}),
      atMs: Date.now(),
    });
    const materializedVersion = result.version;
    if (materializedVersion !== null) {
      let prepared: PreparedPulledProjectRegistration | null = null;
      try {
        prepared = await preparePulledProjectRegistration(projectId, scope);
      } catch (error) {
        console.warn('[od] failed to prepare pulled team project:', error);
        return complete({ status: 'register_failed' });
      }
      reportPullTiming({
        phase: 'registration-prepared',
        projectId,
        version: materializedVersion,
        atMs: Date.now(),
      });

      // The initial catalog result only authorized starting the transfer. The
      // owner may unshare while bytes are in flight, so scoped materialization
      // requires a second uncached authoritative read after every other async
      // metadata operation has completed.
      if (scope) {
        try {
          authoritativeSharedProject = await resolveSharedProject!(projectId, scope);
        } catch {
          return complete({ status: 'register_failed' });
        }
        if (!authoritativeSharedProject) {
          markTeamProjectRevoked?.(projectId, true);
          return complete({ status: 'revoked' });
        }
        if (authoritativeSharedProject.ownerMemberId !== scope.ownerMemberId) {
          return complete({ status: 'register_failed' });
        }
        reportPullTiming({
          phase: 'catalog-revalidated',
          projectId,
          version: materializedVersion,
          atMs: Date.now(),
        });
        // Keep this check adjacent to the synchronous SQLite transaction.
        // Nothing below may await before materializeTeamMirror revalidates the
        // binding and commits it.
        if (!(await capturedScopeIsStillAuthorized(scope))) {
          return complete({ status: 'register_failed' });
        }
        reportPullTiming({
          phase: 'scope-revalidated',
          projectId,
          version: materializedVersion,
          atMs: Date.now(),
        });
      } else if (resolveSharedProject) {
        try {
          authoritativeSharedProject = await resolveSharedProject(projectId, null);
        } catch {
          authoritativeSharedProject = null;
        }
      }

      let localRecordChanged = false;
      try {
        localRecordChanged = registerPreparedPulledProject(
          prepared,
          scope,
          authoritativeSharedProject,
        );
      } catch (error) {
        console.warn('[od] failed to register pulled team project:', error);
        return complete({ status: 'register_failed' });
      }
      reportPullTiming({
        phase: 'mirror-materialized',
        projectId,
        version: materializedVersion,
        atMs: Date.now(),
      });
      // Persist the exact version before notifying readers. A file-change
      // subscriber may immediately re-check /collab/status; it must never
      // observe the new bytes paired with the previous durable cursor.
      if (scope && deps.writeMaterializedVersion) {
        try {
          reportPullTiming({
            phase: 'version-write-started',
            projectId,
            version: materializedVersion,
            atMs: Date.now(),
          });
          await deps.writeMaterializedVersion(
            projectId,
            scope,
            materializedVersion,
          );
          reportPullTiming({
            phase: 'persisted',
            projectId,
            version: materializedVersion,
            atMs: Date.now(),
          });
        } catch (error) {
          console.warn('[od] failed to persist pulled team project version:', error);
          return complete({ status: 'register_failed' });
        }
      }
      // The pull already materialized new bytes on disk at this point —
      // notify now rather than relying on the project's chokidar watcher,
      // which the pull's directory-replace can silently orphan (see
      // `notifyFilesChanged`'s doc comment). A currently-open FileViewer tab
      // for this project refreshes on the same `file-changed` path a real
      // local edit would take.
      notifyFilesChanged?.(projectId);
      if (localRecordChanged) {
        // The register above swapped the "共享项目" placeholder record for
        // the real name (or first-registered the record): push the existing
        // `project-metadata-changed` thin signal so the open project view
        // re-reads the record and the sidebar/tab title follows without a
        // manual reload (recvqhwv6RPU1j).
        notifyProjectMetadataChanged?.(projectId);
      }
      // Real hub content is on disk and registered — the local record is no
      // longer an unmaterialized placeholder, so publishing may resume.
      markSharedProjectPlaceholder?.(projectId, false);
    }
    // A successful pull means the project is shared again (or still is): clear
    // any prior revocation so its files are served normally.
    markTeamProjectRevoked?.(projectId, false);
    return complete({ status: 'pulled', version: materializedVersion });
    } finally {
      reportPullTiming({
        phase: 'route-completed',
        projectId,
        ...(terminalVersion != null ? { version: terminalVersion } : {}),
        atMs: Date.now(),
        status: terminalStatus,
      });
    }
  }

  // In-flight explicit pulls coalesce by project + resource-hub scope. The
  // scope key includes the
  // principal's team + member ids because the same project can be shared
  // under more than one scope (see `scopedProjectKey` in collab/runtime.ts) —
  // only identically-routed pulls may share a result.
  const pullsInFlight = new Map<string, Promise<CollabSyncPullOutcome>>();
  const projectPullTails = new Map<string, Promise<void>>();

  function pullSharedProjectCoalesced(
    projectId: string,
    principal: ResourceHubPrincipal | null,
    scope: TeamMirrorPullScope | null,
  ): Promise<CollabSyncPullOutcome> {
    const mutationKey = JSON.stringify([
      projectId,
      principal?.teamId ?? null,
      principal?.memberId ?? null,
      scope?.workspaceId ?? null,
      scope?.resourceTeamId ?? null,
      scope?.viewerMemberId ?? null,
      scope?.ownerMemberId ?? null,
    ]);
    const key = mutationKey;
    const existing = pullsInFlight.get(key);
    if (existing) return existing;
    const transferToken = scope
      ? deps.beginContentTransfer?.(projectId, scope)
      : undefined;
    const previous = projectPullTails.get(projectId) ?? Promise.resolve();
    let run!: Promise<CollabSyncPullOutcome>;
    run = (async () => {
      let outcome: CollabSyncPullOutcome | null = null;
      try {
        await previous.catch(() => undefined);
        outcome = await pullSharedProjectOnce(projectId, principal, scope);
        return outcome;
      } finally {
        if (scope && transferToken) {
          deps.finishContentTransfer?.(
            projectId,
            scope,
            transferToken,
            outcome?.status === 'pulled' ? outcome.version ?? undefined : undefined,
          );
        }
        if (pullsInFlight.get(key) === run) {
          pullsInFlight.delete(key);
        }
      }
    })();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    projectPullTails.set(projectId, tail);
    void tail.finally(() => {
      if (projectPullTails.get(projectId) === tail) {
        projectPullTails.delete(projectId);
      }
    });
    pullsInFlight.set(key, run);
    return run;
  }

  return {
    async pullSharedProject(
      projectId: string,
      scope: TeamMirrorPullScope,
    ): Promise<CollabSyncPullOutcome> {
      const principal: ResourceHubPrincipal = {
        teamId: scope.resourceTeamId,
        memberId: scope.ownerMemberId,
        role: 'member',
        lifecycleState: 'active',
        workspaceType: 'team',
      };
      return pullSharedProjectCoalesced(
        projectId,
        principal,
        scope,
      );
    },
  };
}
