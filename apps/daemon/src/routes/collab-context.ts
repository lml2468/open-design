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
  WorkspaceInviteCreateResponse,
  WorkspaceInviteCreateResult,
  WorkspaceInviteRole,
  WorkspaceInvalidationSsePayload,
  WorkspaceTeamProjectsResponse,
} from '@open-design/contracts';
import { workspaceSeatCapacityState } from '@open-design/contracts';
import {
  parseWorkspaceCollabContext,
  type WorkspaceContextProvider,
} from '../collab/workspace-context.js';
import { createTeamProjectsLister } from '../collab/team-projects.js';
import {
  consumeInviteContinuation,
  type InviteContinueOutcome,
} from '../collab/invite-continue.js';
import {
  createWorkspaceInvite,
  type CreateInviteOutcome,
  type CreateWorkspaceInviteInput,
} from '../collab/invite-create.js';
import {
  listVelaWorkspaceDirectory,
  workspaceContextFromDirectoryItem,
  type WorkspaceDirectoryFetchResult,
} from '../collab/vela-workspace-context.js';
import {
  verifyWorkspaceRequestContext,
  type VerifiedWorkspaceRequestContextResult,
} from '../collab/request-workspace-context.js';
import { requestWithWorkspaceNavigationScope } from '../collab/workspace-resource-mutation.js';
import { sendApiError } from '../http/api-errors.js';

export type WorkspaceEventSink = (payload: WorkspaceInvalidationSsePayload) => void;
export type WorkspaceEventSinksByWorkspace =
  Map<string, Set<WorkspaceEventSink>>;

/**
 * Deliver one thin invalidation only to clients whose EventSource connection
 * was freshly verified for the affected Workspace. Member identity is still
 * verified at subscription time; delivery is workspace-wide because roster,
 * catalog and context changes legitimately invalidate every
 * active member's view of that Workspace.
 */
export function emitWorkspaceEventToScope(
  sinksByWorkspace: WorkspaceEventSinksByWorkspace,
  workspaceIdInput: string,
  payload: WorkspaceInvalidationSsePayload,
): boolean {
  const workspaceId = workspaceIdInput.trim();
  if (!workspaceId) return false;
  const sinks = sinksByWorkspace.get(workspaceId);
  if (!sinks || sinks.size === 0) return false;
  for (const sink of Array.from(sinks)) {
    try {
      sink(payload);
    } catch {
      sinks.delete(sink);
    }
  }
  if (sinks.size === 0) sinksByWorkspace.delete(workspaceId);
  return true;
}

/**
 * Deliver an account-level dirty signal through every already-authorized local
 * Workspace stream. The payload deliberately contains no Workspace id/content,
 * so this broad local nudge reveals no cross-workspace data; each browser then
 * re-reads the account directory through the daemon's current credential.
 */
export function emitWorkspaceEventToAllScopes(
  sinksByWorkspace: WorkspaceEventSinksByWorkspace,
  payload: Extract<
    WorkspaceInvalidationSsePayload,
    { type: 'workspace-directory-changed' }
  >,
): boolean {
  let emitted = false;
  for (const [workspaceId, sinks] of Array.from(sinksByWorkspace)) {
    for (const sink of Array.from(sinks)) {
      try {
        sink(payload);
        emitted = true;
      } catch {
        sinks.delete(sink);
      }
    }
    if (sinks.size === 0) sinksByWorkspace.delete(workspaceId);
  }
  return emitted;
}

