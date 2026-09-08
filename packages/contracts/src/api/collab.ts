import type { ProjectMetadata } from './projects.js';

// Legacy Team-edition collaboration DTOs retained while the sync path is
// removed. New self-hosted collaboration contracts live under
// `api/collaboration`.

export type CollabMemberRole = 'owner' | 'admin' | 'member';

/** Temporary daemon-local state for the remaining legacy mirror transfer. */
export interface ProjectContentTransferState {
  status: 'downloading' | 'idle';
  version?: number;
  startedAt: number;
  updatedAt: number;
}

/**
 * A project shared to the caller's team, surfaced from the resource hub so a
 * member can discover + open projects the owner shared. `projectId` is the local
 * project id (the hub `project-` id prefix stripped) a member pulls then opens;
 * `ownerMemberId` is the member who shared it (its single writer); `sharedAt` is
 * when it was first shared (the hub resource's `createdAt`).
 */
export interface TeamProject {
  projectId: string;
  ownerMemberId: string;
  sharedAt: string;
  /** Display name stored on the team resource index; avoids pulling the tree just
   *  to render the team project card. */
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  metadata?: ProjectMetadata;
}

/**
 * GET /api/workspace/projects/team. Team-wide shared-project discovery: every
 * project any member shared to the team, read from the resource hub. A member's
 * own `/api/projects` list is only their LOCAL projects; team-shared projects
 * live on the hub until pulled. Empty off-team or when the hub is not configured.
 *
 * The web client polls this on an interval so teammates see each other's shares
 * without refreshing. Today the read is daemon-local (fast), so it just refetches
 * the whole list. Once D's directory service owns team visibility this read
 * proxies vela over the CLI — a slower cross-network call — and should gain a
 * cheap change probe (vela's version / last-modified) so the poll only pulls the
 * full list when it actually changed.
 */
export interface WorkspaceTeamProjectsResponse {
  projects: TeamProject[];
}

// Workspace context seam onto the B (identity/membership) + D (visibility)
// lanes. A faithful SUBSET of B's `CurrentWorkspaceContext`
// (vela packages/shared/src/workspace-context.ts) — the exact fields C needs to
// decide whether collab runs and who the present member is — so wiring B's real
// context in is a direct field pass-through. Field names mirror B verbatim.

export type WorkspaceType = 'personal' | 'team';
export type WorkspaceMemberStatus = 'active' | 'removed';
export type WorkspaceLifecycleState =
  | 'active'
  | 'billing_past_due'
  | 'locked'
  | 'deleting'
  | 'deleted';

/**
 * How the workspace pays for model calls. `platform_credits` is the AMR/vela
 * cloud path; `personal_byok` is the user's own key. This axis is ORTHOGONAL to
 * whether team collab is on — a `personal_byok` workspace still has full team
 * features (gate on {@link WorkspaceLifecycleState}/role, never on providerMode).
 * Mirrors B's `workspaceProviderMode` (vela packages/shared/src/workspace-context.ts).
 */
export type WorkspaceProviderMode = 'platform_credits' | 'personal_byok';

/** Billing truth (billing UI only). Mirrors B's `workspaceBillingState`. */
export type WorkspaceBillingState =
  | 'free'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'inactive'
  | 'locked';

/**
 * Permission bits — a verbatim mirror of B's `WorkspacePermissions`
 * (vela packages/shared/src/workspace-context.ts, `buildWorkspacePermissions`).
 * C surfaces CONSUME these to gate UI; never re-derive from role/lifecycle so the
 * two lanes cannot drift. `canWriteSyncedFiles` is the read-only gate for collab;
 * `canManageSharedResources`/`canShareProjects` gate resource sharing.
 */
export interface WorkspacePermissions {
  canManageMembers: boolean;
  canManageBilling: boolean;
  canInviteMembers: boolean;
  canManageAutoRecharge: boolean;
  canShareProjects: boolean;
  canWriteSyncedFiles: boolean;
  canViewWorkspaceSettings: boolean;
  canManageSharedResources: boolean;
}

/** Seat accounting summary. Mirrors B's `WorkspaceSeatSummary`. */
export interface WorkspaceSeatSummary {
  seatLimit: number;
  usedSeats: number;
  availableSeats: number;
  isSeatFull: boolean;
}

