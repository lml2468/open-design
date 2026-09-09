import type Database from 'better-sqlite3';

type LegacyWorkspaceProjectInput = {
  projectId: string;
  workspaceId: string;
  visibility?: 'personal' | 'team';
  resourceState?: 'active' | 'frozen' | 'deleted';
  createdByWorkspaceMemberId?: string | null;
  updatedByWorkspaceMemberId?: string | null;
  resourceHubResourceId?: string | null;
  cloudTombstonedAt?: number | null;
  syncState?: string | null;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
};

/** Seed a row from the retired Team Workspace project-binding schema. */
export function seedLegacyWorkspaceProject(
  db: Database.Database,
  input: LegacyWorkspaceProjectInput,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_projects (
      project_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('personal', 'team')),
      resource_state TEXT NOT NULL CHECK (resource_state IN ('active', 'frozen', 'deleted')),
      created_by_workspace_member_id TEXT,
      updated_by_workspace_member_id TEXT,
      resource_hub_resource_id TEXT,
      cloud_tombstoned_at INTEGER,
      sync_state TEXT,
      metadata_refresh_pending INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO workspace_projects
       (project_id, workspace_id, visibility, resource_state,
        created_by_workspace_member_id, updated_by_workspace_member_id,
        resource_hub_resource_id, cloud_tombstoned_at, sync_state, version,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    input.workspaceId,
    input.visibility ?? 'personal',
    input.resourceState ?? 'active',
    input.createdByWorkspaceMemberId ?? null,
    input.updatedByWorkspaceMemberId ?? input.createdByWorkspaceMemberId ?? null,
    input.resourceHubResourceId ?? null,
    input.cloudTombstonedAt ?? null,
    input.syncState ?? 'local_only',
    input.version ?? 1,
    input.createdAt ?? now,
    input.updatedAt ?? now,
  );
}

export function getLegacyWorkspaceProjectByProjectId(
  db: Database.Database,
  projectId: string,
): Record<string, unknown> | undefined {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_projects'",
  ).get();
  if (!table) return undefined;
  return db.prepare(
    `SELECT project_id AS projectId,
            workspace_id AS workspaceId,
            visibility,
            resource_state AS resourceState,
            created_by_workspace_member_id AS createdByWorkspaceMemberId,
            updated_by_workspace_member_id AS updatedByWorkspaceMemberId,
            resource_hub_resource_id AS resourceHubResourceId,
            cloud_tombstoned_at AS cloudTombstonedAt,
            sync_state AS syncState,
            version,
            created_at AS createdAt,
            updated_at AS updatedAt
       FROM workspace_projects
      WHERE project_id = ?`,
  ).get(projectId) as Record<string, unknown> | undefined;
}
