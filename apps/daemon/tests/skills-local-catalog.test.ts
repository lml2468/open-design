import type http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { openDatabase } from '../src/db.js';
import {
  hasLegacyWorkspaceResource,
  seedLegacyWorkspaceResource,
} from './helpers/legacy-workspace-resources.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;
let userSkillsDir: string;

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
  userSkillsDir = path.join(process.env.OD_DATA_DIR!, 'skills');
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function workspaceHeaders(workspaceId: string, memberId: string) {
  return {
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-member-id': memberId,
    'x-od-workspace-role': 'member',
  };
}

async function seedSkillFolder(skillId: string): Promise<string> {
  const folder = path.join(userSkillsDir, skillId);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'note.txt'), `${skillId}-asset`);
  await writeFile(
    path.join(folder, 'SKILL.md'),
    `---\nname: "${skillId}"\ndescription: "Test skill ${skillId}."\n---\n\nBody for ${skillId}.\n`,
  );
  return folder;
}

async function listSkillIds(headers?: Record<string, string>): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/skills`, headers ? { headers } : undefined);
  expect(response.status).toBe(200);
  const body = await response.json() as { skills: Array<{ id: string }> };
  return body.skills.map((skill) => skill.id);
}

describe('Skills daemon-local catalog', () => {
  it('returns the same local skill catalog regardless of Workspace headers or legacy bindings', async () => {
    const skillId = `local-catalog-${Date.now()}`;
    await seedSkillFolder(skillId);
    const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
    seedLegacyWorkspaceResource(db, {
      resourceType: 'skill',
      resourceId: skillId,
      workspaceId: 'legacy-workspace',
      visibility: 'personal',
      resourceState: 'active',
      createdByWorkspaceMemberId: 'legacy-owner',
      updatedByWorkspaceMemberId: 'legacy-owner',
    });

    const [headerless, owner, other] = await Promise.all([
      listSkillIds(),
      listSkillIds(workspaceHeaders('legacy-workspace', 'legacy-owner')),
      listSkillIds(workspaceHeaders('different-workspace', 'different-member')),
    ]);

    expect(headerless).toContain(skillId);
    expect(owner).toContain(skillId);
    expect(other).toContain(skillId);

    const detail = await fetch(`${baseUrl}/api/skills/${skillId}`, {
      headers: workspaceHeaders('different-workspace', 'different-member'),
    });
    const files = await fetch(`${baseUrl}/api/skills/${skillId}/files`, {
      headers: workspaceHeaders('different-workspace', 'different-member'),
    });
    expect(detail.status).toBe(200);
    expect(files.status).toBe(200);
  });

  it('does not create a Workspace binding when importing with legacy headers', async () => {
    const skillId = `local-import-${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/skills/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...workspaceHeaders('legacy-workspace', 'legacy-owner'),
      },
      body: JSON.stringify({
        name: skillId,
        description: 'Imported locally',
        body: 'Local body',
      }),
    });

    expect(response.status).toBe(201);
    const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
    expect(hasLegacyWorkspaceResource(db, 'skill', skillId)).toBe(false);
    expect(await listSkillIds(workspaceHeaders('other-workspace', 'other-member')))
      .toContain(skillId);
  });

  it('allows local update and delete independently of stale Workspace bindings', async () => {
    const skillId = `local-mutation-${Date.now()}`;
    const folder = await seedSkillFolder(skillId);
    const db = openDatabase(process.cwd(), { dataDir: process.env.OD_DATA_DIR! });
    seedLegacyWorkspaceResource(db, {
      resourceType: 'skill',
      resourceId: skillId,
      workspaceId: 'legacy-workspace',
      visibility: 'personal',
      resourceState: 'active',
      createdByWorkspaceMemberId: 'legacy-owner',
      updatedByWorkspaceMemberId: 'legacy-owner',
    });

    const update = await fetch(`${baseUrl}/api/skills/${skillId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...workspaceHeaders('other-workspace', 'other-member'),
      },
      body: JSON.stringify({ name: skillId, body: 'Updated locally' }),
    });
    expect(update.status).toBe(200);

    const remove = await fetch(`${baseUrl}/api/skills/${skillId}`, {
      method: 'DELETE',
      headers: workspaceHeaders('other-workspace', 'other-member'),
    });
    expect(remove.status).toBe(200);
    expect(existsSync(folder)).toBe(false);
  });
});