/**
 * Classify seat accounting from an authoritative capacity projection.
 *
 * Directory-only contexts use 0/0 as an unknown-capacity sentinel because the
 * membership directory does not carry billing seat counts. Consumers must not
 * interpret that synthetic summary as proof that the workspace is full.
 */
export function workspaceSeatCapacityState(
  summary: WorkspaceSeatSummary | null | undefined,
): 'available' | 'full' | 'unknown' {
  if (summary == null || (summary.seatLimit === 0 && summary.usedSeats === 0)) {
    return 'unknown';
  }
  return summary.isSeatFull ? 'full' : 'available';
}

/** Billing-recovery entry (locked/past-due). Mirrors B's `WorkspaceBillingRecovery`. */
export interface WorkspaceBillingRecovery {
  canEnterBillingRecovery: boolean;
  recoveryUrl: string | null;
}

/**
 * The one shared workspace context every workspace surface consumes. In
 * production the daemon resolves it from its local selection plus B's
 * authenticated membership directory; richer flows such as invite continuation
 * may populate the optional billing/display fields from a workspace-context
 * payload. `context` is null when signed out or B is unavailable.
 */
export interface WorkspaceCollabContext {
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceMemberId: string;
  role: CollabMemberRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
  billingState: WorkspaceBillingState;
  planId: string | null;
  providerMode: WorkspaceProviderMode;
  seatSummary: WorkspaceSeatSummary;
  permissions: WorkspacePermissions;
  billingRecovery?: WorkspaceBillingRecovery;
  /**
   * URL of the team's settings/management console on the cloud web app. Team
   * management (members, billing, dashboard) lives there — the local client only
   * links out to it; it does not embed those views. Absent for a personal
   * workspace or when the console URL is not resolvable.
   */
  workspaceSettingsUrl?: string;
  lastActiveWorkspaceId?: string;
  /** Team id — present for a team workspace, absent for a personal one. Lets the
   *  resource-hub principal derive from this one context (single identity source). */
  teamId?: string;
  /** Human-friendly team name for the workspace switcher (falls back to teamId). */
  teamName?: string;
  /**
   * B's display name for THIS workspace, whatever its type. Mirrors the
   * `workspaceName` in B's membership directory/context payloads and is
   * populated for personal workspaces too — vela derives "«owner»'s
   * workspace" for an unnamed one, and an owner may rename it outright.
   *
   * Distinct from `teamName` on purpose: `teamName` is the TEAM switcher's
   * field and stays absent for a personal workspace, so nothing may read it as
   * an "is a team" signal. Any surface that just wants to LABEL the current
   * workspace reads this one, and therefore gets a correct label from the
   * context the client already fetches at startup — without waiting on the
   * workspace-directory read that only happens when the switcher is opened.
   */
  workspaceName?: string;
  /** Display name for member identity surfaces (optional; falls back to the id). */
  displayName?: string;
  /** Signed-in user's profile image for identity surfaces such as project bylines. */
  avatarUrl?: string | null;
}

/**
 * GET /api/workspace/context. The daemon resolves the locally selected entry
 * through B's authenticated membership directory; `context` is null when the
 * caller is signed out or the directory is unavailable.
 */
export interface WorkspaceContextResponse {
  context: WorkspaceCollabContext | null;
}

/** A workspace visible to the signed-in Vela identity. Mirrors B's directory item. */
export interface WorkspaceDirectoryItem {
  workspaceId: string;
  workspaceName: string;
  workspaceIconKey?: string;
  workspaceType: WorkspaceType;
  workspaceMemberId: string;
  role: CollabMemberRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
}

/** GET /api/workspace/directory. OD's local workspace switcher data source. */
export interface WorkspaceDirectoryResponse {
  items: WorkspaceDirectoryItem[];
  /**
   * Last workspace deliberately selected by this client, when it is still a
   * visible membership. This is a restart bootstrap hint only; it must never
   * scope data-plane requests, which continue to carry an exact Workspace and
   * member identity.
   */
  activeWorkspaceId: string | null;
}

/**
 * PUT /api/workspace/active.
 * Verifies and resolves this tab's exact Workspace/member selection, then
 * persists the Workspace id as this client's next-start bootstrap hint. It
 * does not create implicit data-plane authority.
 */
