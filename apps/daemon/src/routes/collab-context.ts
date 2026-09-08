import type { Express, Request, Response } from 'express';
import type {
  CollabCloudMemberDirectoryEntry,
  CollabCloudMembersResponse,
  TeamProject,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
  WorkspaceCollabContext,
  WorkspaceContextResponse,
  WorkspaceActiveResponse,
  WorkspaceTeamProjectsResponse,
} from '@open-design/contracts';
import { workspaceSeatCapacityState } from '@open-design/contracts';
import {
  parseWorkspaceCollabContext,
  type WorkspaceContextProvider,
} from '../collab/workspace-context.js';
import { createTeamProjectsLister } from '../collab/team-projects.js';
import {
  listVelaWorkspaceDirectory,
  workspaceContextFromDirectoryItem,
  type WorkspaceDirectoryFetchResult,
} from '../collab/vela-workspace-context.js';
import {
  verifyWorkspaceRequestContext,
  type VerifiedWorkspaceRequestContextResult,
} from '../collab/request-workspace-context.js';
import { sendApiError } from '../http/api-errors.js';

export interface RegisterCollabContextRoutesDeps {
  workspaceContext: WorkspaceContextProvider;
  /** Current settings-backed AMR environment for synthesized contexts. */
  configuredEnv?: () => Record<string, string>;
  /** Optional settled verifier for exact-scoped display GETs. Mutations retain
   * their fresh directory verification below. */
  verifyWorkspaceReadAuthority?: (
    req: Request,
  ) => Promise<VerifiedWorkspaceRequestContextResult>;
  /** Injectable for tests; defaults to the resource-hub team-project lister
   *  built from the same workspace context + env-configured hub client the share
   *  path uses. */
  listTeamProjects?: (context: WorkspaceCollabContext) => Promise<TeamProject[]>;
  /**
   * The team's collab-cloud member directory (memberId → {displayName, role}),
   * so the web client can resolve comment authors + the shared-project owner to
   * a name + role. Empty off-team / when the collab cloud is unconfigured. STUB:
   * B's roster is the real source; the collab-cloud directory stands in for it.
   */
  listMembers?: (
    context: WorkspaceCollabContext,
  ) => Promise<CollabCloudMemberDirectoryEntry[]>;
  /**
   * Client-local restart default. Data-plane routes never use it as authority;
   * each tab continues to carry its exact Workspace and member identity.
   */
  activeWorkspace?: {
    get(): string | null;
    set(workspaceId: string): Promise<void>;
    clear(): Promise<void>;
    clearIf(workspaceId: string): Promise<boolean>;
  };
  /**
   * Announce that one tab selected `workspaceId`, after a fresh membership
   * directory read confirms the exact Workspace/member pair.
   *
   * Caches are keyed by explicit scope, so this only warms the selected scope;
   * it never changes or checks daemon-global active/current state. It is
   * deliberately fire-and-forget: the response must not wait on warming.
   */
  onWorkspaceSwitched?: (workspaceId: string) => void;
  /** Injectable for tests; defaults to the Vela workspace directory API. */
  listWorkspaceDirectory?: () => Promise<WorkspaceDirectoryItem[]>;
  /**
   * Directory read with an authoritative-success bit. An unavailable backend
   * must never be collapsed into a confirmed empty membership list.
   */
  fetchWorkspaceDirectory?: () => Promise<WorkspaceDirectoryFetchResult>;
  /** Best-effort PostHog group update; never affects the route response. */
  observeWorkspace?: (
    req: Request,
    context: WorkspaceCollabContext,
    properties?: Record<string, unknown>,
  ) => Promise<void> | void;
}

/**
 * Enrichment may add billing and display metadata, but it must not rewrite the
 * exact Workspace authority already proven by the membership directory.
 */
function enrichVerifiedWorkspaceContext(
  verified: WorkspaceCollabContext,
  enriched: WorkspaceCollabContext | null | undefined,
): WorkspaceCollabContext {
  if (
    !enriched
    || enriched.workspaceId !== verified.workspaceId
    || enriched.workspaceMemberId !== verified.workspaceMemberId
  ) {
    return verified;
  }
  const { teamId: _enrichedTeamId, ...enrichedMetadata } = enriched;
  return {
    ...enrichedMetadata,
    workspaceId: verified.workspaceId,
    workspaceType: verified.workspaceType,
    workspaceMemberId: verified.workspaceMemberId,
    role: verified.role,
    memberStatus: verified.memberStatus,
    lifecycleState: verified.lifecycleState,
    permissions: verified.permissions,
    ...(verified.teamId ? { teamId: verified.teamId } : {}),
  };
}

