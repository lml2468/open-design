/**
 * Live `Map<projectId, ProjectDisplayStatus>` for a known set of projects.
 *
 * Derives status from the runs feed so project-list consumers share the same
 * live source as the active conversation UI.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDisplayStatus } from '@open-design/contracts';
import { listRunsForProject, RUNS_CHANGED_EVENT } from '../providers/daemon';
import {
  foldRunsToProjectRunSummaries,
  type ProjectRunSummary,
} from '../state/projectRunStatus';

/** Backstop only — `RUNS_CHANGED_EVENT` is what makes this feel immediate. */
const POLL_MS = 4000;

const EMPTY: ReadonlyMap<string, ProjectRunSummary> = new Map();

export interface UseProjectRunStatusesOptions {
  enabled?: boolean;
}

/**
 * Live `Map<projectId, ProjectRunSummary>`: the status plus the newest
 * finished run's identity, for a consumer that acknowledges notices per run.
 */
export function useProjectRunSummaries(
  projectIds: readonly string[],
  options?: UseProjectRunStatusesOptions,
): ReadonlyMap<string, ProjectRunSummary> {
  const enabled = options?.enabled ?? true;
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ProjectRunSummary>>(EMPTY);

  // One request per id, so the effect must not re-run just because the caller
  // rebuilt the array. Sorted + joined is the identity that actually matters.
  const idsKey = useMemo(() => [...projectIds].sort().join('\u0000'), [projectIds]);
  useEffect(() => {
    const ids = idsKey ? idsKey.split('\u0000') : [];
    if (!enabled || ids.length === 0) {
      setSummaries(EMPTY);
      return undefined;
    }
    let cancelled = false;

    const refresh = async () => {
      const results = await Promise.all(ids.map((id) => listRunsForProject(id)));
      if (cancelled) return;
      // An unreadable project yields null; skipping it leaves that row blank
      // rather than asserting a status nobody verified.
      const runs = results.flatMap((result) => result?.runs ?? []);
      const awaiting = results.flatMap((result) => result?.awaitingInputProjectIds ?? []);
      setSummaries(foldRunsToProjectRunSummaries(runs, awaiting));
    };

    void refresh();
    const onRunsChanged = () => void refresh();
    window.addEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
      window.clearInterval(timer);
    };
  }, [idsKey, enabled]);

  return summaries;
}

/** The status half of {@link useProjectRunSummaries}, for glyph-only consumers. */
export function useProjectRunStatuses(
  projectIds: readonly string[],
  options?: UseProjectRunStatusesOptions,
): ReadonlyMap<string, ProjectDisplayStatus> {
  const summaries = useProjectRunSummaries(projectIds, options);
  return useMemo(() => {
    const statuses = new Map<string, ProjectDisplayStatus>();
    for (const [projectId, summary] of summaries) statuses.set(projectId, summary.status);
    return statuses;
  }, [summaries]);
}