export interface WorkspaceActiveRequest {
  workspaceId: string;
  workspaceMemberId: string;
}

export interface WorkspaceActiveResponse {
  /** The verified Workspace id persisted as the client's restart default. */
  activeWorkspaceId: string;
  context: WorkspaceCollabContext;
}

// —— Derivation helpers — a verbatim mirror of B's vela
// packages/shared/src/workspace-context.ts. Both the daemon's dev context stub
// and the real B proxy derive permissions/seat summary through these, so C never
// drifts from B's authorization rules. If B's helper changes, update here too.

export function isWorkspaceLifecycleReadable(state: WorkspaceLifecycleState): boolean {
  return state !== 'deleted';
}

/**
 * Whether a context can address the workspace resource hub.
 *
 * The hub keys every resource by a TEAM workspace: `teamId` is populated only
 * for `workspaceType === 'team'` (see the field's doc above), so a personal or
 * signed-out session has no id to push, snapshot, or redact under. Everything
 * built on the hub USED to be team-only by construction. That is still true of
 * team project SHARING, which needs teammates to share with — but no longer of
 * public single-file links: see {@link workspaceContextHasWorkspaceIdentity}.
 *
 * This is the ONE predicate both sides must agree on: the daemon refuses hub
 * writes when it is false, and the web UI must not render a hub-backed entry
 * point when it is false. Deriving it twice is how a UI grows a button that can
 * only ever fail.
 */
export function workspaceContextHasTeamIdentity(
  context: WorkspaceCollabContext | null | undefined,
): boolean {
  return Boolean(
    context &&
    context.workspaceType === 'team' &&
    context.workspaceId &&
    context.workspaceMemberId,
  );
}

/**
 * Whether this session can address a resource hub partition AT ALL.
 *
 * The hub addresses purely by workspace id, and B mints a principal for any
 * workspace a caller belongs to — a personal one included, where the principal's
 * `teamId` simply IS that workspace id, a partition of one. So the requirement
 * for a hub write is an id to publish under and a member id to own the result
 * with; the workspace TYPE is not part of it.
 *
 * Use this for surfaces that only need somewhere to put a resource — the public
 * single-file link is the one today. Use {@link workspaceContextHasTeamIdentity}
 * where the feature genuinely needs a TEAM, such as sharing a project with
 * teammates.
 *
 * Same rule as its sibling: the daemon refuses the write when this is false and
 * the web UI must not render the entry point when it is false. Deriving it twice
 * is how a UI grows a button that can only ever fail — which is exactly what
 * happened here before this helper existed.
 */
export function workspaceContextHasWorkspaceIdentity(
  context: WorkspaceCollabContext | null | undefined,
): boolean {
  return Boolean(context && context.workspaceId && context.workspaceMemberId);
}

export function isWorkspaceLifecycleWritable(state: WorkspaceLifecycleState): boolean {
  return state === 'active';
}

export function buildWorkspacePermissions(input: {
  role: CollabMemberRole;
  lifecycleState: WorkspaceLifecycleState;
  memberStatus?: WorkspaceMemberStatus;
}): WorkspacePermissions {
  const memberStatus = input.memberStatus ?? 'active';
  const readable =
    memberStatus === 'active' && isWorkspaceLifecycleReadable(input.lifecycleState);
  const writable =
    memberStatus === 'active' && isWorkspaceLifecycleWritable(input.lifecycleState);
  const isOwner = input.role === 'owner';
  const isAdmin = input.role === 'admin';
  return {
    canManageMembers: writable && (isOwner || isAdmin),
    canManageBilling: readable && isOwner,
    canInviteMembers: writable && (isOwner || isAdmin),
    canManageAutoRecharge: writable && isOwner,
    canShareProjects: writable,
    canWriteSyncedFiles: writable,
    canViewWorkspaceSettings: readable,
    canManageSharedResources: writable && (isOwner || isAdmin),
  };
}

export function buildWorkspaceSeatSummary(input: {
  seatLimit: number;
  usedSeats: number;
}): WorkspaceSeatSummary {
  const availableSeats = Math.max(input.seatLimit - input.usedSeats, 0);
  return {
    seatLimit: input.seatLimit,
    usedSeats: input.usedSeats,
    availableSeats,
    isSeatFull: availableSeats === 0,
  };
}
