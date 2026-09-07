import type { WorkspaceCollabContext } from '@open-design/contracts';

/** First-call sentinel, distinct from every real Workspace account generation. */
export const UNSET_ACCOUNT_BUCKET = '__unset__';

export type TabScopeWorkspaceFailure = 'unsupported' | 'unavailable' | 'reauth-required';

export interface TabIdentityScopeInputs {
  /** Monotonic account boundary owned by the Workspace authority. */
  accountGeneration: number;
  /** Current verified Workspace selection, when one exists. */
  workspaceContext: Pick<WorkspaceCollabContext, 'workspaceId'> | null;
  /** True until the first Workspace context read settles. */
  workspaceContextLoading: boolean;
  /** Distinguishes a transient outage from an authoritative no-Workspace result. */
  workspaceContextFailure?: TabScopeWorkspaceFailure;
  /** A deliberate account transition is in flight; retained context is stale. */
  identityChangePending?: boolean;
  /** Workspace bucket returned by the preceding derivation. */
  previousWorkspaceBucket: string;
  /** Account bucket returned by the preceding derivation. */
  previousAccountBucket: string;
}

export interface TabIdentityScopeResult {
  /** Stable `${account}::${workspace}` tab scope, or null while unresolved. */
  scopeKey: string | null;
  nextWorkspaceBucket: string;
  nextAccountBucket: string;
}

/**
 * Derive Workspace tab ownership without consulting an execution provider.
 *
 * Account identity is the Workspace subsystem's monotonic generation. A
 * selected Workspace changes only the second half of the key, allowing the tab
 * store to treat it as a same-account Workspace switch. An explicit account
 * transition changes the first half and therefore fails closed across users.
 *
 * A transient unavailable response keeps the last confidently resolved
 * Workspace bucket for the same account. Initial loading and deliberate
 * identity transitions return null so the tab store does not adopt a
 * provisional scope.
 */
export function deriveTabIdentityScope(
  inputs: TabIdentityScopeInputs,
): TabIdentityScopeResult {
  const {
    accountGeneration,
    workspaceContext,
    workspaceContextLoading,
    workspaceContextFailure,
    identityChangePending = false,
    previousWorkspaceBucket,
    previousAccountBucket,
  } = inputs;

  if (workspaceContextLoading || identityChangePending) {
    return {
      scopeKey: null,
      nextWorkspaceBucket: previousWorkspaceBucket,
      nextAccountBucket: previousAccountBucket,
    };
  }

  const accountBucket = `account:${accountGeneration}`;
  const accountChanged = accountBucket !== previousAccountBucket;
  const nextWorkspaceBucket =
    workspaceContextFailure === 'reauth-required'
      ? 'none'
      : workspaceContext
        ? workspaceContext.workspaceId
        : workspaceContextFailure === 'unavailable' && !accountChanged
          ? previousWorkspaceBucket
          : 'none';

  return {
    scopeKey: `${accountBucket}::${nextWorkspaceBucket}`,
    nextWorkspaceBucket,
    nextAccountBucket: accountBucket,
  };
}
