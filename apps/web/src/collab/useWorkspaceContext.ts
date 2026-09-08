import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkspaceCollabContext,
  WorkspaceContextResponse,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
} from '@open-design/contracts';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
} from '@open-design/contracts';
import { coalescedGet, forceCoalescedGet } from '../lib/coalesced-get';
import { BackoffController, type BackoffOptions } from '../lib/backoff';
import {
  advanceWorkspaceAccountGeneration,
  beginWorkspaceScopedRead,
  currentWorkspaceAccountGeneration,
  resetWorkspaceAccountGeneration,
  workspaceIdentityCacheKey,
  type WorkspaceResourceReadIdentity,
} from './workspace-identity';

// One shared read of the workspace context (`GET /api/workspace/context`) for the
// navigation shell. The daemon proxies B's `CurrentWorkspaceContext`; `context`
// is non-null for both personal and team workspaces when the local AMR identity
// is available, and null when signed out / offline / B unavailable. Every
// workspace surface in the entry shell consumes THIS one read so the shell never
// re-derives role/permission judgements or fans out duplicate fetches. See
// `packages/contracts/src/api/collab.ts` for the shape.
export interface WorkspaceContextState {
  context: WorkspaceCollabContext | null;
  /** Monotonic browser boundary for sign-in/sign-out account changes. */
  accountGeneration?: number;
  /**
   * Exact directory-backed identity that read-only Workspace catalogs may use
   * while the richer `/api/workspace/context` projection is still loading.
   *
   * This is deliberately separate from `context`: writes, runs, comments and
   * project mutations must continue to wait for the fully verified context.
   * The provisional value is only published when this tab's session selection
   * has an exact active row in the current account directory.
   */
  resourceReadIdentity?: WorkspaceResourceReadIdentity | null;
  loading: boolean;
  /**
   * A deliberate identity change was announced, but its replacement context has
   * not resolved yet. Consumers of workspace-owned data must hide the previous
   * identity's snapshot during this window even though `context` intentionally
   * stays available to avoid flashing the whole shell signed out.
   */
  identityChangePending?: boolean;
  /**
   * `unsupported` is an old daemon with no workspace endpoint and retains the
   * legal pre-workspace/headerless behavior. `unavailable` means a modern
   * workspace answer is unknown; write paths must fail closed instead of
   * treating that outage as an anonymous identity.
   */
  failure?: 'unsupported' | 'unavailable' | 'reauth-required';
}

/**
 * Exact identity for read-only Workspace resources.
 *
 * Production providers always publish `resourceReadIdentity`; when it is
 * present, its null value is meaningful and must fail closed instead of
 * falling back to a stale richer context during a Workspace switch. The
 * `undefined` compatibility lane is only for older test/provider doubles.
 */
export function workspaceResourceReadContext(
  state: WorkspaceContextState,
): WorkspaceCollabContext | null {
  if (state.resourceReadIdentity !== undefined) {
    return state.resourceReadIdentity?.context ?? null;
  }
  return state.context;
}

/**
 * The identity a per-caller read cache must be keyed on.
 *
 * `coalescedGet` / `sharedCancellableGet` are CACHES (1s share window) as well as
 * single-flight dedupers, so any read whose answer depends on WHO is asking must
 * put that identity in its key or the previous identity's answer is served to the
 * next one.
 *
 * This is the shared resource-read key tuple — workspace, member, role, member
 * status, lifecycle — plus workspace type and the two permission bits, so it
 * digests EXACTLY the eight fields `workspaceProjectHeaders` puts on the wire.
 * A key coarser than the request it caches is the bug this helper exists to
 * prevent; a key that changes for a field the request does not carry would only
 * cost a redundant fetch.
 *
 * Deliberately excludes plan and lifecycle metadata (`planId`, `billingState`,
 * `seatSummary`, ...): they ride along in the context response but no resource
 * request is scoped by them, so keying on them would cause redundant reads.
 *
 * Returns `'none'` for a caller with no resolved workspace identity, which is a
 * distinct cache partition from any real one, not a wildcard that matches them.
 */
export { workspaceIdentityCacheKey } from './workspace-identity';

/**
 * One workspace-scoped read: the identity it was issued for, plus the check that
 * must pass before its response may be committed.
 *
 * Keying a request (or its `coalescedGet` entry) by identity stops the WRONG
 * IDENTITY BEING SERVED an answer fetched for someone else. It does nothing
 * about the other direction: a read issued for identity A resolves later, and by
 * then the caller may be identity B. Committing that late answer restores A's
 * data under B — the exact staleness the identity keys exist to prevent,
 * arriving through the back door. Reverse-order completion is not exotic here;
 * a workspace switch is precisely when one read is in flight and another starts.
 *
 * So every workspace-scoped read follows the same four steps:
 *
 *   const read = beginWorkspaceScopedRead(contextRef.current);
 *   const data = await fetchSomething(read.context);
 *   if (!read.isStillCurrent(contextRef.current)) return;   // ← the invariant
 *   commit(data);
 *
 * Two rules make it actually hold:
 *
 *  1. Request with `read.context`, never with the caller's own variable, so the
 *     request and the guard can never disagree about whose data was asked for.
 *  2. Compare against a REF, never a closed-over prop or state value. A closure
 *     captures the identity the read was issued for, so comparing against it
 *     always succeeds and guards nothing.
 *
 * This is the cross-component form of the `requestEpochRef` ordering guard
 * `useWorkspaceContext` already applies to its own read; identity is the right
 * discriminator for reads that are scoped BY identity.
 */
