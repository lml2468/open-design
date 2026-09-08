import express from 'express';
import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../../src/server.js';
import { registerProjectRoutes } from '../../src/routes/project/index.js';
import { verifyWorkspaceRequestContext } from '../../src/collab/request-workspace-context.js';
import {
  createWorkspaceDirectoryAuthorityBroker,
  type WorkspaceDirectoryFetchResult,
} from '../../src/collab/vela-workspace-context.js';

describe('workspace project routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const workspaceId = `ws-${Date.now()}`;

  function headers(memberId: string, extra: Record<string, string> = {}) {
    return workspaceHeaders(workspaceId, memberId, extra);
  }

  function workspaceHeaders(targetWorkspaceId: string, memberId: string, extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      'x-od-workspace-id': targetWorkspaceId,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-role': 'member',
      ...extra,
    };
  }
  async function createProject(id: string, name: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name, skillId: null, designSystemId: null }),
    });
    expect(resp.status).toBe(200);
  }

  async function createProjectInWorkspace(
    id: string,
    name: string,
    memberId: string,
    extra: Record<string, string> = {},
  ) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(memberId, extra),
      body: JSON.stringify({ id, name, skillId: null, designSystemId: null }),
    });
    expect(resp.status).toBe(200);
  }

  async function list(memberId: string, query = '', extra: Record<string, string> = {}) {
    return listInWorkspace(workspaceId, memberId, query, extra);
  }

  async function listInWorkspace(
    targetWorkspaceId: string,
    memberId: string,
    query = '',
    extra: Record<string, string> = {},
  ) {
    const resp = await fetch(`${baseUrl}/api/workspaces/${targetWorkspaceId}/projects${query}`, {
      headers: workspaceHeaders(targetWorkspaceId, memberId, extra),
    });
    if (resp.status !== 200) {
      throw new Error(`GET workspace projects failed ${resp.status}: ${await resp.text()}`);
    }
    return resp.json() as Promise<{ projects: Array<any> }>;
  }

  it('rejects a project list when the route Workspace conflicts with the explicit request scope', async () => {
    const suffix = Date.now();
    const workspaceA = `${workspaceId}-route-a-${suffix}`;
    const workspaceB = `${workspaceId}-header-b-${suffix}`;
    const projectId = `workspace-route-scope-${suffix}`;
    await createProjectInWorkspace(
      projectId,
      'Workspace route scope fixture',
      'member-route-a',
      { 'x-od-workspace-id': workspaceA },
    );

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspaceA}/projects?view=all`,
      { headers: workspaceHeaders(workspaceB, 'member-header-b') },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'WORKSPACE_ACCESS_DENIED' },
    });
  });

  it('projects legacy rows into a workspace list without assigning ownership to the reader', async () => {
    const projectId = `workspace-list-${Date.now()}`;
    await createProject(projectId, 'Workspace list fixture');

    const body = await list('member-list', '?view=all');

    const project = body.projects.find((item) => item.id === projectId);
    expect(project).toMatchObject({
      id: projectId,
      visibility: 'personal',
      resourceState: 'active',
      createdByWorkspaceMemberId: null,
    });
    expect(project.currentUserAccess.canDelete).toBe(false);
  });

  // RED LINE — losing a user's pre-workspace ("legacy") projects across the
  // upgrade is data loss. The adoption model must be: every legacy project is
  // lazily projected into the personal workspace on first read (regardless of
  // how long after the upgrade that read happens), projection is idempotent,
  // and a team view SUPPRESSING an ownerless personal row must never translate
  // into that row disappearing from the personal workspace.
  it('never loses legacy projects across workspace views (upgrade adoption red line)', async () => {
    const stamp = Date.now();
    const legacyIds = [0, 1, 2].map((n) => `redline-${stamp}-${n}`);
    for (const id of legacyIds) await createProject(id, `Legacy ${id}`);

    // First personal-workspace read after "upgrade": every legacy project is
    // adopted, visible, and personal — none skipped, none re-owned.
    const first = await list('redline-reader', '?view=all');
    for (const id of legacyIds) {
      expect(first.projects.find((item) => item.id === id)).toMatchObject({
        id,
        visibility: 'personal',
        resourceState: 'active',
        createdByWorkspaceMemberId: null,
      });
    }

    // Idempotent: a second read neither drops nor duplicates rows.
    const second = await list('redline-reader', '?view=all');
    for (const id of legacyIds) {
      expect(second.projects.filter((item) => item.id === id)).toHaveLength(1);
    }

    // A TEAM workspace view suppresses ownerless personal rows (they belong to
    // the person, not the team)…
    const teamWorkspaceId = `${workspaceId}-redline-team`;
    const teamResp = await fetch(`${baseUrl}/api/workspaces/${teamWorkspaceId}/projects?view=all`, {
      headers: workspaceHeaders(teamWorkspaceId, 'redline-reader', {
        'x-od-workspace-type': 'team',
      }),
    });
    expect(teamResp.status).toBe(200);
    const teamBody = (await teamResp.json()) as { projects: Array<any> };
    for (const id of legacyIds) {
      expect(teamBody.projects.find((item) => item.id === id)).toBeUndefined();
    }

    // …but suppression is a FILTER, not a deletion: the personal workspace
    // still lists every legacy project afterwards.
    const after = await list('redline-reader', '?view=all');
    for (const id of legacyIds) {
      expect(after.projects.find((item) => item.id === id)).toMatchObject({
        id,
        visibility: 'personal',
      });
    }
  });

  // Product ruling (2026-07-21): 「草稿和分享的方案都是和 workspace 绑定的」. A
  // project belongs to exactly ONE workspace. This test used to assert the
  // opposite — that the same legacy project is projected independently into
  // every workspace that reads it — which is precisely the back-fill bug: with
  // a row everywhere, every workspace rendered the same 草稿 grid and switching
  // workspaces changed nothing.
  it('binds a legacy project to the first workspace that adopts it, and only that one', async () => {
    const projectId = `workspace-multi-${Date.now()}`;
    const workspaceA = `${workspaceId}-a`;
    const workspaceB = `${workspaceId}-b`;
    await createProject(projectId, 'Multi workspace fixture');

    const bodyA = await listInWorkspace(workspaceA, 'member-a', '?view=all');
    const bodyB = await listInWorkspace(workspaceB, 'member-b', '?view=all');

    expect(bodyA.projects.find((item) => item.id === projectId)).toMatchObject({
      id: projectId,
      workspaceId: workspaceA,
      createdByWorkspaceMemberId: null,
    });
    // Workspace B reading the same daemon does NOT get a copy.
    expect(bodyB.projects.find((item) => item.id === projectId)).toBeUndefined();

    // …and adoption is stable: re-reading B does not steal it from A.
    const againA = await listInWorkspace(workspaceA, 'member-a', '?view=all');
    expect(againA.projects.some((item) => item.id === projectId)).toBe(true);
  });

  // THE BUG, at the draft grid. A draft created inside workspace A must not
  // appear in workspace B's 草稿 — that is the whole product ruling.
  it('keeps a draft created in one workspace out of another workspace’s drafts', async () => {
    const suffix = Date.now();
    const projectId = `workspace-draft-scope-${suffix}`;
    const workspaceA = `${workspaceId}-draft-a-${suffix}`;
    const workspaceB = `${workspaceId}-draft-b-${suffix}`;

    // Created THROUGH workspace A's context, so the row records the act.
    const createResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: workspaceHeaders(workspaceA, 'member-draft-a'),
      body: JSON.stringify({ id: projectId, name: 'Draft in A', skillId: null, designSystemId: null }),
    });
    expect(createResp.status).toBe(200);
    await expect(createResp.json()).resolves.toMatchObject({
      project: {
        id: projectId,
        workspaceId: workspaceA,
      },
    });

    const draftsA = await listInWorkspace(workspaceA, 'member-draft-a', '?view=drafts');
    expect(draftsA.projects.map((item) => item.id)).toContain(projectId);

    const draftsB = await listInWorkspace(workspaceB, 'member-draft-b', '?view=drafts');
    expect(draftsB.projects.map((item) => item.id)).not.toContain(projectId);
    const allB = await listInWorkspace(workspaceB, 'member-draft-b', '?view=all');
    expect(allB.projects.map((item) => item.id)).not.toContain(projectId);
  });

  it('keeps ordinary local creates independent from partial or stale Workspace identity', async () => {
    const suffix = Date.now();
    const partialId = `workspace-create-partial-${suffix}`;
    const partial = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-od-workspace-id': `${workspaceId}-partial`,
      },
      body: JSON.stringify({
        id: partialId,
        name: 'Must not become unbound',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(partial.status).toBe(200);
    await expect(partial.json()).resolves.toMatchObject({
      project: { id: partialId },
    });
    const partialDetail = await fetch(`${baseUrl}/api/projects/${partialId}`);
    expect(partialDetail.status).toBe(200);
    await expect(partialDetail.json()).resolves.toMatchObject({
      project: { id: partialId, workspaceId: null },
    });

    const revokedId = `workspace-create-revoked-${suffix}`;
    const revoked = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: workspaceHeaders(`${workspaceId}-revoked`, 'member-revoked', {
        'x-od-workspace-member-status': 'removed',
      }),
      body: JSON.stringify({
        id: revokedId,
        name: 'Must fail closed',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      project: {
        id: revokedId,
        workspaceId: `${workspaceId}-revoked`,
      },
    });

    // PRODUCT INVARIANT: identity headers are optional local attribution on
    // ordinary creates, never a live Team authorization check. A complete but
    // stale snapshot remains attributable locally; fresh authority belongs to
    // a later explicit workspace binding boundary.
    const revokedDetail = await fetch(`${baseUrl}/api/projects/${revokedId}`, {
      headers: workspaceHeaders(`${workspaceId}-revoked`, 'member-revoked'),
    });
    expect(revokedDetail.status).toBe(200);
    await expect(revokedDetail.json()).resolves.toMatchObject({
      project: {
        id: revokedId,
        workspaceId: `${workspaceId}-revoked`,
      },
    });
  });

  it('keeps the persisted workspace binding on the project detail read model', async () => {
    const suffix = Date.now();
    const projectId = `workspace-detail-scope-${suffix}`;
    const workspaceA = `${workspaceId}-detail-a-${suffix}`;
    const createResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: workspaceHeaders(workspaceA, 'member-detail-a'),
      body: JSON.stringify({
        id: projectId,
        name: 'Project detail scope fixture',
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createResp.status).toBe(200);

    const detailResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: workspaceHeaders(workspaceA, 'member-detail-a'),
    });
    expect(detailResp.status).toBe(200);
    const detail = (await detailResp.json()) as {
      project: { id: string; workspaceId?: string | null };
    };
    expect(detail.project).toMatchObject({
      id: projectId,
      workspaceId: workspaceA,
    });
  });

  // Adoption must never mint a second row for a project that already has one.
  // The narrowed primary key would reject it, so a regression here surfaces as a
  // 500 rather than a silent duplicate — but the read path must not get there.
  it('does not re-bind a project that already belongs to a workspace', async () => {
    const suffix = Date.now();
    const projectId = `workspace-rebind-${suffix}`;
    const workspaceA = `${workspaceId}-rebind-a-${suffix}`;
    const workspaceB = `${workspaceId}-rebind-b-${suffix}`;
    await createProject(projectId, 'Rebind fixture');

    await listInWorkspace(workspaceA, 'member-rebind-a', '?view=all');
    for (let i = 0; i < 3; i += 1) {
      const resp = await fetch(`${baseUrl}/api/workspaces/${workspaceB}/projects?view=all`, {
        headers: workspaceHeaders(workspaceB, 'member-rebind-b'),
      });
      expect(resp.status).toBe(200);
    }

    const stillInA = await listInWorkspace(workspaceA, 'member-rebind-a', '?view=all');
    expect(stillInA.projects.filter((item) => item.id === projectId)).toHaveLength(1);
  });

  it('does not let the first workspace reader become the legacy project owner', async () => {
    const projectId = `workspace-owner-read-${Date.now()}`;
    await createProject(projectId, 'Ownership read fixture');

    const firstRead = await list('member-b', '?view=all');
    const afterRead = firstRead.projects.find((item) => item.id === projectId);
    expect(afterRead).toMatchObject({
      id: projectId,
      createdByWorkspaceMemberId: null,
    });
    expect(afterRead.currentUserAccess.canDelete).toBe(false);

    const deleteResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-b'),
      body: JSON.stringify({ projectIds: [projectId] }),
    });
    expect(deleteResp.status).toBe(403);

    const stillExists = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: headers('member-b'),
    });
    expect(stillExists.status).toBe(200);
  });

  it('does not expose removed-location projects through workspace project routes', async () => {
    const locationId = `workspace-hidden-location-${Date.now()}`;
    const projectId = `workspace-hidden-project-${Date.now()}`;
    const extDir = await mkdtemp(path.join(tmpdir(), 'od-workspace-hidden-'));
    try {
      const putLocation = await fetch(`${baseUrl}/api/project-locations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locations: [{ id: locationId, name: 'Hidden workspace location', path: extDir }] }),
      });
      expect(putLocation.status).toBe(200);

      const createResp = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: 'Hidden workspace project',
          skillId: null,
          designSystemId: null,
          projectLocationId: locationId,
        }),
      });
      expect(createResp.status).toBe(200);

      const removeLocation = await fetch(`${baseUrl}/api/project-locations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locations: [] }),
      });
      expect(removeLocation.status).toBe(200);

      const listResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects?view=all`, {
        headers: headers('member-hidden-location'),
      });
      expect(listResp.status).toBe(200);
      const listBody = await listResp.json() as { projects: Array<any> };
      expect(listBody.projects.some((item: any) => item.id === projectId)).toBe(false);

      const deleteResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
        method: 'POST',
        headers: headers('member-hidden-location', { 'x-od-workspace-role': 'admin' }),
        body: JSON.stringify({ projectIds: [projectId] }),
      });
      expect(deleteResp.status).toBe(404);
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });

  it('rejects workspace project mutations without workspace identity', async () => {
    const projectId = `workspace-missing-context-${Date.now()}`;
    await createProject(projectId, 'Missing context fixture');

    const deleteResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectIds: [projectId] }),
    });

    expect(deleteResp.status).toBe(400);
    await expect(deleteResp.json()).resolves.toMatchObject({
      error: {
        code: 'WORKSPACE_CONTEXT_REQUIRED',
      },
    });

    const stillExists = await fetch(`${baseUrl}/api/projects/${projectId}`);
    expect(stillExists.status).toBe(200);
  });

  it('validates workspace project views and applies each accepted view', async () => {
    const suffix = Date.now();
    const draftId = `workspace-view-draft-${suffix}`;
    const otherId = `workspace-view-other-${suffix}`;
    const otherWorkspaceId = `${workspaceId}-other-${suffix}`;
    const otherWorkspaceProjectId = `workspace-view-cross-workspace-${suffix}`;
    await createProjectInWorkspace(draftId, 'Draft view fixture', 'member-view', {
      'x-od-workspace-type': 'team',
    });
    await createProjectInWorkspace(otherId, 'Other member view fixture', 'member-other', {
      'x-od-workspace-type': 'team',
    });
    await createProjectInWorkspace(otherWorkspaceProjectId, 'Other Workspace fixture', 'member-view', {
      'x-od-workspace-id': otherWorkspaceId,
      'x-od-workspace-type': 'team',
    });

    const all = await list('member-view', '?view=all');
    const recent = await list('member-view', '?view=recent');
    const drafts = await list('member-view', '?view=drafts');
    const team = await list('member-view', '?view=team');
    const otherPersonal = await list(
      'member-view',
      '?view=all&owner=others&visibility=personal',
    );

    expect(all.projects.some((item) => item.id === draftId)).toBe(true);
    expect(recent.projects.map((item) => item.id)).toContain(draftId);
    expect(drafts.projects.map((item) => item.id)).toContain(draftId);
    expect(team.projects).toEqual([]);
    expect(team.projects.map((item) => item.id)).not.toContain(draftId);
    for (const response of [all, recent, drafts, team, otherPersonal]) {
      expect(response.projects.map((item) => item.id)).not.toContain(otherId);
      expect(response.projects.map((item) => item.id)).not.toContain(otherWorkspaceProjectId);
    }

    const invalid = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects?view=personal`, {
      headers: headers('member-view'),
    });
    expect(invalid.status).toBe(400);
  });

  it('enforces workspace project permissions on direct project and file write routes', async () => {
    const projectId = `workspace-direct-write-${Date.now()}`;
    const ownerHeaders = headers('member-write-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'admin',
    });
    await createProjectInWorkspace(projectId, 'Direct write project', 'member-write-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'admin',
    });

    const seedResp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'index.html', content: '<h1>original</h1>' }),
    });
    expect(seedResp.status).toBe(200);

    // Workspace governance does not transfer the project's single writer.
    // Even a Workspace owner remains a read-only viewer when another member
    // created the workspace-bound project.
    const workspaceOwnerHeaders = headers('member-workspace-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    });
    const privilegedWriteResp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: workspaceOwnerHeaders,
      body: JSON.stringify({ name: 'owner-escalation.txt', content: 'must not land' }),
    });
    expect(privilegedWriteResp.status).toBe(403);

    const versionResp = await fetch(`${baseUrl}/api/projects/${projectId}/files/index.html/versions`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ source: 'manual', label: 'seed' }),
    });
    expect(versionResp.status).toBe(200);
    const versionBody = await versionResp.json() as { version: { id: string } };

    const readOnlyHeaders = headers('member-write-viewer');
    const patchResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: readOnlyHeaders,
      body: JSON.stringify({ name: 'Illicit rename' }),
    });
    expect(patchResp.status).toBe(403);

    const duplicateResp = await fetch(`${baseUrl}/api/projects/${projectId}/duplicate`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({ name: 'Illicit duplicate' }),
    });
    expect(duplicateResp.status).toBe(403);

    const designSystemCopyResp = await fetch(`${baseUrl}/api/projects/${projectId}/design-system-copy`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({ name: 'Illicit design-system copy' }),
    });
    expect(designSystemCopyResp.status).toBe(403);

    const writeResp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({ name: 'blocked.txt', content: 'blocked' }),
    });
    expect(writeResp.status).toBe(403);

    // The multi-file batch route (chat composer paste/drop/picker) is a
    // separate handler from the single-file POST above and used to carry no
    // enforceWorkspaceProjectMutation call at all — not even the ctx-present
    // path this whole test exercises for its siblings.
    const uploadForm = new FormData();
    uploadForm.append('files', new Blob(['blocked'], { type: 'text/plain' }), 'blocked-upload.txt');
    const { 'content-type': _uploadContentType, ...uploadHeaders } = readOnlyHeaders;
    const uploadResp = await fetch(`${baseUrl}/api/projects/${projectId}/upload`, {
      method: 'POST',
      headers: uploadHeaders,
      body: uploadForm,
    });
    expect(uploadResp.status).toBe(403);

    const folderCreateResp = await fetch(`${baseUrl}/api/projects/${projectId}/folders`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({ name: 'blocked-folder' }),
    });
    expect(folderCreateResp.status).toBe(403);

    const renameResp = await fetch(`${baseUrl}/api/projects/${projectId}/files/rename`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({ from: 'index.html', to: 'renamed.html' }),
    });
    expect(renameResp.status).toBe(403);

    const restoreResp = await fetch(`${baseUrl}/api/projects/${projectId}/files/index.html/versions/${versionBody.version.id}/restore`, {
      method: 'POST',
      headers: readOnlyHeaders,
      body: JSON.stringify({}),
    });
    expect(restoreResp.status).toBe(403);

    const deleteResp = await fetch(`${baseUrl}/api/projects/${projectId}/files/index.html`, {
      method: 'DELETE',
      headers: readOnlyHeaders,
    });
    expect(deleteResp.status).toBe(403);

    const rawDeleteResp = await fetch(`${baseUrl}/api/projects/${projectId}/raw/index.html`, {
      method: 'DELETE',
      headers: readOnlyHeaders,
    });
    expect(rawDeleteResp.status).toBe(403);

    const folderDeleteResp = await fetch(`${baseUrl}/api/projects/${projectId}/folders`, {
      method: 'DELETE',
      headers: readOnlyHeaders,
      body: JSON.stringify({ path: 'blocked-folder' }),
    });
    expect(folderDeleteResp.status).toBe(403);

    const projectDeleteResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: readOnlyHeaders,
    });
    expect(projectDeleteResp.status).toBe(403);

    const blockedFile = await fetch(`${baseUrl}/api/projects/${projectId}/raw/blocked.txt`, {
      headers: readOnlyHeaders,
    });
    expect(blockedFile.status).toBe(403);
    const privilegedBlockedFile = await fetch(
      `${baseUrl}/api/projects/${projectId}/raw/owner-escalation.txt`,
      { headers: ownerHeaders },
    );
    expect(privilegedBlockedFile.status).toBe(404);
    const projectResp = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: ownerHeaders,
    });
    const projectBody = await projectResp.json() as { project: { name: string } };
    expect(projectBody.project.name).toBe('Direct write project');
  });

  // recvqbjbudBS9r — a duplicated project used to leave the daemon with NO
  // `workspace_projects` row at all for the copy: `POST /api/projects/:id/duplicate`
  // inserted the new project row but never bound it anywhere. It stayed an
  // unbound orphan until whichever workspace's project list was read NEXT
  // (`bindUnboundProjectsToPersonalWorkspace` sweeps every orphan into the
  // workspace it is reading for), which could be a workspace the user never
  // touched. The fix binds the copy into the duplicating request's own
  // workspace immediately, so no later read — for ANY workspace — can steal it.
  it('binds a duplicated project into the workspace it was duplicated from, not wherever a project list is read next', async () => {
    const projectId = `dup-workspace-bind-${Date.now()}`;
    const ownerHeaders = headers('member-dup-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'admin',
    });
    await createProjectInWorkspace(projectId, 'Duplicate workspace-bind fixture', 'member-dup-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'admin',
    });

    const duplicateResp = await fetch(`${baseUrl}/api/projects/${projectId}/duplicate`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Duplicate workspace-bind copy' }),
    });
    expect(duplicateResp.status).toBe(200);
    const duplicateBody = await duplicateResp.json() as {
      project: { id: string; workspaceId?: string };
    };
    const targetId = duplicateBody.project.id;
    expect(duplicateBody.project.workspaceId).toBe(workspaceId);

    // Read a DIFFERENT workspace's project list first. Before the fix this
    // greedily adopted the still-unbound copy (any personal-workspace read
    // sweeps every orphan project into itself), so the copy would show up
    // here instead of in the workspace it was actually duplicated from.
    const otherWorkspaceId = `ws-other-${Date.now()}`;
    const otherList = await listInWorkspace(otherWorkspaceId, 'member-other-reader', '?view=all');
    expect(otherList.projects.some((item) => item.id === targetId)).toBe(false);

    // The workspace the duplicate actually happened in has it immediately —
    // no dependency on a later list read to adopt it.
    const ownList = await list('member-dup-owner', '?view=all');
    expect(ownList.projects.find((item) => item.id === targetId)).toMatchObject({
      id: targetId,
      createdByWorkspaceMemberId: 'member-dup-owner',
    });

    const designSystemCopyResp = await fetch(
      `${baseUrl}/api/projects/${projectId}/design-system-copy`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name: 'Design-system workspace-bind copy' }),
      },
    );
    expect(designSystemCopyResp.status).toBe(200);
    const designSystemCopyBody = await designSystemCopyResp.json() as {
      project: { id: string; workspaceId?: string };
      designSystemId: string;
    };
    expect(designSystemCopyBody.project.workspaceId).toBe(workspaceId);
    expect(
      (await list('member-dup-owner', '?view=all')).projects.find(
        (item) => item.id === designSystemCopyBody.project.id,
      ),
    ).toMatchObject({
      id: designSystemCopyBody.project.id,
      createdByWorkspaceMemberId: 'member-dup-owner',
    });

    const ownDesignSystemsResp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: ownerHeaders,
    });
    expect(ownDesignSystemsResp.status).toBe(200);
    const ownDesignSystemsBody = await ownDesignSystemsResp.json() as {
      designSystems: Array<{ id: string; workspaceId?: string }>;
    };
    expect(
      ownDesignSystemsBody.designSystems.find(
        (item) => item.id === designSystemCopyBody.designSystemId,
      ),
    ).toMatchObject({
      id: designSystemCopyBody.designSystemId,
      workspaceId,
    });

    const otherHeaders = workspaceHeaders(otherWorkspaceId, 'member-other-reader', {
      'x-od-workspace-type': 'team',
    });
    const otherDesignSystemsResp = await fetch(`${baseUrl}/api/design-systems`, {
      headers: otherHeaders,
    });
    expect(otherDesignSystemsResp.status).toBe(200);
    const otherDesignSystemsBody = await otherDesignSystemsResp.json() as {
      designSystems: Array<{ id: string }>;
    };
    expect(
      otherDesignSystemsBody.designSystems.some(
        (item) => item.id === designSystemCopyBody.designSystemId,
      ),
    ).toBe(false);

    const ownDirectRead = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(designSystemCopyBody.designSystemId)}`,
      { headers: ownerHeaders },
    );
    expect(ownDirectRead.status).toBe(200);

    const crossWorkspaceDirectRead = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(designSystemCopyBody.designSystemId)}`,
      { headers: otherHeaders },
    );
    expect(crossWorkspaceDirectRead.status).toBe(403);

    const crossWorkspaceMutation = await fetch(
      `${baseUrl}/api/design-systems/${encodeURIComponent(designSystemCopyBody.designSystemId)}`,
      {
        method: 'PATCH',
        headers: otherHeaders,
        body: JSON.stringify({ title: 'Cross-workspace overwrite' }),
      },
    );
    expect(crossWorkspaceMutation.status).toBe(403);
  });

  // recvqbhor3pai2 — duplicating an already-duplicated project (a "copy of a
  // copy") 403'd with WORKSPACE_PROJECT_PERMISSION_DENIED / "workspace project
  // mutation is not allowed". Before recvqbjbudBS9r's fix (the test above),
  // the first duplicate left NO `workspace_projects` row for the copy, so
  // `workspaceProjectMutationAllowed` hit its `if (!row) return false;` guard
  // the moment anyone tried to duplicate THAT copy. This test exercises the
  // exact reported shape (two duplicates back to back, real owner headers
  // matching the bug report's curl repro) end to end to confirm
  // `bindDuplicateIntoRequestWorkspace` closes this specific case too — the
  // copy's own binding row now exists by the time it is duplicated again.
  it('allows duplicating a project that is itself already a duplicate', async () => {
    const suffix = Date.now();
    const projectId = `dup-of-dup-source-${suffix}`;
    const ownerHeaders = headers('member-dup-of-dup-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    });
    await createProjectInWorkspace(projectId, 'Duplicate-of-duplicate fixture', 'member-dup-of-dup-owner', {
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    });

    // First duplicate: source -> copy1 (mirrors the "Mobile App Copy" project
    // in the bug report, which was itself a duplicate).
    const firstDuplicateResp = await fetch(`${baseUrl}/api/projects/${projectId}/duplicate`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Duplicate-of-duplicate copy 1' }),
    });
    expect(firstDuplicateResp.status).toBe(200);
    const firstDuplicateBody = (await firstDuplicateResp.json()) as { project: { id: string } };
    const copy1Id = firstDuplicateBody.project.id;

    // Second duplicate: duplicate the COPY itself — this is exactly what the
    // report's curl reproduced against and got "workspace project mutation is
    // not allowed" for.
    const secondDuplicateResp = await fetch(`${baseUrl}/api/projects/${copy1Id}/duplicate`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Duplicate-of-duplicate copy 2' }),
    });
    expect(secondDuplicateResp.status).toBe(200);
    const secondDuplicateBody = (await secondDuplicateResp.json()) as { project: { id: string } };
    const copy2Id = secondDuplicateBody.project.id;

    const ownList = await list('member-dup-of-dup-owner', '?view=all');
    expect(ownList.projects.find((item) => item.id === copy2Id)).toMatchObject({
      id: copy2Id,
      createdByWorkspaceMemberId: 'member-dup-of-dup-owner',
    });
  });

  // recvqbhor3pai2 (remaining gap) — `bindDuplicateIntoRequestWorkspace`'s own
  // doc comment admits a headerless duplicate (no `x-od-workspace-*` headers —
  // a legitimate legacy/pre-context caller, e.g. the web client's
  // `workspaceContext` has not resolved yet on the very first click) leaves
  // the copy permanently UNBOUND, "same as before" its fix. Before
  // `reconcileUnboundProjectBeforeMutation`, the first LATER mutation that DID
  // carry real headers — duplicating that same still-unbound copy again once
  // the client's workspace context settled — hit
  // `workspaceResourceMutationAllowed`'s `if (!row) return false;` guard and
  // 403'd with "workspace project mutation is not allowed", even though no
  // other workspace had ever claimed the project. This reproduces the exact
  // reported shape end to end and confirms the copy gets claimed into the
  // duplicating member's own workspace instead of staying stuck.
  it('allows duplicating a copy that a prior headerless duplicate left unbound', async () => {
    const suffix = Date.now();
    const projectId = `dup-unbound-source-${suffix}`;
    await createProject(projectId, 'Duplicate-of-unbound-copy fixture');

    // First duplicate: no workspace headers at all (legacy / pre-context
    // caller). Source is itself unbound, so this is allowed today — but it
    // leaves the COPY unbound too.
    const firstDuplicateResp = await fetch(`${baseUrl}/api/projects/${projectId}/duplicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate-of-unbound-copy copy 1' }),
    });
    expect(firstDuplicateResp.status).toBe(200);
    const firstDuplicateBody = (await firstDuplicateResp.json()) as { project: { id: string } };
    const copy1Id = firstDuplicateBody.project.id;

    // Second duplicate: this time with real workspace headers, as if the
    // client's workspace context has since resolved — exactly what the
    // report's repro (open the copy, "···" → duplicate again) exercised.
    const memberHeaders = headers('member-dup-unbound-owner', { 'x-od-workspace-role': 'owner' });
    const secondDuplicateResp = await fetch(`${baseUrl}/api/projects/${copy1Id}/duplicate`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({ name: 'Duplicate-of-unbound-copy copy 2' }),
    });
    expect(secondDuplicateResp.status).toBe(200);
    const secondDuplicateBody = (await secondDuplicateResp.json()) as { project: { id: string } };
    const copy2Id = secondDuplicateBody.project.id;

    // The reconciliation claimed copy1 (the source of the second duplicate)
    // into the duplicating member's own workspace rather than leaving it — or
    // copy2 — unbound.
    const ownList = await list('member-dup-unbound-owner', '?view=all');
    expect(ownList.projects.find((item) => item.id === copy1Id)).toMatchObject({
      id: copy1Id,
      createdByWorkspaceMemberId: 'member-dup-unbound-owner',
    });
    expect(ownList.projects.find((item) => item.id === copy2Id)).toMatchObject({
      id: copy2Id,
      createdByWorkspaceMemberId: 'member-dup-unbound-owner',
    });
  });

  it('rejects member batch-delete for unknown legacy ownership and allows privileged delete', async () => {
    const suffix = Date.now();
    const memberProjectId = `workspace-delete-member-${suffix}`;
    const adminProjectId = `workspace-delete-admin-${suffix}`;
    await createProject(memberProjectId, 'Member project');
    await list('member-a');
    await createProject(adminProjectId, 'Admin project');
    await list('member-admin');

    const memberResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-a'),
      body: JSON.stringify({ projectIds: [memberProjectId] }),
    });
    expect(memberResp.status).toBe(403);

    const memberStillExists = await fetch(`${baseUrl}/api/projects/${memberProjectId}`, {
      headers: headers('member-a'),
    });
    expect(memberStillExists.status).toBe(200);

    const adminResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-admin', { 'x-od-workspace-role': 'admin' }),
      body: JSON.stringify({ projectIds: [adminProjectId] }),
    });
    expect(adminResp.status).toBe(200);
    const deleted = await adminResp.json() as { deletedProjectIds: string[] };
    expect(deleted.deletedProjectIds).toEqual([adminProjectId]);

    const adminGone = await fetch(`${baseUrl}/api/projects/${adminProjectId}`);
    expect(adminGone.status).toBe(404);
  });

  // A project has ONE workspace, so deleting it from that workspace deletes it
  // outright — there is no second projection left holding it alive. This used to
  // assert the opposite (that workspace B still listed it), which only held
  // because the back-fill had put a copy of every project in every workspace.
  it('deletes the project outright when its one workspace deletes it', async () => {
    const suffix = Date.now();
    const projectId = `workspace-delete-shared-${suffix}`;
    const workspaceA = `${workspaceId}-delete-a-${suffix}`;
    const workspaceB = `${workspaceId}-delete-b-${suffix}`;
    await createProject(projectId, 'Shared delete fixture');

    const bodyA = await listInWorkspace(workspaceA, 'member-delete-a', '?view=all');
    expect(bodyA.projects.some((item) => item.id === projectId)).toBe(true);
    const bodyB = await listInWorkspace(workspaceB, 'member-delete-b', '?view=all');
    expect(bodyB.projects.some((item) => item.id === projectId)).toBe(false);

    const deleteResp = await fetch(`${baseUrl}/api/workspaces/${workspaceA}/projects/batch-delete`, {
      method: 'POST',
      headers: workspaceHeaders(workspaceA, 'member-delete-a', { 'x-od-workspace-role': 'admin' }),
      body: JSON.stringify({ projectIds: [projectId] }),
    });
    expect(deleteResp.status).toBe(200);

    const baseProject = await fetch(`${baseUrl}/api/projects/${projectId}`);
    expect(baseProject.status).toBe(404);
  });

  it('fails batch-delete when project directory cleanup fails', async () => {
    const projectId = `workspace-delete-cleanup-fails-${Date.now()}`;
    const dbDeleteProject = vi.fn();
    const removeProjectDir = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const stageProjectDirsForDelete = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject,
      removeProjectDir,
      stageProjectDirsForDelete,
      countWorkspaceProjectRefs: vi.fn(() => 1),
    }));
    const routeServer = await listen(app);
    try {
      const deleteResp = await fetch(`${routeServer.url}/api/workspaces/${workspaceId}/projects/batch-delete`, {
        method: 'POST',
        headers: headers('member-cleanup-fail'),
        body: JSON.stringify({ projectIds: [projectId] }),
      });
      expect(deleteResp.status).toBe(400);
      expect(stageProjectDirsForDelete).toHaveBeenCalledWith('projects', [projectId], 'id');
      expect(removeProjectDir).not.toHaveBeenCalled();
      expect(dbDeleteProject).not.toHaveBeenCalled();
    } finally {
      await close(routeServer.server);
    }
  });

});

