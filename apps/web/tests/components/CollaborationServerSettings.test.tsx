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
});
