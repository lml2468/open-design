import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import {
  advanceWorkspaceAccountGeneration,
  currentWorkspaceAccountGeneration,
  resetWorkspaceAccountGeneration,
  type WorkspaceResourceReadIdentity,
} from './workspace-identity';

/**
 * Transitional shape for callers that still accept the retired Workspace
 * authority model. Production now resolves to local Project mode and performs
 * no Workspace network requests.
 */
export interface WorkspaceContextState {
  context: WorkspaceCollabContext | null;
  accountGeneration?: number;
  resourceReadIdentity?: WorkspaceResourceReadIdentity | null;
  loading: boolean;
  identityChangePending?: boolean;
  failure?: 'unsupported' | 'unavailable' | 'reauth-required';
}

export function workspaceResourceReadContext(
  state: WorkspaceContextState,
): WorkspaceCollabContext | null {
  if (state.resourceReadIdentity !== undefined) {
    return state.resourceReadIdentity?.context ?? null;
  }
  return state.context;
}

export { workspaceIdentityCacheKey, beginWorkspaceScopedRead } from './workspace-identity';
export type { WorkspaceScopedRead } from './workspace-identity';
export { currentWorkspaceAccountGeneration };

export const WORKSPACE_CONTEXT_REFRESH_EVENT = 'od:workspace-context-refresh';

let cachedWorkspaceContext: WorkspaceCollabContext | null = null;
let workspaceContextRequestGeneration = 0;

export function currentWorkspaceContextRequestToken(): string {
  return `local:${workspaceContextRequestGeneration}`;
}

export function resetWorkspaceContextCache(): void {
  cachedWorkspaceContext = null;
  workspaceContextRequestGeneration = 0;
  resetWorkspaceAccountGeneration();
}

export function lastResolvedWorkspaceContext(): WorkspaceContextState['context'] {
  return cachedWorkspaceContext;
}

function currentState(): WorkspaceContextState {
  return {
    context: cachedWorkspaceContext,
    resourceReadIdentity: cachedWorkspaceContext
      ? {
          context: cachedWorkspaceContext,
          generation: currentWorkspaceContextRequestToken(),
        }
      : null,
    loading: false,
    identityChangePending: false,
    accountGeneration: currentWorkspaceAccountGeneration(),
  };
}

export function useWorkspaceContext(): WorkspaceContextState {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refresh);
  }, []);

  return useMemo(() => currentState(), [revision]);
}

/**
 * Compatibility event for callers completing collaboration sign-in. A seeded
 * context is retained only for existing in-process consumers and tests; normal
 * production calls are unseeded and therefore remain in local Project mode.
 */
export function notifyWorkspaceContextRefresh(
  seed?: { context: WorkspaceCollabContext } | null,
): void {
  workspaceContextRequestGeneration += 1;
  cachedWorkspaceContext = seed?.context ?? null;
  if (!seed?.context) {
    advanceWorkspaceAccountGeneration(`local:${workspaceContextRequestGeneration}`);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(WORKSPACE_CONTEXT_REFRESH_EVENT));
  }
}