export interface RegisterCollabContextRoutesDeps {
  workspaceContext: WorkspaceContextProvider;
  /** Current settings-backed AMR environment for synthesized contexts. */
  configuredEnv?: () => Record<string, string>;
  /** Optional settled verifier for exact-scoped display GETs. Mutations and
   * SSE subscriptions retain their fresh directory verification below. */
  verifyWorkspaceReadAuthority?: (
    req: Request,
  ) => Promise<VerifiedWorkspaceRequestContextResult>;
  /** Returns an exact, strict-SSE-backed membership only in adaptive mode.
   * Null preserves the legacy directory preflight byte-for-byte. */
  readCachedWorkspaceAuthority?: (
    req: Request,
    workspaceId: string,
  ) => WorkspaceCollabContext | null;
  /** Injectable for tests; defaults to consuming against B with the vela session. */
  consumeInvite?: (nonce: string) => Promise<InviteContinueOutcome>;
  /** Injectable for tests; defaults to creating invites on B with the vela session. */
  createInvite?: (input: CreateWorkspaceInviteInput) => Promise<CreateInviteOutcome>;
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
  /**
   * Force-refresh the membership authority after an invite continuation is
   * consumed. The consume mutates B before the daemon's settled directory
   * lease expires; refreshing here prevents the accepted Workspace from being
   * rejected by the next exact-scope request as a stale non-membership.
   */
  refreshWorkspaceDirectoryAfterMutation?: () => Promise<WorkspaceDirectoryFetchResult>;
  /**
   * Collab realtime hop-2 — the workspace-scoped invalidation SSE seams. When
   * both are provided the daemon registers `GET /api/workspace/events`; the route
   * adds its per-connection sink to `workspaceEventSinks` (fed by the
   * workspace-invalidation poller) and drops it on disconnect. Omitted in tests
   * that do not exercise the stream — the route then 404s cleanly.
   */
  createSseResponse?: (res: unknown, opts?: unknown) => {
    send: (event: string, data: unknown, id?: string | number | null) => boolean;
  };
  workspaceEventSinks?: WorkspaceEventSinksByWorkspace;
  /** Keep one upstream Vela carrier while this local Workspace SSE is open. */
  retainWorkspaceEventInterest?: (workspaceId: string) => () => void;
  /** Best-effort PostHog group update; never affects the route response. */
  observeWorkspace?: (
    req: Request,
    context: WorkspaceCollabContext,
    properties?: Record<string, unknown>,
  ) => Promise<void> | void;
}

const ASSIGNABLE_ROLES = new Set<WorkspaceInviteRole>(['admin', 'member']);

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
 * Normalize an invite-create request body into validated { email, role } items.
 * Accepts either the canonical `{ invites: [...] }` batch shape or a single
 * top-level `{ email, role }`. Rows without a non-empty email are dropped; a
 * missing/unknown role defaults to 'member' (never 'owner').
 */
