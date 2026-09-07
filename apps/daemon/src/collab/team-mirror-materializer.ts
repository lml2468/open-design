import Database from 'better-sqlite3';

import {
  ensureTeamProjectCommentConversations,
  ensureWorkspaceProject,
  getProject,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  insertProject,
  rebindWorkspaceProject,
  updateProject,
} from '../db.js';
import { projectResourceIdFor } from '../integrations/vela-team-projects.js';
import type {
  RegisterPulledProjectInput,
  TeamMirrorPullScope,
} from '../routes/collab-sync.js';
import type { ResourceHubPrincipal } from './resource-principal.js';
import { isUnmaterializedSharedPlaceholder } from './shared-project-placeholder.js';

type SqliteDb = Database.Database;

export interface MaterializePulledTeamMirrorResult {
  localRecordChanged: boolean;
}

export function parseTeamProjectMaterializationVersion(
  stored: string | null,
): number | null {
  if (stored == null || !/^(?:0|[1-9]\d*)$/.test(stored)) return null;
  const parsed = Number(stored);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Atomically create/update a pulled project and bind it as a read-only mirror
 * in the exact validated team scope. Existing bindings are never migrated:
 * only an absent row or a compatible active mirror may proceed.
 */
export function materializePulledTeamMirror(
  db: SqliteDb,
  input: RegisterPulledProjectInput,
  scope: TeamMirrorPullScope,
  options: { placeholder?: boolean } = {},
): MaterializePulledTeamMirrorResult {
  return db.transaction(() => {
    const ownerPrincipal: ResourceHubPrincipal = {
      teamId: scope.resourceTeamId,
      memberId: scope.ownerMemberId,
      role: 'member',
      lifecycleState: 'active',
      workspaceType: 'team',
    };
    const expectedCreator = options.placeholder
      ? null
      : scope.ownerMemberId === scope.viewerMemberId
        ? scope.viewerMemberId
        : null;
    const resourceHubResourceId = projectResourceIdFor(input.id, ownerPrincipal);
    const existingBinding = getWorkspaceProjectByProjectId(db, input.id) as
      | {
          workspaceId: string;
          visibility: string;
          resourceState: string | null;
          createdByWorkspaceMemberId: string | null;
          resourceHubResourceId: string | null;
          cloudTombstonedAt: number | null;
        }
      | undefined;
    const existing = getProject(db, input.id);
    const existingIsPlaceholder = isUnmaterializedSharedPlaceholder(existing);
    if (options.placeholder && existing && !existingIsPlaceholder) {
      throw new Error(`team placeholder project conflict for ${input.id}`);
    }
    const isRevokedMirror =
      existingBinding?.resourceState === 'deleted'
      && Boolean(existing?.metadata?.teamMirrorRevokedAt);
    const compatibleBinding =
      !existingBinding ||
      (
        existingBinding.workspaceId === scope.workspaceId &&
        existingBinding.visibility === 'team' &&
        (
          existingBinding.resourceState === 'active'
          || isRevokedMirror
        ) &&
        existingBinding.cloudTombstonedAt === null &&
        (
          existingBinding.createdByWorkspaceMemberId === expectedCreator
          || (
            !options.placeholder
            && existingIsPlaceholder
            && existingBinding.createdByWorkspaceMemberId === null
          )
        ) &&
        (
          existingBinding.resourceHubResourceId === null ||
          existingBinding.resourceHubResourceId === resourceHubResourceId
        )
      );
    if (!compatibleBinding) {
      throw new Error(`team mirror binding conflict for ${input.id}`);
    }

    let localRecordChanged = false;
    const persistedInput = options.placeholder
      ? {
          ...input,
          metadata: {
            ...(input.metadata ?? {}),
            sharedProjectPlaceholderAt: Date.now(),
          },
        }
      : input;
    if (!existing) {
      insertProject(db, {
        id: persistedInput.id,
        name: persistedInput.name,
        skillId: persistedInput.skillId,
        designSystemId: persistedInput.designSystemId,
        metadata: persistedInput.metadata,
        createdAt: persistedInput.createdAt,
        updatedAt: persistedInput.updatedAt,
      });
      localRecordChanged = true;
    } else if (
      (!options.placeholder && existingIsPlaceholder)
      || (
        !existingIsPlaceholder
        && expectedCreator === null
        && input.updatedAt > existing.updatedAt
      )
    ) {
      updateProject(db, input.id, {
        name: persistedInput.name,
        skillId: persistedInput.skillId,
        designSystemId: persistedInput.designSystemId,
        metadata: persistedInput.metadata,
        updatedAt: persistedInput.updatedAt,
      });
      localRecordChanged = true;
    } else if (existing.metadata?.teamMirrorRevokedAt) {
      const metadata = {
        ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      };
      delete metadata.teamMirrorRevokedAt;
      updateProject(db, input.id, {
        metadata,
        // Materialization is synchronization, not local activity. Preserve
        // the owner's content timestamp rather than stamping this daemon's
        // re-share observation time.
        updatedAt: input.updatedAt,
      });
      localRecordChanged = true;
    }
    const commentConversations = ensureTeamProjectCommentConversations(
      db,
      input.id,
    );
    if (commentConversations.anchorCreated || commentConversations.routingCreated) {
      localRecordChanged = true;
    }

    const patch = {
      workspaceId: scope.workspaceId,
      visibility: 'team' as const,
      resourceState: 'active' as const,
      createdByWorkspaceMemberId: expectedCreator,
      updatedByWorkspaceMemberId: scope.viewerMemberId,
      resourceHubResourceId,
      cloudTombstonedAt: null,
      syncState: 'synced' as const,
      // The ORIGIN's content time, exactly like the project row above — never
      // this pull's clock. The project list answers a card's one relative time
      // as `MAX(p.updated_at, wp.updated_at)`, so carrying the origin into the
      // project row alone was not enough: the binding written in this same
      // transaction defaulted to `Date.now()` and `MAX` surfaced it, which is
      // why a member's card read 「刚刚更新」 hours after a background pull.
      updatedAt: input.updatedAt,
    };
    if (existingBinding) {
      rebindWorkspaceProject(db, input.id, patch);
    } else {
      ensureWorkspaceProject(db, { projectId: input.id, ...patch });
    }
    const binding = getWorkspaceProject(db, scope.workspaceId, input.id) as
      | {
          workspaceId: string;
          visibility: string;
          resourceState: string | null;
          createdByWorkspaceMemberId: string | null;
          updatedByWorkspaceMemberId: string | null;
          resourceHubResourceId: string | null;
          cloudTombstonedAt: number | null;
          syncState: string | null;
        }
      | undefined;
    if (
      !binding ||
      binding.workspaceId !== patch.workspaceId ||
      binding.visibility !== patch.visibility ||
      binding.resourceState !== patch.resourceState ||
      binding.createdByWorkspaceMemberId !== patch.createdByWorkspaceMemberId ||
      binding.updatedByWorkspaceMemberId !== patch.updatedByWorkspaceMemberId ||
      binding.resourceHubResourceId !== patch.resourceHubResourceId ||
      binding.cloudTombstonedAt !== null ||
      binding.syncState !== patch.syncState
    ) {
      throw new Error(`team mirror binding verification failed for ${input.id}`);
    }
    return { localRecordChanged };
  })();
}
