// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationServerSettings } from '../../src/components/collaboration/CollaborationServerSettings';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

const capabilities = {
  apiVersion: 'v1' as const,
  minimumDesktopVersion: '0.22.0',
  bundleSchemaVersions: [1],
  authModes: ['local'] as const,
  projectAuthorityModes: ['local-authoritative'] as const,
  features: ['publish', 'review-comments'] as const,
};

const project = {
  id: 'project-1',
  name: 'Launch Website',
  createdByUserId: 'user-1',
  ownerUserId: 'user-1',
  callerRole: 'owner' as const,
  authorityMode: 'local-authoritative' as const,
  sourceProjectId: 'local-project-1',
  status: 'active' as const,
  revision: 1,
  publishedVersionId: 'version-1',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('CollaborationServerSettings', () => {
  it('configures, signs in, and lists projects without contacting the remote server directly', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    let configured = false;
    let signedIn = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const profile = configured
        ? {
            id: 'default' as const,
            origin: 'https://design.example.test',
            capabilities,
            checkedAt: '2026-09-06T00:00:00.000Z',
          }
        : null;
      if (method === 'GET' && url === '/api/collaboration/server') {
        return Response.json({ profile, session: null });
      }
      if (method === 'PUT' && url === '/api/collaboration/server') {
        configured = true;
        return Response.json({
          profile: {
            id: 'default',
            origin: 'https://design.example.test',
            capabilities,
            checkedAt: '2026-09-06T00:00:00.000Z',
          },
          session: null,
        });
      }
      if (method === 'POST' && url === '/api/collaboration/login') {
        signedIn = true;
        return Response.json({
          profile: {
            id: 'default',
            origin: 'https://design.example.test',
            capabilities,
            checkedAt: '2026-09-06T00:00:00.000Z',
          },
          session: {
            sessionId: 'session-1',
            user: { id: 'user-1', email: 'owner@example.test', displayName: 'Owner' },
          },
        });
      }
      if (method === 'GET' && url === '/api/collaboration/projects' && signedIn) {
        return Response.json({ projects: [project] });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <CollaborationServerSettings />
      </I18nProvider>,
    );

    expect(await screen.findByText('No Collaboration Server configured')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://design.example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect server' }));
    expect(await screen.findByText('Connected')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a-long-secret-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Launch Website')).toBeTruthy();
    expect(screen.getByText('Signed in as Owner')).toBeTruthy();
    expect(document.body.textContent).not.toContain('a-long-secret-password');
    expect(requests.every(({ url }) => url.startsWith('/api/collaboration/'))).toBe(true);
    expect(requests.find(({ url }) => url === '/api/collaboration/login')?.body).toEqual({
      email: 'owner@example.test',
      password: 'a-long-secret-password',
      deviceName: 'OpenDesign Desktop',
    });
  });

  it('surfaces daemon errors and keeps the configured server editable', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() === '/api/collaboration/server' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ profile: null, session: null });
      }
      return Response.json(
        { error: { message: 'Server does not support local-authoritative Projects' } },
        { status: 409 },
      );
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <CollaborationServerSettings />
      </I18nProvider>,
    );
    const input = await screen.findByLabelText('Server URL');
    fireEvent.change(input, { target: { value: 'https://incompatible.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect server' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Server does not support local-authoritative Projects',
    );
    expect(input).toHaveValue('https://incompatible.example.test');
  });

  it('accepts a native invitation deeplink through the local daemon and removes the token from history', async () => {
    const token = 'abcdefghijklmnopqrstuvwxyz123456';
    window.history.replaceState(null, '', `/settings?collaboration_action=invitation&server=https%3A%2F%2Fdesign.example.test&invitation_id=inv-1&token=${token}`);
    const requests: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/collaboration/server') return Response.json({ profile: null, session: null });
      if (url === '/api/collaboration/invitations/accept') {
        return Response.json({
          state: {
            profile: { id: 'default', origin: 'https://design.example.test', capabilities, checkedAt: '2026-09-06T00:00:00.000Z' },
            session: { sessionId: 'session-2', user: { id: 'reviewer-1', email: 'reviewer@example.test', displayName: 'Reviewer' } },
          },
          project: { ...project, callerRole: 'reviewer', ownerUserId: 'user-1' },
          role: 'reviewer',
        });
      }
      if (url === '/api/collaboration/projects') {
        return Response.json({ projects: [{ ...project, callerRole: 'reviewer', ownerUserId: 'user-1' }] });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(<I18nProvider initial="en"><CollaborationServerSettings /></I18nProvider>);
    expect(await screen.findByText('Accept Project invitation')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Password')[0]!, { target: { value: 'a-long-secret-password' } });
    fireEvent.change(screen.getByLabelText('Display name (new accounts)'), { target: { value: 'Reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByText('Invitation accepted. The Project is now available for review.')).toBeTruthy();
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('');
    expect(requests.find(({ url }) => url === '/api/collaboration/invitations/accept')?.body).toMatchObject({
      origin: 'https://design.example.test', invitationId: 'inv-1', token, displayName: 'Reviewer',
    });
    expect(document.body.textContent).not.toContain(token);
  });

  it('opens the exact immutable Version named by a review deeplink', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings?collaboration_action=review&server=https%3A%2F%2Fdesign.example.test&project_id=project-1&version_id=version-locked',
    );
    const requests: Array<{ url: string; body?: unknown }> = [];
    const reviewerProject = { ...project, callerRole: 'reviewer' as const };
    const lockedVersion = {
      id: 'version-locked',
      projectId: 'project-1',
      number: 1,
      mode: 'preview-only' as const,
      entrypoint: 'preview/index.html',
      manifestSha256: 'a'.repeat(64),
      bundleSha256: 'b'.repeat(64),
      createdByUserId: 'user-1',
      createdAt: '2026-09-06T00:01:00.000Z',
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/collaboration/server') {
        return Response.json({
          profile: { id: 'default', origin: 'https://design.example.test', capabilities, checkedAt: '2026-09-06T00:00:00.000Z' },
          session: { sessionId: 'session-2', user: { id: 'reviewer-1', email: 'reviewer@example.test', displayName: 'Reviewer' } },
        });
      }
      if (url === '/api/collaboration/projects') return Response.json({ projects: [reviewerProject] });
      if (url.endsWith('/versions')) return Response.json({ versions: [lockedVersion] });
      if (url.endsWith('/review-snapshot')) {
        return Response.json({
          snapshotId: 'f'.repeat(64),
          project: reviewerProject,
          version: lockedVersion,
          manifest: {
            schemaVersion: 1,
            mode: 'preview-only',
            project: { sourceProjectId: 'local-project-1', name: project.name },
            createdAt: lockedVersion.createdAt,
            entrypoint: 'preview/index.html',
            files: [{
              path: 'preview/index.html',
              role: 'preview',
              sha256: 'c'.repeat(64),
              size: 42,
              mimeType: 'text/html',
            }],
          },
          entrypointUrl: `/api/collaboration/review-snapshots/${'f'.repeat(64)}/files/preview/index.html`,
          cachedAt: '2026-09-06T00:02:00.000Z',
        });
      }
      if (url.includes('/review-comments?')) return Response.json({ comments: [], commentRevision: 0 });
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(<I18nProvider initial="en"><CollaborationServerSettings /></I18nProvider>);

    expect(await screen.findByTitle('Published Project preview')).toBeTruthy();
    expect(requests.find(({ url }) => url.endsWith('/review-snapshot'))?.body).toEqual({
      versionId: 'version-locked',
    });
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.search).toBe('');
  });
});