function workspaceProjectRouteDeps({
  workspaceId,
  projectId,
  dbDeleteProject,
  removeProjectDir,
  stageProjectDirsForDelete,
  deleteWorkspaceProject,
  countWorkspaceProjectRefs,
  updateWorkspaceProject,
  rebindWorkspaceProject,
  workspaceRowOverrides,
}: {
  workspaceId: string;
  projectId: string;
  dbDeleteProject: ReturnType<typeof vi.fn>;
  removeProjectDir: ReturnType<typeof vi.fn>;
  stageProjectDirsForDelete?: ReturnType<typeof vi.fn>;
  deleteWorkspaceProject?: ReturnType<typeof vi.fn>;
  countWorkspaceProjectRefs?: ReturnType<typeof vi.fn>;
  updateWorkspaceProject?: ReturnType<typeof vi.fn>;
  rebindWorkspaceProject?: ReturnType<typeof vi.fn>;
  workspaceRowOverrides?: Record<string, unknown>;
}) {
  const now = 1;
  const project = {
    id: projectId,
    name: 'Cleanup failure project',
    skillId: null,
    designSystemId: null,
    pendingPrompt: null,
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
  };
  const workspaceRow = {
    ...project,
    workspaceProjectId: projectId,
    workspaceId,
    workspaceVisibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: 'member-cleanup-fail',
    updatedByWorkspaceMemberId: 'member-cleanup-fail',
    resourceHubResourceId: null,
    cloudTombstonedAt: null,
    syncState: 'local_only',
    workspaceVersion: 1,
    workspaceCreatedAt: now,
    workspaceUpdatedAt: now,
    ...workspaceRowOverrides,
  };
  const noop = vi.fn();
  return {
    db: {
      transaction: (fn: (ids: string[]) => void) => fn,
      // These route tests isolate workspace project behavior behind a synthetic
      // project store rather than a real SQLite database, so model the
      // pre-existing comment anchor that is unrelated to their assertions.
      // Keep the SQL surface
      // deliberately narrow: an unexpected direct database query must still
      // fail instead of being silently accepted by an all-purpose stub.
      prepare: (sql: string) => {
        if (/FROM conversations\b/.test(sql)) {
          return {
            get: () => ({ id: `comment-anchor-${projectId}` }),
          };
        }
        throw new Error(`unexpected direct SQLite query in workspace route fixture: ${sql}`);
      },
    },
    design: {},
    http: {
      createSseResponse: noop,
      sendApiError: (res: any, status: number, code: string, message: string, init: Record<string, unknown> = {}) =>
        res.status(status).json({ error: { code, message, ...init } }),
    },
    paths: {
      DESIGN_SYSTEMS_DIR: '',
      PROJECTS_DIR: 'projects',
      SKILLS_DIR: '',
      BRANDS_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
    },
    projectStore: {
      insertProject: noop,
      validateLinkedDirs: () => ({ dirs: [] }),
      getProject: (_db: unknown, requestedProjectId: string) =>
        requestedProjectId === projectId ? project : null,
      updateProject: noop,
      dbDeleteProject,
      removeProjectDir,
      stageProjectDirsForDelete: stageProjectDirsForDelete ?? vi.fn(async () => ({
        rollback: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
      })),
      deleteWorkspaceProject: deleteWorkspaceProject ?? noop,
      countWorkspaceProjectRefs: countWorkspaceProjectRefs ?? vi.fn(() => 1),
      ensureWorkspaceProject: () => workspaceRow,
      getWorkspaceProject: () => workspaceRow,
      // A project belongs to one workspace, so the routes look its binding up by
      // project id alone (see collab/workspace-project-home.ts).
      getWorkspaceProjectByProjectId: () => workspaceRow,
      listWorkspaceProjectBindings: () => new Map([[projectId, workspaceId]]),
      listWorkspaceProjects: () => [workspaceRow],
      updateWorkspaceProject: updateWorkspaceProject ?? noop,
      rebindWorkspaceProject: rebindWorkspaceProject ?? noop,
    },
    projectFiles: {
      writeProjectFile: noop,
      readProjectFile: noop,
      ensureProject: noop,
      listFiles: () => [],
      listTabs: () => [],
      setTabs: noop,
      resolveProjectDir: () => '',
    },
    conversations: { insertConversation: noop },
    templates: {
      getTemplate: noop,
      listTemplates: () => [],
      deleteTemplate: noop,
      insertTemplate: noop,
      findTemplateByNameAndProject: noop,
      updateTemplate: noop,
    },
    status: {
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      normalizeProjectDisplayStatus: (status: string) => status,
      composeProjectDisplayStatus: (status: unknown) => status,
      listProjects: () => [],
    },
    events: {
      subscribeFileEvents: noop,
      activeProjectEventSinks: new Map(),
    },
    ids: { randomId: () => 'id' },
    telemetry: { reportFinalizedMessage: noop },
    appConfig: { readAppConfig: vi.fn(async () => ({})), writeAppConfig: noop },
    agents: {},
    validation: {
      validateProjectDesignSystemId: async () => ({ ok: true, id: null }),
      validateProjectSkillId: async () => ({ ok: true, id: null }),
    },
  } as unknown as Parameters<typeof registerProjectRoutes>[1];
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('workspace project list authority cache boundary', () => {
  it('reuses the bounded read witness while mutations still require fresh authority', async () => {
    const workspaceId = 'project-list-read-workspace';
    const projectId = 'project-list-read-project';
    const memberId = 'project-list-read-member';
    const fetchDirectory = vi.fn(async (): Promise<WorkspaceDirectoryFetchResult> => ({
      ok: true,
      items: [{
        workspaceId,
        workspaceName: 'Project list read workspace',
        workspaceType: 'team',
        workspaceMemberId: memberId,
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      }],
    }));
    const authority = createWorkspaceDirectoryAuthorityBroker({
      fetchDirectory,
      identityKey: () => 'project-list-read-session',
      ttlMs: 15_000,
    });
    const verifyWith = (
      fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>,
    ) => (req: express.Request) => verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory,
    });
    const deps = workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
    }) as any;
    deps.verifyWorkspaceReadAuthority = verifyWith(authority.read);
    deps.verifyWorkspaceRequestAuthority = verifyWith(authority.fresh);

    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, deps);
    const routeServer = await listen(app);
    const headers = {
      'content-type': 'application/json',
      'x-od-workspace-id': workspaceId,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-type': 'team',
      'x-od-workspace-role': 'owner',
    };

    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(
          `${routeServer.url}/api/workspaces/${workspaceId}/projects?view=drafts`,
          { headers },
        );
        expect(response.status, await response.text()).toBe(200);
      }
      expect(fetchDirectory).toHaveBeenCalledTimes(1);

      const mutation = await fetch(
        `${routeServer.url}/api/workspaces/${workspaceId}/projects/batch-delete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectIds: [projectId] }),
        },
      );
      expect(mutation.status).toBe(200);
      expect(fetchDirectory).toHaveBeenCalledTimes(2);
    } finally {
      await close(routeServer.server);
    }
  });
});

describe('GET /api/projects/:id/workspace-scope route bootstrap', () => {
  const projectId = 'route-bootstrap-project-a';
  const workspaceId = 'route-bootstrap-workspace-a';
  const memberId = 'route-bootstrap-member-a';
  const activeMembership = {
    workspaceId,
    workspaceName: 'Workspace A',
    workspaceType: 'team' as const,
    workspaceMemberId: memberId,
    role: 'member' as const,
    memberStatus: 'active' as const,
    lifecycleState: 'active' as const,
  };

  async function startBootstrapRoute(options: {
    directory?: () => Promise<WorkspaceDirectoryFetchResult>;
    resourceState?: string;
    unbound?: boolean;
  } = {}) {
    const deps = workspaceProjectRouteDeps({
      workspaceId,
      projectId,
      dbDeleteProject: vi.fn(),
      removeProjectDir: vi.fn(),
      workspaceRowOverrides: {
        workspaceVisibility: 'team',
        ...(options.resourceState ? { resourceState: options.resourceState } : {}),
      },
    }) as any;
    if (options.unbound) {
      deps.projectStore.getWorkspaceProject = () => null;
      deps.projectStore.getWorkspaceProjectByProjectId = () => null;
    }
    deps.fetchWorkspaceDirectory =
      options.directory
      ?? (async () => ({ ok: true, items: [activeMembership] }));
    deps.authorizeProjectRequest = vi.fn(async (
      req: express.Request,
      res: express.Response,
    ) => {
      if (options.unbound) return true;
      if (options.resourceState === 'deleted') {
        res.status(403).json({
          error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED' },
        });
        return false;
      }
      const claimedWorkspaceId = req.get('x-od-workspace-id');
      const claimedMemberId = req.get('x-od-workspace-member-id');
      if (!claimedWorkspaceId && !claimedMemberId) return true;
      if (!claimedWorkspaceId || !claimedMemberId) {
        res.status(400).json({
          error: { code: 'WORKSPACE_CONTEXT_INCOMPLETE' },
        });
        return false;
      }
      if (claimedWorkspaceId !== workspaceId) {
        res.status(403).json({
          error: { code: 'WORKSPACE_PROJECT_PERMISSION_DENIED' },
        });
        return false;
      }
      return true;
    });
    deps.http.sendApiError = (
      res: express.Response,
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => res.status(status).json({ error: { code, message, ...details } });
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, deps);
    return listen(app);
  }

  it('returns exact local scope and project content headerlessly', async () => {
    const routeServer = await startBootstrapRoute();
    try {
      const scope = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(scope.status).toBe(200);
      await expect(scope.json()).resolves.toMatchObject({
        scope: {
          kind: 'team',
          projectId,
          workspaceId,
          context: {
            workspaceId,
            workspaceMemberId: 'member-cleanup-fail',
          },
        },
      });

      const headerlessDetail = await fetch(
        `${routeServer.url}/api/projects/${projectId}`,
      );
      expect(headerlessDetail.status).toBe(200);
      const scopedDetail = await fetch(
        `${routeServer.url}/api/projects/${projectId}`,
        {
          headers: {
            'x-od-workspace-id': workspaceId,
            'x-od-workspace-member-id': memberId,
          },
        },
      );
      expect(scopedDetail.status).toBe(200);
    } finally {
      await close(routeServer.server);
    }
  });

  it('keeps partial and wrong explicit claims on the ordinary fail-closed gate', async () => {
    const routeServer = await startBootstrapRoute();
    try {
      const partial = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        { headers: { 'x-od-workspace-id': workspaceId } },
      );
      expect(partial.status).toBe(400);
      const wrong = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        {
          headers: {
            'x-od-workspace-id': 'wrong-workspace',
            'x-od-workspace-member-id': 'wrong-member',
          },
        },
      );
      expect(wrong.status).toBe(403);
    } finally {
      await close(routeServer.server);
    }
  });

  it('ignores stale directory membership but still hides a deleted local resource', async () => {
    const staleDirectoryCases = [
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, workspaceId: 'workspace-b' }],
        }),
      },
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, memberStatus: 'removed' as const }],
        }),
      },
      {
        directory: async () => ({
          ok: true,
          items: [{ ...activeMembership, lifecycleState: 'deleted' as const }],
        }),
      },
    ];
    for (const stale of staleDirectoryCases) {
      const routeServer = await startBootstrapRoute(stale);
      try {
        const response = await fetch(
          `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
        );
        expect(response.status).toBe(200);
      } finally {
        await close(routeServer.server);
      }
    }
    const deletedServer = await startBootstrapRoute({ resourceState: 'deleted' });
    try {
      const deleted = await fetch(
        `${deletedServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(deleted.status).toBe(403);
    } finally {
      await close(deletedServer.server);
    }
  });

  it('stays available on directory outage and returns 404 for a missing project', async () => {
    const directory = vi.fn(async () => {
      throw new Error('directory down');
    });
    const routeServer = await startBootstrapRoute({
      directory,
    });
    try {
      const outage = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(outage.status).toBe(200);
      await expect(outage.json()).resolves.toMatchObject({
        scope: { kind: 'team', workspaceId },
      });
      expect(directory).not.toHaveBeenCalled();
      const missing = await fetch(
        `${routeServer.url}/api/projects/missing-project/workspace-scope`,
      );
      expect(missing.status).toBe(404);
    } finally {
      await close(routeServer.server);
    }
  });

  it('keeps locked/frozen project reads available but read-only', async () => {
    const routeServer = await startBootstrapRoute({
      resourceState: 'frozen',
      directory: async () => ({
        ok: true,
        items: [{ ...activeMembership, lifecycleState: 'locked' as const }],
      }),
    });
    try {
      const response = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        scope: {
          kind: 'team',
          workspaceId,
          context: {
            lifecycleState: 'locked',
            permissions: {
              canShareProjects: false,
              canWriteSyncedFiles: false,
            },
          },
        },
      });
    } finally {
      await close(routeServer.server);
    }
  });

  it('preserves signed-out headerless scope and detail for an unbound local project', async () => {
    const routeServer = await startBootstrapRoute({
      unbound: true,
      directory: async () => {
        throw new Error('signed out');
      },
    });
    try {
      const scope = await fetch(
        `${routeServer.url}/api/projects/${projectId}/workspace-scope`,
      );
      expect(scope.status).toBe(200);
      await expect(scope.json()).resolves.toEqual({
        scope: {
          kind: 'unbound',
          projectId,
          workspaceId: null,
          context: null,
        },
      });
      expect(
        (await fetch(`${routeServer.url}/api/projects/${projectId}`)).status,
      ).toBe(200);
    } finally {
      await close(routeServer.server);
    }
  });
});