export { beginWorkspaceScopedRead } from './workspace-identity';
export type { WorkspaceScopedRead } from './workspace-identity';

/**
 * `GET /api/workspace/context` is the read that ESTABLISHES the caller's
 * identity, so — unlike every other workspace read — it cannot be keyed on the
 * identity it is fetching, and it takes no workspace argument the key could
 * borrow instead (the switch is a separate `PUT /api/workspace/active`).
 *
 * What it CAN be keyed on is which identity generation the caller is asking
 * about. This token names that generation: it advances once per deliberate
 * identity change (a workspace switch or a sign-in) and never on ambient
 * revalidation, so:
 *
 *  - Every mounted consumer reacting to ONE broadcast computes the same token
 *    and shares one request — the thundering herd `forceCoalescedGet` exists to
 *    prevent stays prevented.
 *  - Two switches inside that 250ms burst window are two generations, so the
 *    second is no longer mistaken for a second consumer of the first and served
 *    the answer fetched for the workspace the user already left.
 *
 * Cross-tab, the token is the shared `localStorage` stamp the acting tab wrote,
 * so every listening consumer in a passive tab advances to the SAME value and
 * still collapses to one request.
 */
let workspaceContextRequestToken = 'initial';
let localIdentityChangeSeq = 0;

function advanceWorkspaceContextRequestToken(sharedToken?: string | null): void {
  const next = sharedToken?.trim() || `local:${++localIdentityChangeSeq}`;
  if (next === workspaceContextRequestToken) return;
  workspaceContextRequestToken = next;
  // Any seed belonged to the generation just retired; a later generation must
  // never adopt it (see `seededWorkspaceContext`).
  seededWorkspaceContext = null;
}

/** Coalescing key for `GET /api/workspace/context`: this read alone, partitioned
 *  by the identity generation above. */
function workspaceContextCoalesceKey(): string {
  return `workspace-context:${workspaceContextRequestToken}`;
}

/**
 * The LIVE identity generation token. A cached workspace context is stamped
 * with the token it was resolved under (see `resourceReadIdentity.generation`);
 * a write path compares that stamp against this live value to decide whether a
 * retained (last-good) context still belongs to the current identity, rather
 * than trusting a possibly-stale `identityChangePending` snapshot. See
 * `resolvedWorkspaceContextForWrite` in `state/projects.ts`.
 */
export function currentWorkspaceContextRequestToken(): string {
  return workspaceContextRequestToken;
}

