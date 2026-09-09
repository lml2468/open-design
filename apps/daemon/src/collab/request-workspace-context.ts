import type { WorkspaceCollabContext } from '@open-design/contracts';
import {
  workspaceContextFromDirectoryItem,
  type WorkspaceDirectoryFetchResult,
} from './vela-workspace-context.js';

export type WorkspaceRequestContext = {
  workspaceId: string;
  workspaceType: 'personal' | 'team';
  /** The caller's raw workspace-type claim; null means it was omitted. */
  workspaceTypeAsserted: 'personal' | 'team' | null;
  appUserId: string;
  workspaceMemberId: string;
  role: 'owner' | 'admin' | 'member';
  memberStatus: 'active' | 'removed';
  lifecycleState: 'active' | 'billing_past_due' | 'locked' | 'deleting' | 'deleted';
  canShareProjects: boolean;
  canWriteSyncedFiles: boolean;
};

function headerValue(req: any, name: string): string | null {
  const value = req?.get?.(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerBool(req: any, name: string, fallback: boolean): boolean {
  const value = headerValue(req, name);
  if (value === 'false') return false;
  if (value === 'true') return true;
  return fallback;
}

function workspaceRequestContext(
  req: any,
  workspaceId: string,
): WorkspaceRequestContext | null {
  const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
  if (!workspaceMemberId) return null;
  const workspaceTypeHeader = headerValue(req, 'x-od-workspace-type');
  const lifecycleState = headerValue(req, 'x-od-workspace-lifecycle-state') ?? 'active';
  const role = headerValue(req, 'x-od-workspace-role') ?? 'member';
  const legacyWriteEnabled = headerBool(req, 'x-od-workspace-write-enabled', true);
  const canWriteSyncedFiles = headerBool(
    req,
    'x-od-workspace-can-write-synced-files',
    legacyWriteEnabled,
  );
  return {
    workspaceId,
    workspaceType: workspaceTypeHeader === 'team' ? 'team' : 'personal',
    workspaceTypeAsserted:
      workspaceTypeHeader === 'team' || workspaceTypeHeader === 'personal'
        ? workspaceTypeHeader
        : null,
    appUserId: headerValue(req, 'x-od-app-user-id') ?? 'local-user',
    workspaceMemberId,
    role: role === 'owner' || role === 'admin' ? role : 'member',
    memberStatus:
      headerValue(req, 'x-od-workspace-member-status') === 'removed'
        ? 'removed'
        : 'active',
    lifecycleState:
      lifecycleState === 'billing_past_due'
      || lifecycleState === 'locked'
      || lifecycleState === 'deleting'
      || lifecycleState === 'deleted'
        ? lifecycleState
        : 'active',
    canShareProjects: headerBool(
      req,
      'x-od-workspace-can-share-projects',
      canWriteSyncedFiles,
    ),
    canWriteSyncedFiles,
  };
}

/** Parse the explicit Workspace/member pair carried by a request. */
export function workspaceRequestContextFromRequest(
  req: any,
): WorkspaceRequestContext | 'missing' | null {
  const workspaceId = headerValue(req, 'x-od-workspace-id');
  const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
  if (!workspaceId && !workspaceMemberId) return null;
  if (!workspaceId || !workspaceMemberId) return 'missing';
  return workspaceRequestContext(req, workspaceId) ?? 'missing';
}

export type VerifiedWorkspaceRequestContextResult =
  | { ok: true; context: WorkspaceCollabContext }
  | {
      ok: false;
      status: 400 | 401 | 403 | 503;
      code:
        | 'WORKSPACE_CONTEXT_REQUIRED'
        | 'WORKSPACE_CONTEXT_INCOMPLETE'
        | 'AGENT_AUTH_REQUIRED'
        | 'WORKSPACE_AUTHORITY_UNAVAILABLE'
        | 'WORKSPACE_ACCESS_DENIED';
      message: string;
      retryable?: true;
    };

/**
 * Resolve a request's explicit Workspace identity against the signed-in
 * account's authoritative membership directory.
 *
 * Data-plane routes must call this instead of reading the daemon's mutable
 * active Workspace. The headers choose which membership to verify; the
 * directory supplies every authority-bearing field.
 */
export async function verifyWorkspaceRequestContext(input: {
  req: unknown;
  fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>;
  configuredEnv?: Record<string, string>;
  requireTeam?: boolean;
}): Promise<VerifiedWorkspaceRequestContextResult> {
  const claimed = workspaceRequestContextFromRequest(input.req);
  if (claimed === null) {
    return {
      ok: false,
      status: 400,
      code: 'WORKSPACE_CONTEXT_REQUIRED',
      message: 'an explicit workspace context is required',
    };
  }
  if (claimed === 'missing') {
    return {
      ok: false,
      status: 400,
      code: 'WORKSPACE_CONTEXT_INCOMPLETE',
      message: 'both workspace and member identity are required',
    };
  }

  let directory: WorkspaceDirectoryFetchResult;
  try {
    directory = await input.fetchWorkspaceDirectory();
  } catch {
    directory = { ok: false, items: [] };
  }
  if (!directory.ok) {
    if (directory.reason === 'unauthorized') {
      return {
        ok: false,
        status: 401,
        code: 'AGENT_AUTH_REQUIRED',
        message: 'Workspace authorization expired. Sign in again to continue.',
      };
    }
    return {
      ok: false,
      status: 503,
      code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
      message: 'workspace membership authority is temporarily unavailable',
      retryable: true,
    };
  }

  const membership = directory.items.find(
    (item) =>
      item.workspaceId === claimed.workspaceId
      && item.workspaceMemberId === claimed.workspaceMemberId
      && item.memberStatus === 'active'
      && item.lifecycleState !== 'deleted',
  );
  if (!membership || (input.requireTeam && membership.workspaceType !== 'team')) {
    return {
      ok: false,
      status: 403,
      code: 'WORKSPACE_ACCESS_DENIED',
      message: 'the requested workspace is not available to this member',
    };
  }

  return {
    ok: true,
    context: workspaceContextFromDirectoryItem(membership, input.configuredEnv),
  };
}
