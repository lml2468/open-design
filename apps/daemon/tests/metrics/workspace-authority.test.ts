import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetWorkspaceAuthorityMetricsForTests,
  recordWorkspaceAuthorityDecision,
  recordWorkspaceAuthorityInvalidation,
  recordWorkspaceAuthoritySuppressedRequest,
} from '../../src/metrics/workspace-authority.js';
import { register } from '../../src/metrics/index.js';

afterEach(() => __resetWorkspaceAuthorityMetricsForTests());

describe('workspace authority metrics', () => {
  it('exports bounded decision, suppression, invalidation, and age series', async () => {
    recordWorkspaceAuthorityDecision({
      mode: 'legacy',
      source: 'cache',
      reason: 'lease_hit',
      outcome: 'allow',
      ageMs: 1_250,
    });
    recordWorkspaceAuthoritySuppressedRequest({
      mode: 'legacy',
      source: 'directory',
      reason: 'lease_hit',
    });
    recordWorkspaceAuthorityInvalidation({
      mode: 'adaptive',
      source: 'current',
      reason: 'auth_reject',
    });
    const text = await register.metrics();
    expect(text).toContain(
      'open_design_workspace_authority_decisions_total{mode="legacy",source="cache",reason="lease_hit",outcome="allow"} 1',
    );
    expect(text).toContain(
      'open_design_workspace_authority_suppressed_requests_total{mode="legacy",source="directory",reason="lease_hit"} 1',
    );
    expect(text).toContain(
      'open_design_workspace_authority_invalidations_total{mode="adaptive",source="current",reason="auth_reject"} 1',
    );
    expect(text).toContain('open_design_workspace_authority_age_ms_bucket{');
  });
});
