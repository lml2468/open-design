import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationServerProfileStore } from '../../src/collaboration/server-profile.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CollaborationServerProfileStore', () => {
  it('persists one profile while keeping bearer credentials out of public state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-collaboration-profile-'));
    roots.push(root);
    const store = new CollaborationServerProfileStore(root);
    await store.setProfile({
      origin: 'https://design.example.test',
      capabilities: capabilities(),
      checkedAt: '2026-09-06T10:00:00.000Z',
    });
    await store.setSession(session(), Date.parse('2026-09-06T10:00:00.000Z'));

    const publicState = await store.readPublicState();
    expect(publicState.session).toEqual({
      sessionId: 'ses_1',
      user: { id: 'usr_1', email: 'owner@example.com', displayName: 'Owner' },
    });
    expect(JSON.stringify(publicState)).not.toContain('access-secret');
    expect(JSON.stringify(publicState)).not.toContain('refresh-secret');

    const file = path.join(root, 'collaboration-server.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('refresh-secret');
  });

  it('clears the prior session when the configured origin changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-collaboration-profile-'));
    roots.push(root);
    const store = new CollaborationServerProfileStore(root);
    await store.setProfile({
      origin: 'https://one.example.test',
      capabilities: capabilities(),
      checkedAt: '2026-09-06T10:00:00.000Z',
    });
    await store.setSession(session());
    await store.setProfile({
      origin: 'https://two.example.test',
      capabilities: capabilities(),
      checkedAt: '2026-09-06T10:01:00.000Z',
    });
    expect((await store.readPublicState()).session).toBeNull();
  });
});

function capabilities() {
  return {
    apiVersion: 'v1',
    minimumDesktopVersion: '0.22.0',
    bundleSchemaVersions: [1],
    authModes: ['local'],
    projectAuthorityModes: ['local-authoritative'],
    features: ['owner-transfer', 'publish', 'review-comments'],
  };
}

function session() {
  return {
    user: { id: 'usr_1', email: 'owner@example.com', displayName: 'Owner' },
    sessionId: 'ses_1',
    accessToken: `access-secret-${'a'.repeat(32)}`,
    refreshToken: `refresh-secret-${'r'.repeat(32)}`,
    tokenType: 'Bearer' as const,
    expiresIn: 900,
  };
}
