import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerCollaborationServerRoutes,
  type RegisterCollaborationServerRoutesDeps,
} from '../../src/routes/collaboration-server.js';

const capabilities = {
  apiVersion: 'v1',
  minimumDesktopVersion: '0.22.0',
  bundleSchemaVersions: [1],
  authModes: ['local'],
  projectAuthorityModes: ['local-authoritative'],
  features: ['publish', 'review-comments'],
};

const user = { id: 'user-1', email: 'owner@example.test', displayName: 'Owner' };
const session = {
  user,
  sessionId: 'session-1',
  accessToken: 'access-token-000000000000000000000001',
  refreshToken: 'refresh-token-00000000000000000000001',
  tokenType: 'Bearer',
  expiresIn: 60,
};

const project = {
  id: 'project-1',
  name: 'Launch Website',
  createdByUserId: 'user-1',
  ownerUserId: 'user-1',
  callerRole: 'owner',
  authorityMode: 'local-authoritative',
  sourceProjectId: 'local-project-1',
  status: 'active',
  revision: 1,
  publishedVersionId: 'version-1',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
});

async function startRoutes(
  fetchImpl: typeof fetch,
  now = () => new Date('2026-09-06T00:00:00.000Z'),
  projectDeps?: {
    project: { id: string; name: string; metadata?: unknown };
    files: Array<{ name: string; localPath: string; size: number; mtime: number; mime?: string }>;
    projectReviewComments?: NonNullable<RegisterCollaborationServerRoutesDeps['projectReviewComments']>;
  },
) {
  const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'od-collaboration-routes-'));
  const app = express();
  app.use(express.json());
  registerCollaborationServerRoutes(app, {
    runtimeDataDir,
    requireLocalDaemonRequest: (_request, _response, next) => next(),
    sendApiError: (response: Response, status, code, message, init) =>
      response.status(status).json({ error: { code, message, ...init } }),
    fetchImpl,
    now,
    ...(projectDeps ? {
      getProject: (projectId: string) => projectId === projectDeps.project.id ? projectDeps.project : null,
      listProjectFiles: async () => projectDeps.files,
      authorizeProjectRequest: async () => true,
      ...(projectDeps.projectReviewComments
        ? { projectReviewComments: projectDeps.projectReviewComments }
        : {}),
    } : {}),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server has no address');
  cleanupTasks.push(async () => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    await rm(runtimeDataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(baseUrl: string, route: string, init?: RequestInit) {
  const requestInit: RequestInit = {
    ...init,
    ...(init?.body
      ? { headers: { 'content-type': 'application/json', ...init.headers } }
      : {}),
  };
  const response = await fetch(`${baseUrl}${route}`, requestInit);
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

describe('Collaboration Server routes', () => {
  it('accepts a Project invitation through the daemon without exposing remote tokens', async () => {
    const reviewerSession = {
      ...session,
      user: { id: 'reviewer-1', email: 'reviewer@example.test', displayName: 'Reviewer' },
    };
    const reviewerProject = { ...project, callerRole: 'reviewer', ownerUserId: 'owner-1' };
    const remoteRequests: Array<{ path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      remoteRequests.push({
        path: url.pathname,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
      if (url.pathname.endsWith('/invitations/accept')) {
        return Response.json({ session: reviewerSession, project: reviewerProject, role: 'reviewer' });
      }
      if (url.pathname.endsWith('/projects')) return Response.json({ projects: [reviewerProject] });
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl);
    const result = await jsonRequest(baseUrl, '/api/collaboration/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        origin: 'https://design.example.test',
        invitationId: 'inv-1',
        token: 'abcdefghijklmnopqrstuvwxyz123456',
        password: 'a-long-secret-password',
        displayName: 'Reviewer',
        deviceName: 'Reviewer Mac',
      }),
    });
    expect(result).toMatchObject({
      status: 200,
      body: {
        state: { profile: { origin: 'https://design.example.test' }, session: { user: reviewerSession.user } },
        project: reviewerProject,
        role: 'reviewer',
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('access-token');
    expect(JSON.stringify(result.body)).not.toContain('refresh-token');
    expect(remoteRequests.at(-1)).toMatchObject({
      path: '/api/v1/invitations/accept',
      body: {
        token: 'abcdefghijklmnopqrstuvwxyz123456',
        password: 'a-long-secret-password',
        displayName: 'Reviewer',
        deviceName: 'Reviewer Mac',
      },
    });
  });

  it('keeps remote credentials in the daemon while exposing profile, session summary, and projects', async () => {
    const remoteRequests: Array<{ url: string; method: string; authorization?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      const authorization = new Headers(init?.headers).get('authorization');
      remoteRequests.push({
        url,
        method,
        ...(authorization ? { authorization } : {}),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith('/api/v1/capabilities')) return Response.json(capabilities);
      if (url.endsWith('/api/v1/auth/session') && method === 'POST') return Response.json(session);
      if (url.endsWith('/api/v1/projects')) return Response.json({ projects: [project] });
      if (url.endsWith('/api/v1/auth/session') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl);

    expect(await jsonRequest(baseUrl, '/api/collaboration/server')).toEqual({
      status: 200,
      body: { profile: null, session: null },
    });

    const configured = await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT',
      body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    expect(configured.status).toBe(200);

    const loggedIn = await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'a-long-secret-password',
        deviceName: 'Owner Mac',
      }),
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body).toMatchObject({
      session: { sessionId: 'session-1', user },
    });
    expect(JSON.stringify(loggedIn.body)).not.toContain('access-token');
    expect(JSON.stringify(loggedIn.body)).not.toContain('refresh-token');

    const projects = await jsonRequest(baseUrl, '/api/collaboration/projects');
    expect(projects).toEqual({ status: 200, body: { projects: [project] } });
    expect(remoteRequests.at(-1)).toMatchObject({
      url: 'https://design.example.test/api/v1/projects',
      authorization: `Bearer ${session.accessToken}`,
    });

    expect(await jsonRequest(baseUrl, '/api/collaboration/session', { method: 'DELETE' })).toEqual({
      status: 204,
      body: null,
    });
    expect(await jsonRequest(baseUrl, '/api/collaboration/server')).toMatchObject({
      body: { profile: { origin: 'https://design.example.test' }, session: null },
    });
  });

  it('rotates an expiring access token before listing projects', async () => {
    let nowMs = Date.parse('2026-09-06T00:00:00.000Z');
    const rotated = {
      ...session,
      sessionId: 'session-2',
      accessToken: 'rotated-access-token-00000000000000001',
      refreshToken: 'rotated-refresh-token-0000000000000001',
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/api/v1/capabilities')) return Response.json(capabilities);
      if (url.endsWith('/api/v1/auth/session/refresh')) {
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: session.refreshToken });
        return Response.json(rotated);
      }
      if (url.endsWith('/api/v1/auth/session')) return Response.json(session);
      if (url.endsWith('/api/v1/projects')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${rotated.accessToken}`);
        return Response.json({ projects: [project] });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl, () => new Date(nowMs));
    await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT',
      body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'a-long-secret-password',
        deviceName: 'Owner Mac',
      }),
    });

    nowMs += 31_000;
    const result = await jsonRequest(baseUrl, '/api/collaboration/projects');

    expect(result.status).toBe(200);
    expect(calls.slice(-2)).toEqual([
      'POST /api/v1/auth/session/refresh',
      'GET /api/v1/projects',
    ]);
  });

  it('creates a local binding and publishes only after a confirmed candidate', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'od-collaboration-project-'));
    cleanupTasks.push(() => rm(projectRoot, { recursive: true, force: true }));
    const previewPath = path.join(projectRoot, 'index.html');
    const preview = '<h1>Launch Website</h1>';
    await writeFile(previewPath, preview);
    const remoteRequests: Array<{ url: string; headers: Headers; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      remoteRequests.push({ url, headers: new Headers(init?.headers), body: init?.body });
      if (url.endsWith('/api/v1/capabilities')) return Response.json(capabilities);
      if (url.endsWith('/api/v1/auth/session')) return Response.json(session);
      if (url.endsWith('/api/v1/projects') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          name: 'Launch Website',
          authorityMode: 'local-authoritative',
          sourceProjectId: 'local-project-1',
        });
        return Response.json(project, { status: 201 });
      }
      if (url.endsWith('/api/v1/projects/project-1') && method === 'GET') {
        return Response.json(project);
      }
      if (url.endsWith('/api/v1/projects/project-1/publishes')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        const manifest = JSON.parse(String(form.get('manifest')));
        expect(manifest).toMatchObject({
          mode: 'preview-only',
          project: { sourceProjectId: 'local-project-1', name: 'Launch Website' },
          entrypoint: 'preview/index.html',
        });
        expect(JSON.stringify(manifest)).not.toContain(projectRoot);
        return Response.json({
          version: {
            id: 'ver_2',
            projectId: 'project-1',
            number: 2,
            mode: 'preview-only',
            entrypoint: 'preview/index.html',
            manifestSha256: 'a'.repeat(64),
            bundleSha256: 'b'.repeat(64),
            createdByUserId: 'user-1',
            createdAt: '2026-09-06T00:01:00.000Z',
          },
          projectRevision: 2,
          publishedVersionId: 'ver_2',
          desktopDeepLink: 'opendesign://collaboration/review/open?version_id=ver_2',
        }, { status: 201 });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(
      fetchImpl,
      () => new Date('2026-09-06T00:00:00.000Z'),
      {
        project: { id: 'local-project-1', name: 'Launch Website' },
        files: [{
          name: 'index.html',
          localPath: previewPath,
          size: Buffer.byteLength(preview),
          mtime: Date.now(),
          mime: 'text/html',
        }],
      },
    );
    await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT',
      body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'a-long-secret-password',
        deviceName: 'Owner Mac',
      }),
    });

    const bound = await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration', {
      method: 'POST',
      body: JSON.stringify({ mode: 'create' }),
    });
    expect(bound).toMatchObject({
      status: 201,
      body: { binding: { remoteProjectId: 'project-1', remoteRevision: 1 } },
    });
    const previewResult = await jsonRequest(
      baseUrl,
      '/api/projects/local-project-1/collaboration/publish-candidate',
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(previewResult).toMatchObject({
      status: 200,
      body: { entrypoint: 'preview/index.html', files: [{ path: 'preview/index.html' }] },
    });
    const candidate = previewResult.body as { fingerprint: string; files: Array<{ path: string }> };
    const published = await jsonRequest(
      baseUrl,
      '/api/projects/local-project-1/collaboration/publish',
      {
        method: 'POST',
        body: JSON.stringify({
          candidateFingerprint: candidate.fingerprint,
          confirmedPaths: candidate.files.map((file) => file.path),
        }),
      },
    );
    expect(published).toMatchObject({
      status: 201,
      body: {
        projectRevision: 2,
        publishedVersionId: 'ver_2',
        binding: { remoteRevision: 2, lastPublishedVersionNumber: 2 },
      },
    });
    const publishRequest = remoteRequests.find(({ url }) => url.endsWith('/publishes'));
    expect(publishRequest?.headers.get('if-match')).toBe('"project-1"');
    expect(publishRequest?.headers.get('idempotency-key')).toBeTruthy();
  });

  it('manages Project reviewers and one-time invitations through a local binding', async () => {
    let revision = 1;
    const requests: Array<{ path: string; method: string; headers: Headers }> = [];
    const currentProject = () => ({ ...project, revision });
    const invitation = {
      id: 'inv-1',
      projectId: 'project-1',
      email: 'reviewer@example.test',
      role: 'reviewer',
      expiresAt: '2026-09-15T00:00:00.000Z',
      desktopDeepLink: 'opendesign://collaboration/invite/continue?server=https%3A%2F%2Fdesign.example.test&invite_id=inv-1&nonce=abcdefghijklmnopqrstuvwxyz123456',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      requests.push({ path: url.pathname, method, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
      if (url.pathname.endsWith('/auth/session')) return Response.json(session);
      if (url.pathname === '/api/v1/projects' && method === 'POST') return Response.json(currentProject(), { status: 201 });
      if (url.pathname === '/api/v1/projects/project-1') return Response.json(currentProject());
      if (url.pathname.endsWith('/members') && method === 'GET') {
        return Response.json({ members: [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'owner', createdAt: project.createdAt }] });
      }
      if (url.pathname.endsWith('/invitations') && method === 'GET') {
        return Response.json({ invitations: [] });
      }
      if (url.pathname.endsWith('/invitations') && method === 'POST') {
        expect(new Headers(init?.headers).get('if-match')).toBe('"project-1"');
        revision = 2;
        return Response.json(invitation, { status: 201 });
      }
      if (url.pathname.endsWith('/invitations/inv-1') && method === 'DELETE') {
        expect(new Headers(init?.headers).get('if-match')).toBe('"project-2"');
        revision = 3;
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/members/reviewer-1') && method === 'DELETE') {
        expect(new Headers(init?.headers).get('if-match')).toBe('"project-3"');
        revision = 4;
        return new Response(null, { status: 204 });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl, undefined, {
      project: { id: 'local-project-1', name: 'Launch Website' },
      files: [],
    });
    await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT', body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, password: 'a-long-secret-password', deviceName: 'Owner Mac' }),
    });
    await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration', {
      method: 'POST', body: JSON.stringify({ mode: 'create' }),
    });
    expect(await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration/members')).toMatchObject({ status: 200, body: { members: [{ role: 'owner' }] } });
    expect(await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration/invitations')).toEqual({ status: 200, body: { invitations: [] } });
    expect(await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration/invitations', {
      method: 'POST', body: JSON.stringify({ email: invitation.email }),
    })).toMatchObject({ status: 201, body: { invitation: { id: 'inv-1' }, binding: { remoteRevision: 2 } } });
    expect(await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration/invitations/inv-1', { method: 'DELETE' })).toMatchObject({ status: 200, body: { binding: { remoteRevision: 3 } } });
    expect(await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration/members/reviewer-1', { method: 'DELETE' })).toMatchObject({ status: 200, body: { binding: { remoteRevision: 4 } } });
    expect(requests.some(({ path }) => path.endsWith('/members/reviewer-1'))).toBe(true);
  });

  it('materializes a verified reviewer Snapshot and relays human or Agent comments', async () => {
    const html = Buffer.from('<!doctype html><h1>Review</h1>');
    const version = {
      id: 'version-1',
      projectId: 'project-1',
      number: 1,
      mode: 'preview-only',
      entrypoint: 'preview/index.html',
      manifestSha256: 'a'.repeat(64),
      bundleSha256: 'b'.repeat(64),
      createdByUserId: 'user-1',
      createdAt: '2026-09-06T00:01:00.000Z',
    };
    const manifest = {
      schemaVersion: 1,
      mode: 'preview-only',
      project: { sourceProjectId: 'local-project-1', name: 'Launch Website' },
      createdAt: '2026-09-06T00:01:00.000Z',
      entrypoint: 'preview/index.html',
      files: [{
        path: 'preview/index.html',
        role: 'preview',
        sha256: createHash('sha256').update(html).digest('hex'),
        size: html.byteLength,
        mimeType: 'text/html',
      }],
    };
    const remoteRequests: Array<{ path: string; method: string; headers: Headers; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      remoteRequests.push({
        path: `${url.pathname}${url.search}`,
        method,
        headers: new Headers(init?.headers),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
      if (url.pathname.endsWith('/auth/session')) return Response.json(session);
      if (url.pathname === '/api/v1/projects/project-1') return Response.json(project);
      if (url.pathname.endsWith('/published')) return Response.json(version);
      if (url.pathname.endsWith('/manifest')) return Response.json(manifest);
      if (url.pathname.endsWith('/file')) return new Response(new Uint8Array(html));
      if (url.pathname.endsWith('/comments') && method === 'GET') {
        return Response.json({ comments: [], commentRevision: 0 });
      }
      if (url.pathname.endsWith('/comments') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          id: 'comment-1',
          projectId: 'project-1',
          versionId: body.versionId,
          target: body.target,
          note: body.note,
          source: body.source,
          ...(body.agent ? { agent: body.agent } : {}),
          attachments: [],
          authorUserId: 'user-1',
          status: 'open',
          addressedInVersionId: null,
          revision: 1,
          createdAt: '2026-09-06T00:02:00.000Z',
          updatedAt: '2026-09-06T00:02:00.000Z',
        }, { status: 201 });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl);
    await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT',
      body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'a-long-secret-password',
        deviceName: 'Reviewer Mac',
      }),
    });

    const snapshot = await jsonRequest(
      baseUrl,
      '/api/collaboration/projects/project-1/review-snapshot',
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(snapshot).toMatchObject({
      status: 200,
      body: {
        project: { id: 'project-1' },
        version: { id: 'version-1' },
        manifest: { entrypoint: 'preview/index.html' },
      },
    });
    expect(JSON.stringify(snapshot.body)).not.toContain('access-token');
    const snapshotBody = snapshot.body as { entrypointUrl: string };
    const preview = await fetch(`${baseUrl}${snapshotBody.entrypointUrl}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe(html.toString());
    expect(preview.headers.get('content-security-policy')).toContain("connect-src 'none'");

    const created = await jsonRequest(
      baseUrl,
      '/api/collaboration/projects/project-1/review-comments',
      {
        method: 'POST',
        body: JSON.stringify({
          versionId: 'version-1',
          target: {
            filePath: 'preview/index.html',
            selectionKind: 'visual',
            position: { x: 0.4, y: 0.2, width: 0, height: 0 },
          },
          note: 'Increase contrast',
          source: 'human',
          attachmentIds: [],
        }),
      },
    );
    expect(created).toMatchObject({ status: 201, body: { id: 'comment-1' } });
    const commentRequest = remoteRequests.find(
      ({ path, method }) => path.endsWith('/comments') && method === 'POST',
    );
    expect(commentRequest?.headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
    expect(commentRequest?.headers.get('idempotency-key')).toBeTruthy();
  });

  it('lets the bound Owner idempotently project selected remote feedback into a local conversation', async () => {
    const version = {
      id: 'version-1', projectId: 'project-1', number: 1, mode: 'preview-only',
      entrypoint: 'preview/index.html', manifestSha256: 'a'.repeat(64),
      bundleSha256: 'b'.repeat(64), createdByUserId: 'user-1',
      createdAt: '2026-09-06T00:01:00.000Z',
    } as const;
    const reviewComment = {
      id: 'comment-1', projectId: 'project-1', versionId: 'version-1',
      target: {
        filePath: 'preview/index.html', selectionKind: 'visual',
        position: { x: 0.4, y: 0.2, width: 0, height: 0 },
      },
      note: 'Increase contrast', source: 'human', attachments: [],
      authorUserId: 'reviewer-1', status: 'open', addressedInVersionId: null,
      revision: 1, createdAt: '2026-09-06T00:02:00.000Z',
      updatedAt: '2026-09-06T00:02:00.000Z',
    } as const;
    const projectReviewComments = vi.fn<NonNullable<RegisterCollaborationServerRoutesDeps['projectReviewComments']>>(
      (input) => [{
        id: 'review-local-1', projectId: input.localProjectId,
        conversationId: input.conversationId, filePath: 'index.html',
        elementId: 'review-point-1', selector: 'html', label: 'Review feedback', text: '',
        position: { x: 0, y: 0, width: 0, height: 0 }, htmlHint: '',
        note: input.comments[0]!.note, status: 'open', createdAt: 1, updatedAt: 1,
      }],
    );
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
      if (url.pathname.endsWith('/auth/session')) return Response.json(session);
      if (url.pathname === '/api/v1/projects' && method === 'POST') return Response.json(project, { status: 201 });
      if (url.pathname === '/api/v1/projects/project-1') return Response.json(project);
      if (url.pathname.endsWith('/versions/version-1')) return Response.json(version);
      if (url.pathname.endsWith('/comments')) {
        return Response.json({ comments: [reviewComment], commentRevision: 1 });
      }
      return Response.json({ title: 'Not found' }, { status: 404 });
    });
    const baseUrl = await startRoutes(fetchImpl, undefined, {
      project: { id: 'local-project-1', name: 'Launch Website' },
      files: [],
      projectReviewComments,
    });
    await jsonRequest(baseUrl, '/api/collaboration/server', {
      method: 'PUT', body: JSON.stringify({ origin: 'https://design.example.test' }),
    });
    await jsonRequest(baseUrl, '/api/collaboration/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test', password: 'a-long-secret-password', deviceName: 'Owner Mac',
      }),
    });
    await jsonRequest(baseUrl, '/api/projects/local-project-1/collaboration', {
      method: 'POST', body: JSON.stringify({ mode: 'create' }),
    });

    const listed = await jsonRequest(
      baseUrl,
      '/api/projects/local-project-1/collaboration/review-comments?versionId=version-1',
    );
    expect(listed).toMatchObject({
      status: 200,
      body: { version: { id: 'version-1' }, comments: [{ id: 'comment-1' }] },
    });

    const projected = await jsonRequest(
      baseUrl,
      '/api/projects/local-project-1/collaboration/preview-comments',
      {
        method: 'POST',
        body: JSON.stringify({
          conversationId: 'conversation-1',
          versionId: 'version-1',
          commentIds: ['comment-1'],
        }),
      },
    );
    expect(projected).toMatchObject({
      status: 200,
      body: { comments: [{ id: 'review-local-1', note: 'Increase contrast' }] },
    });
    expect(projectReviewComments).toHaveBeenCalledWith(expect.objectContaining({
      localProjectId: 'local-project-1',
      conversationId: 'conversation-1',
      remoteProjectId: 'project-1',
      version,
      comments: [reviewComment],
    }));
  });
});
