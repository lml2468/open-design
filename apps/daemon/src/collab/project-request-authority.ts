import type { Response } from 'express';
import type { WorkspaceResourceMutationCapability } from './workspace-resource-mutation.js';

export type AuthorizeProjectRequestOptions =
  | {
      mode: 'read';
      /** Retained until navigation callers stop passing the legacy option. */
      allowNavigationQuery?: boolean;
    }
  | {
      mode: 'write';
      capability: WorkspaceResourceMutationCapability;
    };

export type AuthorizeProjectRequest = (
  req: any,
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<boolean>;

export type AuthorizedProjectToolRequest = {
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspaceMemberId: string;
  } | null;
};

export type AuthorizeProjectToolRequest = (
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<AuthorizedProjectToolRequest | null>;

/**
 * Local Project data is authorized by possession of the local daemon session.
 *
 * Historical `workspace_projects` rows are migration metadata only. They must
 * never make an existing local Project depend on Workspace request headers,
 * membership state, visibility, frozen/deleted flags, or creator identity.
 * Collaboration Server operations apply their own Project-scoped authorization
 * at the remote API boundary.
 */
export function createAuthorizeProjectRequest(): AuthorizeProjectRequest {
  return () => Promise.resolve(true);
}