async function fetchWorkspaceDirectory(): Promise<WorkspaceDirectoryResponse> {
  const response = await fetch('/api/workspace/directory', { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`workspace-directory ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as WorkspaceDirectoryResponse;
}

/**
 * Read the signed-in account's Workspace directory for the current identity
 * generation.
 *
 * The shell context bootstrap and a fresh project deep link both need this
 * same answer. Keeping the read behind one generation-keyed single flight lets
 * a project derive its persisted Workspace/member authority as soon as the
 * directory lands, without waiting for the slower ambient
 * `/api/workspace/context` projection and without issuing a second directory
 * request.
 */
export function readWorkspaceDirectoryForCurrentGeneration(
  options: { fresh?: boolean } = {},
): Promise<WorkspaceDirectoryResponse> {
  const key = `workspace-directory-selection:${workspaceContextRequestToken}`;
  return options.fresh
    ? forceCoalescedGet(key, fetchWorkspaceDirectory)
    : coalescedGet(key, fetchWorkspaceDirectory);
}

function billingStateFromLifecycle(
  lifecycleState: WorkspaceDirectoryItem['lifecycleState'],
): WorkspaceCollabContext['billingState'] {
  switch (lifecycleState) {
    case 'active':
      return 'active';
    case 'billing_past_due':
      return 'past_due';
    case 'locked':
      return 'locked';
    default:
      return 'inactive';
  }
}

/**
 * Build the exact request identity carried by a Workspace directory item.
 *
 * Directory items deliberately omit billing detail, but they contain every
 * authority field used by Workspace-owned resource requests. The permission
 * projection is shared with the daemon so derived identities stay stable.
 */
export function workspaceContextFromDirectoryItem(
  item: WorkspaceDirectoryItem,
): WorkspaceCollabContext {
  const context: WorkspaceCollabContext = {
    workspaceId: item.workspaceId,
    workspaceType: item.workspaceType,
    workspaceMemberId: item.workspaceMemberId,
    role: item.role,
    memberStatus: item.memberStatus,
    lifecycleState: item.lifecycleState,
    billingState: billingStateFromLifecycle(item.lifecycleState),
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 0, usedSeats: 0 }),
    permissions: buildWorkspacePermissions({
      role: item.role,
      lifecycleState: item.lifecycleState,
      memberStatus: item.memberStatus,
    }),
    workspaceName: item.workspaceName,
  };
  if (item.workspaceType === 'team') {
    context.teamId = item.workspaceId;
    context.teamName = item.workspaceName;
  }
  return context;
}

/**
 * Resolve one persisted project Workspace from the account directory. This
 * never reads or mutates the shell's current/default Workspace.
 */
export async function resolveBoundProjectWorkspaceContext(
  workspaceId: string,
  options: { fresh?: boolean } = {},
): Promise<WorkspaceCollabContext | null> {
  const requestedWorkspaceId = workspaceId.trim();
  if (!requestedWorkspaceId) return null;
  const directory = await readWorkspaceDirectoryForCurrentGeneration(options);
  const item = (directory.items ?? []).find(
    (candidate) =>
      candidate.workspaceId === requestedWorkspaceId
      && candidate.workspaceMemberId.trim().length > 0
      && candidate.memberStatus === 'active'
      && candidate.lifecycleState !== 'deleted',
  );
  return item ? workspaceContextFromDirectoryItem(item) : null;
}

export interface CurrentWorkspaceContextReadWitness {
  context: WorkspaceCollabContext | null;
  isStillCurrent: () => boolean;
}

function createCurrentWorkspaceContextReadWitness(
  context: WorkspaceCollabContext | null,
  requestToken: string,
  accountGeneration: number,
): CurrentWorkspaceContextReadWitness {
  const selectedWorkspaceId = context?.workspaceId ?? null;
  const selectedWorkspaceMemberId = context?.workspaceMemberId ?? null;
  return {
    context,
    isStillCurrent: () => {
      if (
        workspaceContextRequestToken !== requestToken
        || currentWorkspaceAccountGeneration() !== accountGeneration
      ) return false;
      const currentSelection = readWorkspaceSelectionResult();
      // The directory-backed identity remains authoritative in memory when a
      // privacy-restricted browser disables sessionStorage. An available
      // store still guards explicit tab selection changes below.
      if (!currentSelection.available) return true;
      return context
        ? currentSelection.selection?.workspaceId === selectedWorkspaceId
          && currentSelection.selection.workspaceMemberId === selectedWorkspaceMemberId
        : currentSelection.selection === null;
    },
  };
}

/**
 * Reuse the identity last established by the directory-backed shell state.
 * This is the steady-state submit path: no new directory request is needed.
 * The witness protects the client from local account/selection races; mutation
 * routes still perform the final authorization check in the daemon.
 */
export function workspaceContextReadWitnessFromState(
  state: Pick<WorkspaceContextState, 'resourceReadIdentity'>,
): CurrentWorkspaceContextReadWitness | null {
  const identity = state.resourceReadIdentity;
  if (!identity || identity.generation !== workspaceContextRequestToken) return null;
  const witness = createCurrentWorkspaceContextReadWitness(
    identity.context,
    identity.generation,
    currentWorkspaceAccountGeneration(),
  );
  return witness.isStillCurrent() ? witness : null;
}

/**
 * Resolve the Workspace selected by this browser tab from the account
 * directory, without waiting for the shell's richer `/workspace/context`
 * projection to commit to React state.
 *
 * This is a client-side selection witness, not the final authorization check:
 * the directory read identifies the exact Workspace/member pair and the
 * returned lifetime closes over both the account/context generation and the
 * tab-local selection. A concurrent sign-in or Workspace switch therefore
 * invalidates an in-flight project action before it may commit; mutation
 * routes independently re-authorize the claimed pair in the daemon.
 */
export async function resolveCurrentWorkspaceContextReadWitness(
  options: { fresh?: boolean } = {},
): Promise<CurrentWorkspaceContextReadWitness> {
  const requestToken = workspaceContextRequestToken;
  const accountGeneration = currentWorkspaceAccountGeneration();
  const directory = await readWorkspaceDirectoryForCurrentGeneration(options);
  const selected = chooseWorkspaceForTab(
    directory.items ?? [],
    directory.activeWorkspaceId,
  );
  const context = selected ? workspaceContextFromDirectoryItem(selected) : null;
  return createCurrentWorkspaceContextReadWitness(
    context,
    requestToken,
    accountGeneration,
  );
}

// Last successfully-resolved workspace context, kept at module scope so it
// survives a component unmount/remount. Returning to the home view remounts the
// nav shell, and starting each remount from `null` flashed the signed-out state
// for the full duration of the (vela-backed, seconds-long) context read before
// snapping to the real workspace. Seeding the remount from this cache shows the
// last-known signed-in state instantly while the background read revalidates.
let cachedWorkspaceContext: WorkspaceContextState['context'] = null;
let cachedWorkspaceContextGeneration = 'initial';
let workspaceContextRevision = 0;
let workspaceContextIdentityChangePending = false;
const WORKSPACE_SELECTION_SESSION_KEY = 'od.workspaceSelection.v1';

interface WorkspaceSelection {
  workspaceId: string;
  workspaceMemberId: string;
}

// `undefined` means storage is authoritative. A value (including null) means
// the latest write failed and this tab's in-memory choice is authoritative.
let inMemoryWorkspaceSelection: WorkspaceSelection | null | undefined;

type WorkspaceSelectionRead =
  | { available: true; selection: WorkspaceSelection | null }
  | { available: false; selection: null };

function readWorkspaceSelectionResult(): WorkspaceSelectionRead {
  if (typeof window === 'undefined') return { available: true, selection: null };
  if (inMemoryWorkspaceSelection !== undefined) {
    return { available: true, selection: inMemoryWorkspaceSelection };
  }
  let storedSelection: string | null;
  try {
    storedSelection = window.sessionStorage.getItem(WORKSPACE_SELECTION_SESSION_KEY);
  } catch {
    return { available: false, selection: null };
  }
  try {
    const raw = JSON.parse(storedSelection ?? 'null') as {
      workspaceId?: unknown;
      workspaceMemberId?: unknown;
    } | null;
    const workspaceId =
      typeof raw?.workspaceId === 'string' ? raw.workspaceId.trim() : '';
    const workspaceMemberId =
      typeof raw?.workspaceMemberId === 'string' ? raw.workspaceMemberId.trim() : '';
    return {
      available: true,
      selection: workspaceId && workspaceMemberId
        ? { workspaceId, workspaceMemberId }
        : null,
    };
  } catch {
    return { available: true, selection: null };
  }
}

function readWorkspaceSelection(): WorkspaceSelection | null {
  return readWorkspaceSelectionResult().selection;
}

function writeWorkspaceSelection(selection: WorkspaceSelection | null): void {
  if (typeof window === 'undefined') return;
  inMemoryWorkspaceSelection = selection ? { ...selection } : null;
  try {
    if (selection) {
      window.sessionStorage.setItem(WORKSPACE_SELECTION_SESSION_KEY, JSON.stringify(selection));
    } else {
      window.sessionStorage.removeItem(WORKSPACE_SELECTION_SESSION_KEY);
    }
    inMemoryWorkspaceSelection = undefined;
  } catch {
    // A tab with unavailable sessionStorage still remains isolated in memory.
  }
}

function selectableWorkspaceItems(items: WorkspaceDirectoryItem[]): WorkspaceDirectoryItem[] {
  return items.filter(
    (item) => item.memberStatus === 'active' && item.lifecycleState !== 'deleted',
  );
}

function chooseWorkspaceForTab(
  items: WorkspaceDirectoryItem[],
  restartWorkspaceId: string | null = null,
): WorkspaceDirectoryItem | null {
  const visible = selectableWorkspaceItems(items);
  const selected = readWorkspaceSelection();
  const exact = selected
    ? visible.find(
        (item) =>
          item.workspaceId === selected.workspaceId
          && item.workspaceMemberId === selected.workspaceMemberId,
      )
    : undefined;
  const restartDefault = restartWorkspaceId
    ? visible.find((item) => item.workspaceId === restartWorkspaceId)
    : undefined;
  const chosen =
    exact
    ?? restartDefault
    ?? visible.find((item) => item.workspaceType === 'personal')
    ?? visible[0]
    ?? null;
  writeWorkspaceSelection(
    chosen
      ? {
          workspaceId: chosen.workspaceId,
          workspaceMemberId: chosen.workspaceMemberId,
        }
      : null,
  );
  return chosen;
}

function explicitWorkspaceHeaders(selection: WorkspaceSelection): Record<string, string> {
  return {
    'x-od-workspace-id': selection.workspaceId,
    'x-od-workspace-member-id': selection.workspaceMemberId,
  };
}

/** Test seam: clear the module-level context cache between tests. */
export function resetWorkspaceContextCache(): void {
  cachedWorkspaceContext = null;
  cachedWorkspaceContextGeneration = 'initial';
  workspaceContextRevision = 0;
  workspaceContextRequestToken = 'initial';
  localIdentityChangeSeq = 0;
  seededWorkspaceContext = null;
  workspaceContextIdentityChangePending = false;
  resetWorkspaceAccountGeneration();
  resetWorkspaceContextRetrySchedules();
  inMemoryWorkspaceSelection = undefined;
  writeWorkspaceSelection(null);
}

/**
 * The last context the shell resolved, for consumers that mount later and would
 * otherwise start their own read from `null`. Read-only: this cache is owned by
 * `useWorkspaceContext` and only a successful read redefines it.
 */
export function lastResolvedWorkspaceContext(): WorkspaceContextState['context'] {
  return cachedWorkspaceContext;
}

export function useWorkspaceContext(): WorkspaceContextState {
  const [state, setState] = useState<WorkspaceContextState>(() => ({
    context: cachedWorkspaceContext,
    resourceReadIdentity:
      cachedWorkspaceContext && !workspaceContextIdentityChangePending
        ? {
            context: cachedWorkspaceContext,
            generation: cachedWorkspaceContextGeneration,
          }
        : null,
    loading: cachedWorkspaceContext === null,
    identityChangePending: workspaceContextIdentityChangePending,
  }));
  const mountedRef = useRef(true);
  // A forced workspace switch can overtake an older ambient read. Keep request
  // ordering local to each hook instance so the late answer cannot redefine
  // either this hook's state or the module cache that seeds future mounts.
  const requestEpochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
    };
  }, []);

  /**
   * Read the workspace context.
   *
   * `markLoading` announces that this read was triggered by something that just
   * CHANGED the identity (a sign-in), so the shell should treat the answer it
   * currently holds as void rather than authoritative. It only ever promotes
   * "no context" to "loading": a read that starts while a context is already in
   * hand keeps showing it, which is what stops the rail flashing signed-out.
   *
   * Without it, signing in during onboarding left the bottom-left "sign in to
   * OpenDesign Cloud" callout on screen for the whole (vela-backed,
   * up-to-seconds) re-read, because `loading` had already settled to false on
   * the earlier signed-out read and only `context !== null` gates the callout
   * (#140). It also forces the coalescing entry, whose whole premise — that
   * sub-second staleness is invisible — stops holding at exactly this moment:
   * the cached answer describes the identity the user just replaced.
   *
   * This hook is mounted by a dozen-plus components at once (App, EntryShell,
   * SettingsDialog, HomeView, ...), and a sign-in fires ONE broadcast event
   * every mounted instance reacts to in the same synchronous pass. Forcing via
   * `forceCoalescedGet` (rather than `evictCoalescedGet` + `coalescedGet`
   * directly) collapses that whole burst to a single real fetch instead of one
   * per mounted instance — see its doc for why the naive evict-then-fetch
   * pattern is unsafe here.
   *
   * `fresh` is reserved for authoritative server invalidations. It bypasses
   * settled directory and context answers without marking the shell loading or
   * declaring a new local identity generation.
   */
  const loadContext = useCallback(async (
    options: {
      markLoading?: boolean;
      fresh?: boolean;
    } = {},
  ) => {
    const requestEpoch = ++requestEpochRef.current;
    const requestGeneration = workspaceContextRequestToken;
    if (options.markLoading && mountedRef.current) {
      setState((prev) => ({
        ...prev,
        // Keep a resolved context visible to shell-only consumers while marking
        // its workspace-owned data unsafe through identityChangePending.
        loading: prev.context === null ? true : prev.loading,
        resourceReadIdentity: null,
        identityChangePending: true,
      }));
    }
    try {
      const requestedSelection = readWorkspaceSelection();
      const forceFresh = options.markLoading || options.fresh;
      const directory: WorkspaceDirectoryResponse = forceFresh
        ? await readWorkspaceDirectoryForCurrentGeneration({ fresh: true })
        : await readWorkspaceDirectoryForCurrentGeneration();
      if (
        !mountedRef.current
        || requestEpochRef.current !== requestEpoch
        || workspaceContextRequestToken !== requestGeneration
      ) return;
      const selected = chooseWorkspaceForTab(
        directory.items ?? [],
        directory.activeWorkspaceId ?? null,
      );
      const exactSessionSelection = requestedSelection && selected
        && selected.workspaceId === requestedSelection.workspaceId
        && selected.workspaceMemberId === requestedSelection.workspaceMemberId
        ? selected
        : null;
      const provisionalReadContext = exactSessionSelection
        ? workspaceContextFromDirectoryItem(exactSessionSelection)
        : null;
      if (provisionalReadContext) {
        setState((prev) => ({
          ...prev,
          resourceReadIdentity: {
            context: provisionalReadContext,
            generation: requestGeneration,
          },
        }));
      }

      const fetchContext = async () => {
        if (!selected) {
          return { context: null } satisfies WorkspaceContextResponse;
        }
        const res = await fetch('/api/workspace/context', {
          cache: 'no-store',
          headers: explicitWorkspaceHeaders({
            workspaceId: selected.workspaceId,
            workspaceMemberId: selected.workspaceMemberId,
          }),
        });
        if (!res.ok) {
          const error = new Error(`workspace-context ${res.status}`) as Error & {
            status?: number;
          };
          error.status = res.status;
          throw error;
        }
        const body = (await res.json()) as WorkspaceContextResponse;
        if (
          body.context
          && (
            body.context.workspaceId !== selected.workspaceId
            || body.context.workspaceMemberId !== selected.workspaceMemberId
          )
        ) {
          throw new Error('workspace-context identity mismatch');
        }
        if (!body.context || body.context.workspaceName?.trim()) return body;
        // Older Vela context payloads predate `workspaceName`, while the
        // membership directory already carries it. Reuse the name from the
        // exact Workspace/member row selected for THIS tab so label consumers
        // (including plugin context defaults) remain compatible. This is display
        // metadata only: authority still comes from the explicit ids above.
        // The daemon's saved workspace id is only a cold-start preference used
        // to choose this exact directory row.
        const workspaceName = typeof selected.workspaceName === 'string'
          ? selected.workspaceName.trim()
          : '';
        return workspaceName
          ? { context: { ...body.context, workspaceName } }
          : body;
      };
      // Coalesced: every mounted consumer of this hook (and every focus/pageshow
      // refresh across them) fires the same read on a home-view burst — collapse
      // them to one request. The nav shell tolerates sub-second staleness.
      // Identity changes force a new generation read instead of sharing a
      // settled answer that predates their trigger.
      // `forceCoalescedGet` still single-flights the burst across consumers.
      const coalesceKey = workspaceContextCoalesceKey();
      const body = forceFresh
        ? await forceCoalescedGet(coalesceKey, fetchContext)
        : await coalescedGet(coalesceKey, fetchContext);
      if (
        !mountedRef.current
        || requestEpochRef.current !== requestEpoch
        || workspaceContextRequestToken !== requestGeneration
      ) return;
      // A successful read is the only thing that redefines "signed in": persist it
      // (including an explicit null for a genuinely signed-out response) so the
      // next remount seeds from the truth, not a stale value.
      const nextContext = body.context ?? null;
      if (workspaceContextIdentity(cachedWorkspaceContext) !== workspaceContextIdentity(nextContext)) {
        workspaceContextRevision += 1;
      }
      cachedWorkspaceContext = nextContext;
      cachedWorkspaceContextGeneration = requestGeneration;
      workspaceContextIdentityChangePending = false;
      // A successful read is the only thing that rewinds the failure-retry
      // backoff for this generation.
      clearWorkspaceContextRetryFailures(requestGeneration);
      setState({
        context: cachedWorkspaceContext,
        resourceReadIdentity: cachedWorkspaceContext
          ? { context: cachedWorkspaceContext, generation: requestGeneration }
          : null,
        loading: false,
        identityChangePending: false,
      });
    } catch (error) {
      if (
        !mountedRef.current
        || requestEpochRef.current !== requestEpoch
        || workspaceContextRequestToken !== requestGeneration
      ) return;
      // Transient failure (offline, momentary daemon/hub hiccup): keep the
      // last-known context instead of flashing the signed-out state. A never-
      // signed-in / personal user has a null cache, so this still shows the local
      // state for them.
      const status = (error as { status?: unknown })?.status;
      const unsupported = status === 404;
      const reauthRequired = status === 401 || status === 403;
      setState({
        context: cachedWorkspaceContext,
        resourceReadIdentity:
          cachedWorkspaceContext && !workspaceContextIdentityChangePending
            ? {
                context: cachedWorkspaceContext,
                generation: cachedWorkspaceContextGeneration,
              }
            : null,
        loading: false,
        identityChangePending: workspaceContextIdentityChangePending,
        failure: unsupported
          ? 'unsupported'
          : reauthRequired
            ? 'reauth-required'
            : 'unavailable',
      });
      // An `unsupported` daemon has no workspace endpoint — retrying is
      // pointless. A transient `unavailable` outage arms the shared jittered
      // backoff so the shell recovers on its own without waiting for the 30s
      // poll or a focus event.
      if (!unsupported && !reauthRequired) scheduleWorkspaceContextRetry(requestGeneration);
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadContext();
    }, WORKSPACE_CONTEXT_POLL_MS);
    return () => clearInterval(interval);
  }, [loadContext]);

  useEffect(() => {
    const refresh = () => {
      void loadContext();
    };
    // An EXPLICIT refresh means a caller just changed the identity (signed in
    // through onboarding or the rail callout) and is telling us so. Focus and
    // visibility are ambient revalidation and stay silent — only the deliberate
    // signal may blank a stale signed-out answer while the re-read runs (#140).
    //
    // When the acting caller published the post-change context with the
    // broadcast, adopt it instead of re-reading: it came from the response that
    // changed the identity, so a fetch here would only ask the server to repeat
    // itself. Bumping the request epoch first retires any ambient read still in
    // flight from BEFORE the change, which could otherwise land later and
    // overwrite the new identity with the old one.
    const refreshAfterIdentityChange = () => {
      const seeded = seededContextForCurrentGeneration();
      if (seeded) {
        requestEpochRef.current += 1;
        workspaceContextIdentityChangePending = false;
        if (mountedRef.current) {
          setState({
            context: seeded,
            resourceReadIdentity: {
              context: seeded,
              generation: workspaceContextRequestToken,
            },
            loading: false,
            identityChangePending: false,
          });
        }
        return;
      }
      void loadContext({ markLoading: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WORKSPACE_ACCOUNT_BOUNDARY_STORAGE_KEY) return;
      // The acting tab advanced its own token inside `notifyWorkspaceContextRefresh`;
      // a passive tab learns of the change only here. Advancing to the stamp the
      // acting tab WROTE keeps this idempotent across the many mounted consumers
      // that all hear the same storage event — they converge on one key, so one
      // change still costs one request.
      advanceWorkspaceContextRequestToken(event.newValue);
      advanceWorkspaceAccountGeneration(event.newValue ?? 'storage');
      refreshAfterIdentityChange();
    };
    // A scheduled failure-retry (see `scheduleWorkspaceContextRetry`) fires this
    // event for a specific identity generation. Re-read only when it still names
    // the current generation — a retry armed for an identity the user has since
    // left must not spend a request.
    const onContextRetry = (event: Event) => {
      const detail = (event as CustomEvent<{ requestKey?: string }>).detail;
      if (detail?.requestKey !== workspaceContextRequestToken) return;
      void loadContext();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refreshAfterIdentityChange);
    window.addEventListener(WORKSPACE_CONTEXT_RETRY_EVENT, onContextRetry);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refreshAfterIdentityChange);
      window.removeEventListener(WORKSPACE_CONTEXT_RETRY_EVENT, onContextRetry);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadContext]);

  const accountGeneration = currentWorkspaceAccountGeneration();
  return useMemo(
    () => ({ ...state, accountGeneration }),
    [accountGeneration, state],
  );
}

const WORKSPACE_CONTEXT_POLL_MS = 30_000;
export const WORKSPACE_CONTEXT_REFRESH_EVENT = 'od:workspace-context-refresh';
// Keep the deployed storage string for old/new bundle interoperability. The
// semantic name is deliberately narrower: only unseeded sign-in/sign-out
// writes it; a seeded ambient Workspace selection never does.
const WORKSPACE_ACCOUNT_BOUNDARY_STORAGE_KEY = 'od.workspaceContext.refreshAt';

/**
 * A context the ACTING surface already holds, published alongside the identity-
 * change broadcast so consumers adopt it instead of re-reading it.
 *
 * The compatibility switch route returns the post-switch context after verifying
 * the exact Workspace/member pair against the directory. The switch response IS
 * the next context; making every mounted consumer fetch it again would spend a
 * round-trip to learn what request #1 already said.
 *
 * Stamped with the identity generation it belongs to. Every mounted consumer
 * handles one broadcast in the same synchronous pass and each must adopt, so this
 * is peeked rather than consumed; the next `advanceWorkspaceContextRequestToken`
 * retires it. A passive TAB cannot be seeded (it learns of the change through the
 * `localStorage` stamp, which carries no payload) and correctly falls back to a
 * real read.
 */
let seededWorkspaceContext: {
  token: string;
  context: WorkspaceCollabContext;
} | null = null;
/**
 * Monotonic account boundary independent from ambient Workspace selection.
 * Fresh project binding witnesses survive A -> B navigation, but must be
 * discarded across sign-in/sign-out when another account may own the same
 * local project id.
 *
 * The counter itself lives in `workspace-identity` so shared catalog modules can
 * partition their caches on it without importing this React hook module; this
 * re-export keeps every existing caller pointed here.
 */
export { currentWorkspaceAccountGeneration };

/** The seed published for the CURRENT identity generation, if any. */
function seededContextForCurrentGeneration(): WorkspaceCollabContext | null {
  if (!seededWorkspaceContext) return null;
  return seededWorkspaceContext.token === workspaceContextRequestToken
    ? seededWorkspaceContext.context
    : null;
}

/**
 * Whether the current explicit refresh carries a server-verified Workspace
 * switch result. A seeded refresh changes only the shell's ambient selection;
 * it is not an account boundary and must not invalidate an already-open
 * project's independently verified Workspace authority.
 */
/**
 * Announce a deliberate identity change (a workspace switch or a sign-in).
 *
 * Pass `seed` when the caller already holds the post-change context — the
 * response body that CHANGED it. Consumers then adopt that context instead of
 * issuing a fresh `GET /api/workspace/context`. Omit it for callers that only
 * know something changed (sign-in), which keeps the re-read.
 *
 * The broadcast fires either way so Workspace-owned consumers can invalidate
 * their cached reads and other tabs can observe the storage stamp.
 */
export function notifyWorkspaceContextRefresh(
  seed?: { context: WorkspaceCollabContext } | null,
): void {
  if (typeof window === 'undefined') return;
  const stamp = `${Date.now()}:${localIdentityChangeSeq + 1}`;
  // Advance BEFORE dispatching: this call is the one place that knows a genuine
  // identity change just happened, and every handler the dispatch below runs must
  // read the new generation's key. Doing it per handler instead would turn one
  // change into one request per mounted consumer.
  advanceWorkspaceContextRequestToken();
  if (seed?.context) {
    writeWorkspaceSelection({
      workspaceId: seed.context.workspaceId,
      workspaceMemberId: seed.context.workspaceMemberId,
    });
    workspaceContextIdentityChangePending = false;
    seededWorkspaceContext = { token: workspaceContextRequestToken, context: seed.context };
    // Redefine the module cache now, so a consumer that mounts after this
    // dispatch seeds from the new identity rather than the one just left.
    if (
      workspaceContextIdentity(cachedWorkspaceContext) !== workspaceContextIdentity(seed.context)
    ) {
      workspaceContextRevision += 1;
    }
    cachedWorkspaceContext = seed.context;
    cachedWorkspaceContextGeneration = workspaceContextRequestToken;
  } else {
    advanceWorkspaceAccountGeneration(stamp);
    workspaceContextIdentityChangePending = true;
    seededWorkspaceContext = null;
  }
  window.dispatchEvent(new Event(WORKSPACE_CONTEXT_REFRESH_EVENT));
  // A seeded refresh is a workspace selection and is deliberately tab-local.
  // Sign-in/sign-out has no seed and remains account-wide across tabs.
  if (!seed?.context) {
    try {
      window.localStorage.setItem(WORKSPACE_ACCOUNT_BOUNDARY_STORAGE_KEY, stamp);
    } catch {
      // The in-window event is enough when localStorage is unavailable.
    }
  }
}

function workspaceContextIdentity(context: WorkspaceCollabContext | null): string {
  if (!context) return '';
  return [
    context.workspaceId?.trim() ?? '',
    context.workspaceMemberId?.trim() ?? '',
    context.workspaceType,
  ].join(':');
}

// ---------- workspace context failure retry ----------
//
// `GET /api/workspace/context` (and its directory prerequisite) previously had
// NO failure retry: a read that failed just sat on the last-good context until
// the next 30s poll or a focus event. During a multi-hour vela authority outage
// that left the shell stale far longer than necessary and, combined with the
// old fail-closed write gate, drove the create-retry storm this PR fixes.
//
// The failure path now arms a jittered exponential-backoff retry (1s → 30s),
// module-level and keyed by identity generation — one timer shared by every
// mounted consumer (a per-hook timer would arm a dozen for the dozen-plus
// mounted `useWorkspaceContext`s). Success
// resets the depth; an ambient trigger (focus or the poll) fetches immediately
// WITHOUT rewinding the depth, so unrelated
// foreground activity cannot keep kicking a flaky transport back to a 1s cadence.
const WORKSPACE_CONTEXT_RETRY_BASE_MS = 1_000;
const WORKSPACE_CONTEXT_RETRY_MAX_MS = 30_000;
const WORKSPACE_CONTEXT_RETRY_EVENT = 'od:workspace-context-retry';

function defaultWorkspaceContextRetryBackoff(): BackoffOptions {
  return {
    initialMs: WORKSPACE_CONTEXT_RETRY_BASE_MS,
    maxMs: WORKSPACE_CONTEXT_RETRY_MAX_MS,
    factor: 2,
    jitter: true,
  };
}

// Test seam: production uses jittered backoff; a test pins the schedule to a
// deterministic sequence (jitter off) to assert the exact 1s→2s→4s…→30s growth.
let workspaceContextRetryBackoffOptions: BackoffOptions = defaultWorkspaceContextRetryBackoff();

export function __setWorkspaceContextRetryBackoffForTests(
  options: BackoffOptions | null,
): void {
  workspaceContextRetryBackoffOptions = options ?? defaultWorkspaceContextRetryBackoff();
}

type WorkspaceContextRetrySchedule = {
  backoff: BackoffController;
  timer: ReturnType<typeof setTimeout> | null;
};
const workspaceContextRetrySchedules = new Map<string, WorkspaceContextRetrySchedule>();

function scheduleWorkspaceContextRetry(requestKey: string): void {
  if (typeof window === 'undefined') return;
  let schedule = workspaceContextRetrySchedules.get(requestKey);
  if (!schedule) {
    schedule = {
      backoff: new BackoffController(workspaceContextRetryBackoffOptions),
      timer: null,
    };
    workspaceContextRetrySchedules.set(requestKey, schedule);
  }
  if (schedule.timer != null) return;
  const delay = schedule.backoff.nextDelay();
  schedule.timer = setTimeout(() => {
    schedule.timer = null;
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_CONTEXT_RETRY_EVENT, { detail: { requestKey } }),
    );
  }, delay);
}

function clearWorkspaceContextRetryFailures(requestKey: string): void {
  workspaceContextRetrySchedules.get(requestKey)?.backoff.reset();
}

function resetWorkspaceContextRetrySchedules(): void {
  for (const schedule of workspaceContextRetrySchedules.values()) {
    if (schedule.timer != null) clearTimeout(schedule.timer);
  }
  workspaceContextRetrySchedules.clear();
}
