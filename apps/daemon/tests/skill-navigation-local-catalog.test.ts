import express from 'express';
import type http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-skill-navigation-local-'));
  roots.push(root);
  const dir = path.join(root, 'local-skill');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'example.html'), '<img src="./assets/value.txt"><p>local</p>');
  await writeFile(path.join(dir, 'assets', 'value.txt'), 'local-bytes');
  const entry = {
    id: 'local-skill',
    name: 'Local skill',
    description: 'Daemon-local skill',
    body: '# Local skill',
    dir,
    source: 'user' as const,
  };

  const app = express();
  const paths = {
    ARTIFACTS_DIR: path.join(root, 'artifacts'),
    BRANDS_DIR: path.join(root, 'brands'),
    BUNDLED_PETS_DIR: path.join(root, 'pets'),
    CRAFT_DIR: path.join(root, 'craft'),
    DESIGN_SYSTEMS_DIR: path.join(root, 'design-systems'),
    DESIGN_TEMPLATES_DIR: path.join(root, 'design-templates'),
    LIBRARY_DIR: path.join(root, 'library'),
    OD_BIN: path.join(root, 'od'),
    PROJECT_ROOT: root,
    PROJECTS_DIR: path.join(root, 'projects'),
    PROMPT_TEMPLATES_DIR: path.join(root, 'prompt-templates'),
    RUNTIME_DATA_DIR: path.join(root, 'data'),
    RUNTIME_DATA_DIR_CANONICAL: path.join(root, 'data'),
    SKILLS_DIR: path.join(root, 'skills'),
    USER_DESIGN_SYSTEMS_DIR: path.join(root, 'user-design-systems'),
    USER_DESIGN_TEMPLATES_DIR: path.join(root, 'user-design-templates'),
    USER_SKILLS_DIR: path.join(root, 'user-skills'),
  };
  registerStaticResourceRoutes(app, {
    http: {
      createSseResponse: () => undefined,
      getPublicBaseUrl: () => '',
      isLocalSameOrigin: () => true,
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      resolvedPortRef: { current: 0 },
      sendApiError: (
        res: express.Response,
        status: number,
        code: string,
        message: string,
      ) => res.status(status).json({ error: code, message }),
      sendLiveArtifactRouteError: () => undefined,
      sendMulterError: () => undefined,
    },
    paths,
    resources: {
      listAllDesignSystems: async () => [],
      listAllSkills: async () => [],
      listAllDesignTemplates: async () => [],
      listAllSkillLikeEntries: async () => [entry as never],
      mimeFor: () => 'text/plain',
    },
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

describe('Skill example and asset daemon-local catalog', () => {
  it('serves the same local bytes without propagating Workspace query parameters', async () => {
    const baseUrl = await fixture();
    const example = await fetch(
      `${baseUrl}/api/skills/local-skill/example?workspaceId=legacy&workspaceMemberId=legacy-member`,
    );

    expect(example.status).toBe(200);
    const html = await example.text();
    expect(html).toContain('<p>local</p>');
    expect(html).toContain('/api/skills/local-skill/assets/value.txt');
    expect(html).not.toContain('workspaceId=');

    const asset = await fetch(`${baseUrl}/api/skills/local-skill/assets/value.txt`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('local-bytes');
  });

  it('ignores incomplete or conflicting legacy Workspace query parameters', async () => {
    const baseUrl = await fixture();
    const response = await fetch(
      `${baseUrl}/api/skills/local-skill/assets/value.txt?workspaceId=legacy`,
      {
        headers: {
          'x-od-workspace-id': 'different',
          'x-od-workspace-member-id': 'different-member',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('local-bytes');
  });
});