function parseInviteCreateItems(
  body: unknown,
): Array<{ email: string; role: WorkspaceInviteRole }> {
  const raw = body as { invites?: unknown; email?: unknown; role?: unknown } | null;
  const source: unknown[] = Array.isArray(raw?.invites)
    ? raw!.invites
    : raw && typeof raw === 'object' && typeof raw.email === 'string'
      ? [raw]
      : [];
  const items: Array<{ email: string; role: WorkspaceInviteRole }> = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { email?: unknown; role?: unknown };
    if (typeof rec.email !== 'string') continue;
    const email = rec.email.trim();
    if (!email) continue;
    const role: WorkspaceInviteRole =
      typeof rec.role === 'string' && ASSIGNABLE_ROLES.has(rec.role as WorkspaceInviteRole)
        ? (rec.role as WorkspaceInviteRole)
        : 'member';
    items.push({ email, role });
  }
  return items;
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
  const consumeInvite = deps.consumeInvite ?? ((nonce: string) => consumeInviteContinuation(nonce, {
    configuredEnv: configuredEnv(),
  }));
  const createInvite =
    deps.createInvite ?? ((input: CreateWorkspaceInviteInput) => createWorkspaceInvite(input));
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

  // Desktop invite hand-off ("桌面唤起和本地恢复"): the desktop app parses the
  // opendesign:// invite deeplink and POSTs the nonce here. The daemon consumes
  // the one-time continuation on B with the signed-in vela session and returns
  // the resolved workspace context so the client can switch into the team
  // workspace. The nonce is single-use — B enforces subject match + one consume.
  app.post('/api/workspace/invite/continue', async (req, res) => {
    const body = req.body as { nonce?: unknown } | null;
    const nonce = body && typeof body.nonce === 'string' ? body.nonce : '';
    if (!nonce.trim()) return res.status(400).json({ error: 'missing_nonce' });
    const outcome = await consumeInvite(nonce);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    // Consuming the one-time nonce has already committed the membership on B.
    // Refresh the daemon's settled authority lease before the renderer makes
    // its first exact-scope read. A refresh outage must not turn a successfully
    // consumed, non-repeatable continuation into an HTTP failure.
    await deps.refreshWorkspaceDirectoryAfterMutation?.().catch(() => undefined);
    if (outcome.context) {
      void deps.observeWorkspace?.(
        req,
        outcome.context,
        workspaceGroupProperties(outcome.context),
      );
    }
    return res.json({ context: outcome.context, workspaceMemberId: outcome.workspaceMemberId });
  });

  // Invite CREATE (the inviter/host flow): the team switcher's "邀请同事" dialog
  // POSTs one or more { email, role } pairs here. The daemon derives the current
  // workspaceId from the caller's workspace context and creates each invite on B
  // with the signed-in vela session. Every outcome is typed: a missing session
  // 401s, a missing workspace 409s, and B's per-invite failures (including a 404
  // when B's create endpoint is absent locally) come back as `ok: false` results
  // — the endpoint never crashes on the backend being unavailable.
  app.post('/api/workspace/invite', async (req, res) => {
    const items = parseInviteCreateItems(req.body);
    if (items.length === 0) return res.status(400).json({ error: 'missing_invites' });

    const verified = await verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory,
      configuredEnv: configuredEnv(),
      requireTeam: true,
    });
    if (!verified.ok) return sendWorkspaceVerificationFailure(res, verified);
    const context = verified.context;
    const workspaceId = context.workspaceId;
    if (!context.permissions.canInviteMembers) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const results: WorkspaceInviteCreateResult[] = [];
    for (const item of items) {
      const outcome = await createInvite({ email: item.email, role: item.role, workspaceId });
      // The vela session is workspace-wide: if it is missing for one invite it is
      // missing for all, so short-circuit to a single 401 instead of N failures.
      if (!outcome.ok && outcome.error === 'no_session') {
        return res.status(401).json({ error: 'no_session' });
      }
      results.push(
        outcome.ok
          ? { email: item.email, ok: true, inviteId: outcome.inviteId }
          : { email: item.email, ok: false, error: outcome.error },
      );
    }
    const body: WorkspaceInviteCreateResponse = { results };
    return res.json(body);
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

  // Collab realtime hop-2: workspace-scoped invalidation SSE. Browser-owned
  // EventSource cannot send custom headers, so it carries the exact
  // Workspace/member pair in the navigation query. The pair is promoted to
  // the normal request-header shape, freshly directory-verified, then used
  // only to select the sink partition; authority-bearing role/lifecycle bits
  // always come from the verified directory context.
  //
  // Carries thin
  // `WorkspaceInvalidationSsePayload` signals (`team-projects-changed`,
  // `members-changed`, `workspace-context-changed`); the web
  // re-fetches the affected resource on receipt. Modeled on the project events
  // SSE (`/api/projects/:id/events`): one flat sink set, dropped on disconnect
  // via `res.on('close')`. No event buffer — a disconnect gap is closed by the
  // client's reconnect snapshot re-fetch, not a server-side replay.
  const { createSseResponse, workspaceEventSinks } = deps;
  if (createSseResponse && workspaceEventSinks) {
    app.get('/api/workspace/events', async (req, res) => {
      const scopedRequest = requestWithWorkspaceNavigationScope(req);
      if (scopedRequest === 'conflict') {
        res.status(400).json({
          error: 'WORKSPACE_CONTEXT_CONFLICT',
          message: 'workspace header and navigation scope must match',
        });
        return;
      }
      const verified = await verifyWorkspaceRequestContext({
        req: scopedRequest,
        fetchWorkspaceDirectory,
        configuredEnv: configuredEnv(),
      });
      if (!verified.ok) {
        sendWorkspaceVerificationFailure(res, verified);
        return;
      }
      const workspaceId = verified.context.workspaceId;
      const sse = createSseResponse(res);
      const sink: WorkspaceEventSink = (payload) => {
        const type =
          payload && typeof payload === 'object' && 'type' in payload
            ? String((payload as { type: unknown }).type)
            : 'message';
        sse.send(type, payload);
      };
      let workspaceSinks = workspaceEventSinks.get(workspaceId);
      if (!workspaceSinks) {
        workspaceSinks = new Set();
        workspaceEventSinks.set(workspaceId, workspaceSinks);
      }
      workspaceSinks.add(sink);
      const releaseWorkspaceEventInterest =
        deps.retainWorkspaceEventInterest?.(workspaceId) ?? (() => undefined);
      // Handshake so the client treats the stream as live and resets its
      // reconnect backoff immediately (mirrors the project stream's `ready`).
      sse.send('ready', { at: Date.now() });
      const cleanup = () => {
        workspaceSinks?.delete(sink);
        if (workspaceSinks?.size === 0) {
          workspaceEventSinks.delete(workspaceId);
        }
        releaseWorkspaceEventInterest();
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);
    });
  }

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