function workspaceGroupProperties(
  context: WorkspaceCollabContext,
): Record<string, unknown> {
  const planId = context.planId?.trim().toLowerCase();
  const seatSummary = context.seatSummary;
  const seatState = workspaceSeatCapacityState(seatSummary);
  return {
    workspace_type: context.workspaceType,
    workspace_lifecycle: context.lifecycleState,
    billing_state: context.billingState,
    plan_bucket: !planId || planId === 'free' ? 'free' : 'paid',
    provider_mode: context.providerMode,
    ...(seatState !== 'unknown'
      ? {
          seat_limit: seatSummary.seatLimit,
          member_count: seatSummary.usedSeats,
        }
      : {}),
    seat_state: seatState,
  };
}

/**
 * Workspace-context route : the daemon's single B-integration seam. The
 * web client fetches an explicitly selected workspace context here to decide
 * whether collab runs and who the present member is (resolveCollabSession). In
 * production the provider proxies B; the dev provider is settable via PUT so a
 * demo/tools-dev run can exercise the full path before B is reachable.
 */
export function registerCollabContextRoutes(app: Express, deps: RegisterCollabContextRoutesDeps): void {
  const { workspaceContext } = deps;
  const configuredEnv = () => deps.configuredEnv?.() ?? {};
  const rawTeamProjectsLister = createTeamProjectsLister({});
  const listTeamProjects =
    deps.listTeamProjects ??
    ((context: WorkspaceCollabContext) => rawTeamProjectsLister(context.workspaceId));
  const listMembers = deps.listMembers ?? (async () => []);
  const listWorkspaceDirectory =
    deps.listWorkspaceDirectory ?? (() => listVelaWorkspaceDirectory());
  const fetchWorkspaceDirectory =
    deps.fetchWorkspaceDirectory ??
    (async (): Promise<WorkspaceDirectoryFetchResult> => ({
      ok: true,
      items: await listWorkspaceDirectory(),
    }));
  const sendWorkspaceVerificationFailure = (
    res: Response,
    verified: Exclude<
      VerifiedWorkspaceRequestContextResult,
      { ok: true }
    >,
  ) => verified.code === 'AGENT_AUTH_REQUIRED'
    ? sendApiError(res, verified.status, verified.code, verified.message, {
        retryable: false,
      })
    : res.status(verified.status).json({
        error: verified.code,
        message: verified.message,
        ...(verified.retryable ? { retryable: true } : {}),
      });

  app.get('/api/workspace/context', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const verified = deps.verifyWorkspaceReadAuthority
      ? await deps.verifyWorkspaceReadAuthority(req)
      : await verifyWorkspaceRequestContext({
          req,
          fetchWorkspaceDirectory,
          configuredEnv: configuredEnv(),
        });
    if (!verified.ok) return sendWorkspaceVerificationFailure(res, verified);
    const enriched = await workspaceContext.resolveExact?.({
      authorization,
      workspaceId: verified.context.workspaceId,
    }).catch(() => null);
    const context = enrichVerifiedWorkspaceContext(verified.context, enriched);
    const body: WorkspaceContextResponse = { context };
    void deps.observeWorkspace?.(req, context, workspaceGroupProperties(context));
    res.json(body);
  });

  app.get('/api/workspace/directory', async (req, res) => {
    const directory = await fetchWorkspaceDirectory().catch(
      (): WorkspaceDirectoryFetchResult => ({ ok: false, items: [] }),
    );
    if (!directory.ok) {
      if (directory.reason === 'unauthorized') {
        return sendApiError(
          res,
          401,
          'AGENT_AUTH_REQUIRED',
          'Workspace authorization expired. Sign in again to continue.',
          { retryable: false },
        );
      }
      return res.status(503).json({
        error: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
        message: 'workspace membership authority is temporarily unavailable',
        retryable: true,
      });
    }
    const items = directory.items;
    const claimed = await verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory: async () => directory,
      configuredEnv: configuredEnv(),
    });
    const savedWorkspaceId = deps.activeWorkspace?.get()?.trim() || null;
    const workspaceIsVisible = (workspaceId: string | null) => Boolean(
      workspaceId
      && items.some(
        (item) =>
          item.workspaceId === workspaceId
          && item.memberStatus === 'active'
          && item.lifecycleState !== 'deleted',
      ),
    );
    const savedWorkspaceIsVisible = workspaceIsVisible(savedWorkspaceId);
    if (savedWorkspaceId && !savedWorkspaceIsVisible) {
      await deps.activeWorkspace?.clearIf(savedWorkspaceId).catch(() => false);
    }
    const currentWorkspaceId = deps.activeWorkspace?.get()?.trim() || null;
    const currentWorkspaceIsVisible = workspaceIsVisible(currentWorkspaceId);
    let activeWorkspaceId = currentWorkspaceIsVisible ? currentWorkspaceId : null;
    if (claimed.ok) activeWorkspaceId = claimed.context.workspaceId;
    const body: WorkspaceDirectoryResponse = { items, activeWorkspaceId };
    res.json(body);
  });

  app.put('/api/workspace/active', async (req, res) => {
    const raw = req.body as { workspaceId?: unknown; workspaceMemberId?: unknown } | null;
    const workspaceId = typeof raw?.workspaceId === 'string' ? raw.workspaceId.trim() : '';
    const workspaceMemberId =
      typeof raw?.workspaceMemberId === 'string' ? raw.workspaceMemberId.trim() : '';
    if (!workspaceId) return res.status(400).json({ error: 'missing_workspace_id' });
    if (!workspaceMemberId) {
      return res.status(400).json({ error: 'missing_workspace_member_id' });
    }

    const directoryResult = await fetchWorkspaceDirectory().catch(
      (): WorkspaceDirectoryFetchResult => ({ ok: false, items: [] }),
    );
    if (!directoryResult.ok) {
      if (directoryResult.reason === 'unauthorized') {
        return sendApiError(
          res,
          401,
          'AGENT_AUTH_REQUIRED',
          'Workspace authorization expired. Sign in again to continue.',
          { retryable: false },
        );
      }
      return res.status(503).json({
        error: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
        message: 'workspace membership authority is temporarily unavailable',
        retryable: true,
      });
    }
    const directory = directoryResult.items;
    // A directory row only authorizes a switch while it is a LIVE membership.
    // Matching on the id alone would let a listed-but-removed membership (or a
    // deleted workspace) through, and this entry is also what gets synthesized
    // into the response below — so an unfiltered match could describe a
    // workspace the caller no longer holds. This matches the context provider's
    // directory-selection predicate.
    const selected = directory.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.workspaceMemberId === workspaceMemberId &&
        item.memberStatus === 'active' &&
        item.lifecycleState !== 'deleted',
    );
    if (!selected) {
      return res.status(404).json({ error: 'workspace_not_visible' });
    }

    // The membership directory above is the authorization. Persist the choice
    // only as this client's next-start default; data-plane routes continue to
    // require the exact Workspace/member pair on every request, so another tab
    // already operating in a different workspace keeps its own scope.
    //
    // This used to PUT B's account-level active workspace first and fail the
    // user's click (502) when that write did not take. That row is keyed by app
    // user, so it can only ever name ONE workspace for an account whose clients
    // are in different ones: every switch yanked the other clients' server-side
    // scope. Workspace now travels per request, which is what makes N tabs and
    // clients of one account independent.
    const authorization = req.header('authorization') ?? undefined;
    const context = typeof workspaceContext.resolveExact === 'function'
      ? await workspaceContext.resolveExact!({
          authorization,
          workspaceId,
        }).catch(() => null)
      : null;
    if (
      context
      && (
        context.workspaceId !== workspaceId
        || context.workspaceMemberId !== workspaceMemberId
      )
    ) {
      return res.status(404).json({ error: 'workspace_no_longer_available' });
    }
    const resolved = context ?? workspaceContextFromDirectoryItem(selected, configuredEnv());
    try {
      await deps.activeWorkspace?.set(workspaceId);
    } catch {
      return sendApiError(
        res,
        500,
        'INTERNAL_ERROR',
        'failed to persist the selected workspace',
      );
    }
    // Warm this exact workspace's cold caches before responding, but never
    // await them — a slow upstream must not delay the tab-local selection.
    deps.onWorkspaceSwitched?.(workspaceId);
    const body: WorkspaceActiveResponse = { activeWorkspaceId: workspaceId, context: resolved };
    void deps.observeWorkspace?.(req, resolved, workspaceGroupProperties(resolved));
    res.json(body);
  });

  // Team-wide shared-project discovery: the web "全部项目" view fetches every
  // project any member shared to the team here (read from the resource hub), so a
  // member whose own /api/projects list is empty still sees the owner's shared
  // projects to pull + open. A successful empty result is authoritative. A
  // transient upstream failure must stay distinguishable so clients can retain
  // their exact-scope last-good catalog instead of treating the outage as an
  // authoritative removal of every project.
  app.get('/api/workspace/projects/team', async (req, res) => {
    const verified = deps.verifyWorkspaceReadAuthority
      ? await deps.verifyWorkspaceReadAuthority(req)
      : await verifyWorkspaceRequestContext({
          req,
          fetchWorkspaceDirectory,
          configuredEnv: configuredEnv(),
          requireTeam: true,
        });
    if (!verified.ok) {
      return res.status(verified.status).json({
        error: verified.code,
        message: verified.message,
        ...(verified.retryable ? { retryable: true } : {}),
      });
    }
    if (verified.context.workspaceType !== 'team') {
      return res.status(403).json({
        error: 'WORKSPACE_ACCESS_DENIED',
        message: 'the requested workspace is not available to this member',
      });
    }
    let projects: TeamProject[];
    try {
      projects = await listTeamProjects(verified.context);
    } catch {
      return sendApiError(
        res,
        503,
        'UPSTREAM_UNAVAILABLE',
        'team project catalog is temporarily unavailable',
        { retryable: true },
      );
    }
    const body: WorkspaceTeamProjectsResponse = { projects };
    res.json(body);
  });

  // Member directory: the web client resolves comment authors (authorMemberId →
  // "琼羽 · Owner") and the shared-project owner name from this. Read from the
  // collab-cloud directory. A directory outage is retryable and must not be
  // represented as an authoritative empty roster: clients retain last-good
  // display metadata until a successful response says members really left.
  app.get('/api/workspace/members', async (req, res) => {
    const verified = deps.verifyWorkspaceReadAuthority
      ? await deps.verifyWorkspaceReadAuthority(req)
      : await verifyWorkspaceRequestContext({
          req,
          fetchWorkspaceDirectory,
          configuredEnv: configuredEnv(),
          requireTeam: true,
        });
    if (!verified.ok) return sendWorkspaceVerificationFailure(res, verified);
    if (verified.context.workspaceType !== 'team') {
      return sendWorkspaceVerificationFailure(res, {
        ok: false,
        status: 403,
        code: 'WORKSPACE_ACCESS_DENIED',
        message: 'the requested workspace is not available to this member',
      });
    }
    try {
      const members = await listMembers(verified.context);
      const body: CollabCloudMembersResponse = { members };
      return res.json(body);
    } catch {
      return sendApiError(
        res,
        503,
        'UPSTREAM_UNAVAILABLE',
        'team member directory is temporarily unavailable',
        { retryable: true },
      );
    }
  });

  // Dev/demo seam: override the in-memory context. A real B-backed provider does
  // not expose `set`, so this 404s in production instead of spoofing identity.
  app.put('/api/workspace/context', (req, res) => {
    if (!workspaceContext.set) {
      return res.status(404).json({ error: 'workspace context is not settable' });
    }
    const body = req.body as unknown;
    // `null` explicitly clears the context (sign-out / leave team).
    if (body === null || (body && typeof body === 'object' && Object.keys(body).length === 0)) {
      workspaceContext.set(null);
      const cleared: WorkspaceContextResponse = { context: null };
      return res.json(cleared);
    }
    const context = parseWorkspaceCollabContext(body);
    if (!context) return res.status(400).json({ error: 'invalid workspace context' });
    workspaceContext.set(context);
    const response: WorkspaceContextResponse = { context };
    res.json(response);
  });
}
