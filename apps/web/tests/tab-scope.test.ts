import { describe, expect, it } from 'vitest';

import {
  deriveTabIdentityScope,
  UNSET_ACCOUNT_BUCKET,
  type TabIdentityScopeInputs,
} from '../src/collab/tab-scope';

function derive(
  partial: Omit<
    TabIdentityScopeInputs,
    'accountGeneration' | 'workspaceContextLoading' | 'previousWorkspaceBucket' | 'previousAccountBucket'
  > & Partial<Pick<
    TabIdentityScopeInputs,
    'accountGeneration' | 'workspaceContextLoading' | 'previousWorkspaceBucket' | 'previousAccountBucket'
  >>,
) {
  return deriveTabIdentityScope({
    accountGeneration: 0,
    workspaceContextLoading: false,
    previousWorkspaceBucket: 'none',
    previousAccountBucket: UNSET_ACCOUNT_BUCKET,
    ...partial,
  });
}

describe('deriveTabIdentityScope', () => {
  it('defers until the first Workspace context read settles', () => {
    expect(derive({ workspaceContext: null, workspaceContextLoading: true })).toEqual({
      scopeKey: null,
      nextWorkspaceBucket: 'none',
      nextAccountBucket: UNSET_ACCOUNT_BUCKET,
    });
  });

  it('defers while an explicit account transition is unresolved', () => {
    expect(derive({
      accountGeneration: 2,
      workspaceContext: { workspaceId: 'old-workspace' },
      identityChangePending: true,
      previousWorkspaceBucket: 'old-workspace',
      previousAccountBucket: 'account:1',
    })).toEqual({
      scopeKey: null,
      nextWorkspaceBucket: 'old-workspace',
      nextAccountBucket: 'account:1',
    });
  });

  it('uses the Workspace account generation and selected Workspace as the scope', () => {
    expect(derive({
      accountGeneration: 3,
      workspaceContext: { workspaceId: 'workspace-a' },
    })).toEqual({
      scopeKey: 'account:3::workspace-a',
      nextWorkspaceBucket: 'workspace-a',
      nextAccountBucket: 'account:3',
    });
  });

  it('represents an authoritative no-Workspace result without an execution-provider identity', () => {
    expect(derive({ accountGeneration: 4, workspaceContext: null }).scopeKey)
      .toBe('account:4::none');
  });

  it('changes only the Workspace bucket for a same-account Workspace switch', () => {
    const first = derive({
      accountGeneration: 5,
      workspaceContext: { workspaceId: 'workspace-a' },
    });
    const second = derive({
      accountGeneration: 5,
      workspaceContext: { workspaceId: 'workspace-b' },
      previousWorkspaceBucket: first.nextWorkspaceBucket,
      previousAccountBucket: first.nextAccountBucket,
    });
    expect(second.scopeKey).toBe('account:5::workspace-b');
    expect(second.nextAccountBucket).toBe(first.nextAccountBucket);
  });

  it('latches the last confirmed Workspace across a transient outage for the same account', () => {
    const result = derive({
      accountGeneration: 6,
      workspaceContext: null,
      workspaceContextFailure: 'unavailable',
      previousWorkspaceBucket: 'workspace-a',
      previousAccountBucket: 'account:6',
    });
    expect(result.scopeKey).toBe('account:6::workspace-a');
  });

  it('does not carry a Workspace latch across an account generation change', () => {
    const result = derive({
      accountGeneration: 7,
      workspaceContext: null,
      workspaceContextFailure: 'unavailable',
      previousWorkspaceBucket: 'workspace-a',
      previousAccountBucket: 'account:6',
    });
    expect(result.scopeKey).toBe('account:7::none');
    expect(result.nextWorkspaceBucket).toBe('none');
  });

  it('drops retained Workspace context when reauthentication is required', () => {
    const result = derive({
      accountGeneration: 8,
      workspaceContext: { workspaceId: 'stale-workspace' },
      workspaceContextFailure: 'reauth-required',
      previousWorkspaceBucket: 'stale-workspace',
      previousAccountBucket: 'account:8',
    });
    expect(result.scopeKey).toBe('account:8::none');
  });
});
