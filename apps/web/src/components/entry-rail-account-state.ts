import type { WorkspaceContextState } from '../collab/useWorkspaceContext';
import { planUnlimitedTier } from '../runtime/amr-unlimited-models';

export type EntryRailAccountFooterState = 'hidden' | 'syncing' | 'recovering' | 'sign-in';

/**
 * Whether the workbench's top-right credits pill may show the wallet balance.
 *
 * A subscriber sitting at exactly $0.00 is a NORMAL state, not an alarm: on
 * Go / Plus / Pro / Max the popular models they work with every day are
 * unlimited, so the wallet only meters flagship calls and legitimately stays
 * empty. Rendering that zero permanently next to the avatar read as "you are
 * out of money" to users who are not. Product ruling: hide the money on a
 * subscribed plan whose balance is exactly zero.
 *
 * Everything else keeps it, and each exclusion is load-bearing:
 *  • free / unknown tier — zero is the number that explains why hosted models
 *    are unavailable, and an unresolved billing read must not make the pill
 *    flicker in and out as it lands;
 *  • a non-zero balance, including an OVERDRAWN one — a negative wallet is the
 *    one case the user has to act on.
 *
 * `tier` is the same resolved plan id the pill's neighbours label
 * (`resolvePlanLabelTier`), so the pill and the nameplate cannot disagree.
 */
export function shouldShowCreditsBalance(input: {
  tier: string | null | undefined;
  balanceUsd: string | null | undefined;
}): boolean {
  if (planUnlimitedTier(input.tier) === null) return true;
  const raw = input.balanceUsd?.trim() ?? '';
  if (!raw) return true;
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return true;
  return amount !== 0;
}

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
