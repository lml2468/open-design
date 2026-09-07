import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  getProject,
  listConversations,
  listMessages,
  listWorkspaceProjects,
  openDatabase,
  updateProject,
} from '../../src/db.js';
import {
  materializePulledTeamMirror,
  parseTeamProjectMaterializationVersion,
} from '../../src/collab/team-mirror-materializer.js';

const roots: string[] = [];

const scope = {
  workspaceId: 'workspace-1',
  resourceTeamId: 'workspace-1',
  viewerMemberId: 'viewer-1',
  ownerMemberId: 'owner-1',
};
const input = {
  id: 'project-1',
  name: 'Pulled project',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 2,
};

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function database() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-team-materialize-'));
  roots.push(root);
  return openDatabase(root, { dataDir: root });
}

describe('team mirror SQLite materialization', () => {
  it('reads only canonical explicit-pull cursors', () => {
    expect(parseTeamProjectMaterializationVersion('0')).toBe(0);
    expect(parseTeamProjectMaterializationVersion('6')).toBe(6);
    for (const stored of [null, '', '-1', '1.5', '01', '9007199254740992']) {
      expect(parseTeamProjectMaterializationVersion(stored)).toBeNull();
    }
  });

  it('commits project metadata and its read-only binding together', async () => {
    const db = await database();

    materializePulledTeamMirror(db, input, scope);

    expect(getProject(db, input.id)?.name).toBe('Pulled project');
  });

  it('keeps an owner first-open placeholder creator-less until real content commits', async () => {
    const db = await database();
    const ownerScope = {
      ...scope,
      ownerMemberId: scope.viewerMemberId,
    };

    materializePulledTeamMirror(
      db,
      { ...input, name: '共享项目' },
      ownerScope,
      { placeholder: true },
    );

    expect(getProject(db, input.id)?.metadata?.sharedProjectPlaceholderAt)
      .toEqual(expect.any(Number));
    expect(listWorkspaceProjects(db, ownerScope.workspaceId).find(
      (project) => project.id === input.id,
    )?.createdByWorkspaceMemberId).toBeNull();

    materializePulledTeamMirror(db, {
      ...input,
      metadata: { kind: 'prototype' },
    }, ownerScope);

    expect(getProject(db, input.id)).toMatchObject({
      name: input.name,
      metadata: { kind: 'prototype' },
    });
    expect(listWorkspaceProjects(db, ownerScope.workspaceId).find(
      (project) => project.id === input.id,
    )?.createdByWorkspaceMemberId).toBe(ownerScope.viewerMemberId);
  });

  it('replaces a member placeholder even when its local bootstrap timestamp is newer', async () => {
    const db = await database();
    materializePulledTeamMirror(
      db,
      { ...input, name: '共享项目', updatedAt: 20_000 },
      scope,
      { placeholder: true },
    );

    materializePulledTeamMirror(db, {
      ...input,
      updatedAt: 10_000,
      metadata: { kind: 'prototype' },
    }, scope);

    expect(getProject(db, input.id)).toMatchObject({
      name: input.name,
      updatedAt: 10_000,
      metadata: { kind: 'prototype' },
    });
    expect(listWorkspaceProjects(db, scope.workspaceId).find(
      (project) => project.id === input.id,
    )?.createdByWorkspaceMemberId).toBeNull();
  });

  it('refreshes an existing foreign mirror name when the owner metadata is newer', async () => {
    const db = await database();
    materializePulledTeamMirror(db, input, scope);

    materializePulledTeamMirror(db, {
      ...input,
      name: 'Renamed by owner',
      updatedAt: input.updatedAt + 10,
    }, scope);

    expect(getProject(db, input.id)).toMatchObject({
      name: 'Renamed by owner',
      updatedAt: input.updatedAt + 10,
    });
  });

  it('never overwrites an owner local rename from catalog materialization', async () => {
    const db = await database();
    const ownerScope = {
      ...scope,
      ownerMemberId: scope.viewerMemberId,
    };
    materializePulledTeamMirror(db, input, ownerScope);
    updateProject(db, input.id, { name: 'Pending owner rename', updatedAt: 20 });

    materializePulledTeamMirror(db, {
      ...input,
      name: 'Catalog retry name',
      updatedAt: 30,
    }, ownerScope);

    expect(getProject(db, input.id)).toMatchObject({
      name: 'Pending owner rename',
      updatedAt: 20,
    });
  });

  it('creates one stable local-only comment anchor without copying owner chat', async () => {
    const db = await database();

    materializePulledTeamMirror(db, input, scope);
    const first = listConversations(db, input.id);

    expect(first).toHaveLength(1);
    expect(first[0]?.messageCount).toBe(0);
    expect(listMessages(db, first[0]!.id)).toEqual([]);

    materializePulledTeamMirror(db, input, scope);
    const second = listConversations(db, input.id);

    expect(second.map((conversation) => conversation.id))
      .toEqual(first.map((conversation) => conversation.id));
    expect(listMessages(db, second[0]!.id)).toEqual([]);
  });

});

/**
 * The project card's time. `RecentProjectsStrip` renders one relative time per
 * card and `GET /api/workspaces/:id/projects` answers it as
 * `MAX(p.updated_at, wp.updated_at)` (see `normalizeWorkspaceProjectRow`'s
 * `lastActivityAt` in routes/project/index.ts, and `listWorkspaceProjects`'
 * own `ORDER BY` in db.ts). So BOTH halves have to answer "when did a person
 * last change this project's content" — a pull that stamps either one with
 * `Date.now()` is indistinguishable from a real edit.
 *
 * Reported by the owner: a member who opens the client hours later and pulls a
 * shared project sees 「刚刚更新」 on a project nobody touched. Materialization
 * already carries the origin's `updatedAt` into `projects`; the
 * `workspace_projects` binding written in the same transaction did not, and
 * `MAX` then surfaced the pull's own clock.
 */
describe('a team-mirror pull reports the origin content time, not the pull clock', () => {
  /** What the client renders for this project's card. */
  function displayedUpdatedAt(db: Awaited<ReturnType<typeof database>>) {
    const row = listWorkspaceProjects(db, scope.workspaceId).find(
      (candidate) => candidate.id === input.id,
    ) as { updatedAt: number; workspaceUpdatedAt: number | null } | undefined;
    if (!row) throw new Error('project is not listed in the workspace');
    return Math.max(row.updatedAt, row.workspaceUpdatedAt ?? 0);
  }

  it('does not advance the card time on a first pull', async () => {
    const db = await database();

    materializePulledTeamMirror(db, input, scope);

    expect(getProject(db, input.id)?.updatedAt).toBe(input.updatedAt);
    expect(displayedUpdatedAt(db)).toBe(input.updatedAt);
  });

  it('does not advance the card time on a re-pull of an already-bound mirror', async () => {
    const db = await database();

    materializePulledTeamMirror(db, input, scope);
    materializePulledTeamMirror(db, input, scope);

    expect(getProject(db, input.id)?.updatedAt).toBe(input.updatedAt);
    expect(displayedUpdatedAt(db)).toBe(input.updatedAt);
  });
});
