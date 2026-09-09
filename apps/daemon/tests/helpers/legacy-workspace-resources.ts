import type Database from 'better-sqlite3';

type LegacyWorkspaceResourceInput = {
  resourceType: 'plugin' | 'skill' | 'design_system';
  resourceId: string;
  workspaceId: string;
  visibility?: 'personal' | 'team';
  resourceState?: 'active' | 'frozen' | 'deleted';
  createdByWorkspaceMemberId?: string | null;
  updatedByWorkspaceMemberId?: string | null;
};

/**
 * Recreate one row from the retired `workspace_resources` schema.
 *
 * Production no longer creates or reads this table. Tests use this helper to
 * prove that databases left behind by older releases cannot scope or hide the
 * daemon-local Plugin, Skill, or Design System catalogs.
 */
export function seedLegacyWorkspaceResource(
  db: Database.Database,
  input: LegacyWorkspaceResourceInput,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_resources (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('personal', 'team')),
      resource_state TEXT,
      created_by_workspace_member_id TEXT,
      updated_by_workspace_member_id TEXT,
      resource_hub_resource_id TEXT,
      cloud_tombstoned_at INTEGER,
      sync_state TEXT,
      version INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (resource_type, resource_id)
    )
  `);
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO workspace_resources
       (resource_type, resource_id, workspace_id, visibility, resource_state,
        created_by_workspace_member_id, updated_by_workspace_member_id,
        version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.resourceType,
    input.resourceId,
    input.workspaceId,
    input.visibility ?? 'personal',
    input.resourceState ?? 'active',
    input.createdByWorkspaceMemberId ?? null,
    input.updatedByWorkspaceMemberId ?? input.createdByWorkspaceMemberId ?? null,
    1,
    now,
    now,
  );
}

export function hasLegacyWorkspaceResource(
  db: Database.Database,
  resourceType: LegacyWorkspaceResourceInput['resourceType'],
  resourceId: string,
): boolean {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_resources'",
  ).get();
  if (!table) return false;
  return Boolean(db.prepare(
    'SELECT 1 FROM workspace_resources WHERE resource_type = ? AND resource_id = ?',
  ).get(resourceType, resourceId));
}
