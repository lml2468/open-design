import { describe, expect, it, vi } from 'vitest';
import {
  CollaborationServerClient,
  CollaborationServerRequestError,
  normalizeCollaborationServerOrigin,
} from '../../src/collaboration/server-client.js';

describe('CollaborationServerClient', () => {
  it('accepts HTTPS and loopback HTTP origins but rejects unsafe origins', () => {
    expect(normalizeCollaborationServerOrigin('https://design.example.test/')).toBe(
      'https://design.example.test',
    );
    expect(normalizeCollaborationServerOrigin('http://127.0.0.1:8787')).toBe(
      'http://127.0.0.1:8787',
    );
    expect(() => normalizeCollaborationServerOrigin('http://design.example.test')).toThrow(
      CollaborationServerRequestError,
    );
    expect(() => normalizeCollaborationServerOrigin('https://user:pass@example.test')).toThrow(
      CollaborationServerRequestError,
    );
    expect(() => normalizeCollaborationServerOrigin('https://example.test/api')).toThrow(
      CollaborationServerRequestError,
    );
  });

  it('parses capabilities and refuses redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      return Response.json({
        apiVersion: 'v1',
        minimumDesktopVersion: '0.22.0',
        bundleSchemaVersions: [1],
        authModes: ['local'],
        projectAuthorityModes: ['local-authoritative'],
        features: ['owner-transfer', 'publish', 'review-comments'],
      });
    });
    const capabilities = await new CollaborationServerClient(
      'https://design.example.test',
      fetchImpl,
    ).getCapabilities();
    expect(capabilities.projectAuthorityModes).toEqual(['local-authoritative']);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://design.example.test/api/v1/capabilities'),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('normalizes remote Problem responses without exposing response bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          type: 'about:blank',
          title: 'Authentication required',
          status: 401,
          code: 'authentication_required',
          requestId: 'req_1',
          retryable: false,
        },
        { status: 401 },
      ),
    );
    const client = new CollaborationServerClient('https://design.example.test', fetchImpl);
    await expect(client.listProjects('secret-token')).rejects.toMatchObject({
      status: 401,
      code: 'authentication_required',
      requestId: 'req_1',
    });
  });

  it('publishes multipart Bundles with optimistic concurrency and idempotency headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      expect(headers.get('authorization')).toBe('Bearer access-token');
      expect(headers.get('idempotency-key')).toBe('publish-key');
      expect(headers.get('if-match')).toBe('"project-7"');
      expect(headers.has('content-type')).toBe(false);
      const body = init?.body as FormData;
      expect(body.get('manifest')).toBe('{"schemaVersion":1}');
      expect(body.get('bundle')).toBeInstanceOf(Blob);
      return Response.json({
        version: {
          id: 'ver_1',
          projectId: 'prj_1',
          number: 3,
          mode: 'preview-only',
          entrypoint: 'preview/index.html',
          manifestSha256: 'a'.repeat(64),
          bundleSha256: 'b'.repeat(64),
          createdByUserId: 'usr_1',
          createdAt: '2026-09-06T10:00:00.000Z',
        },
        projectRevision: 8,
        publishedVersionId: 'ver_1',
        desktopDeepLink: 'opendesign://collaboration/review/open?project_id=prj_1',
      });
    });
    const client = new CollaborationServerClient('https://design.example.test', fetchImpl);

    const result = await client.publishProject('access-token', {
      projectId: 'prj_1',
      projectRevision: 7,
      idempotencyKey: 'publish-key',
      manifest: { schemaVersion: 1 },
      archive: Buffer.from('zip'),
    });

    expect(result.projectRevision).toBe(8);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://design.example.test/api/v1/projects/prj_1/publishes'),
      expect.any(Object),
    );
  });

  it('reads immutable files and sends comment provenance through authenticated review APIs', async () => {
    const calls: Array<{ path: string; headers: Headers; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      calls.push({
        path: `${url.pathname}${url.search}`,
        headers: new Headers(init?.headers),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.pathname.endsWith('/file')) return new Response(Buffer.from('<h1>review</h1>'));
      return Response.json({
        id: 'comment-1',
        projectId: 'project-1',
        versionId: 'version-1',
        target: {
          filePath: 'preview/index.html',
          selectionKind: 'visual',
          position: { x: 0.5, y: 0.5, width: 0, height: 0 },
        },
        note: 'Tighten spacing',
        source: 'agent',
        agent: { name: 'Review Bot', model: 'review-model' },
        attachments: [],
        authorUserId: 'reviewer-1',
        status: 'open',
        addressedInVersionId: null,
        revision: 1,
        createdAt: '2026-09-06T12:00:00.000Z',
        updatedAt: '2026-09-06T12:00:00.000Z',
      }, { status: 201 });
    });
    const client = new CollaborationServerClient('https://design.example.test', fetchImpl);
    const bytes = await client.readVersionFile(
      'access-token',
      'project-1',
      'version-1',
      'preview/index.html',
    );
    expect(bytes.toString()).toBe('<h1>review</h1>');
    await client.createComment('access-token', 'project-1', {
      versionId: 'version-1',
      target: {
        filePath: 'preview/index.html',
        selectionKind: 'visual',
        position: { x: 0.5, y: 0.5, width: 0, height: 0 },
      },
      note: 'Tighten spacing',
      source: 'agent',
      agent: { name: 'Review Bot', model: 'review-model' },
      attachmentIds: [],
    }, 'comment-key');

    expect(calls[0]?.path).toContain('path=preview%2Findex.html');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer access-token');
    expect(calls[1]?.headers.get('idempotency-key')).toBe('comment-key');
    expect(calls[1]?.body).toMatchObject({
      source: 'agent',
      agent: { name: 'Review Bot', model: 'review-model' },
    });
  });

  it('uses authenticated Project member and invitation endpoints with optimistic concurrency', async () => {
    const calls: Array<{ path: string; method: string; headers: Headers; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input.toString());
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.pathname.endsWith('/members')) return Response.json({ members: [] });
      if (url.pathname.endsWith('/invitations') && init?.method === 'POST') {
        return Response.json({
          id: 'inv-1',
          projectId: 'project-1',
          email: 'reviewer@example.test',
          role: 'reviewer',
          expiresAt: '2026-09-15T00:00:00.000Z',
          desktopDeepLink: 'opendesign://collaboration/invite/continue?server=https%3A%2F%2Fdesign.example.test&invite_id=inv-1&nonce=abcdefghijklmnopqrstuvwxyz123456',
        }, { status: 201 });
      }
      if (url.pathname.endsWith('/invitations')) return Response.json({ invitations: [] });
      return new Response(null, { status: 204 });
    });
    const client = new CollaborationServerClient('https://design.example.test', fetchImpl);
    await client.listProjectMembers('access-token', 'project-1');
    await client.listProjectInvitations('access-token', 'project-1');
    await client.createProjectInvitation('access-token', {
      projectId: 'project-1', projectRevision: 3, email: 'reviewer@example.test', idempotencyKey: 'invite-key',
    });
    await client.revokeProjectInvitation('access-token', {
      projectId: 'project-1', invitationId: 'inv-1', projectRevision: 4,
    });
    await client.removeProjectReviewer('access-token', {
      projectId: 'project-1', userId: 'reviewer-1', projectRevision: 5,
    });
    expect(calls[2]?.headers.get('if-match')).toBe('"project-3"');
    expect(calls[2]?.headers.get('idempotency-key')).toBe('invite-key');
    expect(calls[3]?.path).toContain('/invitations/inv-1');
    expect(calls[3]?.headers.get('if-match')).toBe('"project-4"');
    expect(calls[4]?.path).toContain('/members/reviewer-1');
    expect(calls[4]?.headers.get('if-match')).toBe('"project-5"');
  });
});
