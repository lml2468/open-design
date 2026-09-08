import { Counter, Histogram, register } from 'prom-client';

import type { WorkspaceAuthorityCacheMode } from '../collab/workspace-authority-health.js';

export type WorkspaceAuthorityMetricSource =
  | 'cache'
  | 'directory'
  | 'current'
  | 'billing';

export type WorkspaceAuthorityMetricReason =
  | 'cold'
  | 'lease_hit'
  | 'lease_expired'
  | 'in_flight'
  | 'failure_backoff'
  | 'fresh'
  | 'mutation'
  | 'event_dirty'
  | 'auth_reject'
  | 'catch_up'
  | 'unhealthy';

export type WorkspaceAuthorityMetricOutcome =
  | 'allow'
  | 'deny'
  | 'unavailable'
  | 'fallback';

export const workspaceAuthorityDecisionsTotal = new Counter({
  name: 'open_design_workspace_authority_decisions_total',
  help: 'Workspace authority decisions by bounded mode, source, reason, and outcome.',
  labelNames: ['mode', 'source', 'reason', 'outcome'] as const,
  registers: [register],
});

export const workspaceAuthoritySuppressedRequestsTotal = new Counter({
  name: 'open_design_workspace_authority_suppressed_requests_total',
  help: 'Upstream Workspace authority requests avoided by a valid lease or realtime safety floor.',
  labelNames: ['mode', 'source', 'reason'] as const,
  registers: [register],
});

export const workspaceAuthorityInvalidationsTotal = new Counter({
  name: 'open_design_workspace_authority_invalidations_total',
  help: 'Workspace authority cache invalidations by bounded reason.',
  labelNames: ['mode', 'source', 'reason'] as const,
  registers: [register],
});

export const workspaceAuthorityAgeMs = new Histogram({
  name: 'open_design_workspace_authority_age_ms',
  help: 'Age of cached Workspace authority when it is used for a local response.',
  labelNames: ['mode', 'source'] as const,
  buckets: [10, 100, 500, 1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 300_000],
  registers: [register],
});

export function recordWorkspaceAuthorityDecision(input: {
  mode: WorkspaceAuthorityCacheMode;
  source: WorkspaceAuthorityMetricSource;
  reason: WorkspaceAuthorityMetricReason;
  outcome: WorkspaceAuthorityMetricOutcome;
  ageMs?: number;
}): void {
  try {
    workspaceAuthorityDecisionsTotal.inc({
      mode: input.mode,
      source: input.source,
      reason: input.reason,
      outcome: input.outcome,
    });
    if (input.ageMs != null && Number.isFinite(input.ageMs) && input.ageMs >= 0) {
      workspaceAuthorityAgeMs.observe(
        { mode: input.mode, source: input.source },
        input.ageMs,
      );
    }
  } catch {
    // Metrics are diagnostic only and must never change an authority result.
  }
}

export function recordWorkspaceAuthoritySuppressedRequest(input: {
  mode: WorkspaceAuthorityCacheMode;
  source: WorkspaceAuthorityMetricSource;
  reason: 'lease_hit' | 'in_flight' | 'failure_backoff';
}): void {
  try {
    workspaceAuthoritySuppressedRequestsTotal.inc(input);
  } catch {
    // Metrics are diagnostic only and must never change an authority result.
  }
}

export function recordWorkspaceAuthorityInvalidation(input: {
  mode: WorkspaceAuthorityCacheMode;
  source: 'cache' | 'current';
  reason: 'mutation' | 'event_dirty' | 'auth_reject' | 'catch_up' | 'unhealthy';
}): void {
  try {
    workspaceAuthorityInvalidationsTotal.inc(input);
  } catch {
    // Metrics are diagnostic only and must never change an authority result.
  }
}

export function __resetWorkspaceAuthorityMetricsForTests(): void {
  workspaceAuthorityDecisionsTotal.reset();
  workspaceAuthoritySuppressedRequestsTotal.reset();
  workspaceAuthorityInvalidationsTotal.reset();
  workspaceAuthorityAgeMs.reset();
}
