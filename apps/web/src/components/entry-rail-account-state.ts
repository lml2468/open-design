import type { WorkspaceContextState } from '../collab/useWorkspaceContext';

export type EntryRailAccountFooterState = 'hidden' | 'syncing' | 'recovering' | 'sign-in';

/**
 * Decide what the rail may claim about the legacy Workspace account.
 *
 * A successful workspace response with `context: null` is authoritative:
 * the authority says there is no active workspace identity, so the
 * sign-in entry belongs on screen. A transient outage is not an identity
 * answer. While Cloud is unreachable, keep the last resolved workspace (the
 * hook does this when one exists) or show a neutral recovery placeholder
 * instead of falsely claiming sign-out.
 */
export function resolveEntryRailAccountFooterState(
  workspaceState: WorkspaceContextState,
): EntryRailAccountFooterState {
  if (workspaceState.failure === 'reauth-required') return 'sign-in';
  if (workspaceState.context) return 'hidden';
  if (workspaceState.loading) return 'syncing';
  if (workspaceState.failure === 'unavailable') return 'recovering';
  return 'sign-in';
}
