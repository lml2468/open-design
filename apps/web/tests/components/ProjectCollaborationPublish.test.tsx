// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectCollaborationPublish } from '../../src/components/collaboration/ProjectCollaborationPublish';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

const binding = {
  localProjectId: 'local-project-1',
  serverOrigin: 'https://design.example.test',
  remoteProjectId: 'prj_1',
  authorityMode: 'local-authoritative' as const,
  remoteRevision: 1,
  publishedVersionId: null,
  lastPublishedVersionNumber: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

const candidate = {
  schemaVersion: 1 as const,
  mode: 'preview-only' as const,
  entrypoint: 'preview/index.html',
  files: [{
    path: 'preview/index.html',
    role: 'preview' as const,
    sha256: 'a'.repeat(64),
    size: 14,
    mimeType: 'text/html',
  }],
  totalBytes: 14,
  fingerprint: 'b'.repeat(64),
};

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('ProjectCollaborationPublish', () => {
  it('requires reviewing and confirming the complete candidate before Publish', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith('/members')) return Response.json({ members: [] });
      if (url.endsWith('/invitations')) return Response.json({ invitations: [] });
      if (method === 'GET') {
        return Response.json({ localProjectId: 'local-project-1', binding });
      }
      if (url.endsWith('/publish-candidate')) return Response.json(candidate);
      if (url.endsWith('/publish')) {
        return Response.json({
          binding: {
            ...binding,
            remoteRevision: 2,
            publishedVersionId: 'ver_1',
            lastPublishedVersionNumber: 1,
          },
          version: {
            id: 'ver_1',
            projectId: 'prj_1',
            number: 1,
            mode: 'preview-only',
            entrypoint: 'preview/index.html',
            manifestSha256: 'c'.repeat(64),
            bundleSha256: 'd'.repeat(64),
            createdByUserId: 'usr_1',
            createdAt: '2026-09-06T00:01:00.000Z',
          },
          projectRevision: 2,
          publishedVersionId: 'ver_1',
          desktopDeepLink: 'opendesign://collaboration/review/open?version_id=ver_1',
        }, { status: 201 });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <ProjectCollaborationPublish projectId="local-project-1" onOpenSettings={() => undefined} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish for team review' }));
    expect(await screen.findByText('prj_1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review Publish files' }));
    expect((await screen.findAllByText('preview/index.html')).length).toBe(2);
    const publish = screen.getByRole('button', { name: 'Publish version' });
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(publish).not.toBeDisabled();
    fireEvent.click(publish);

    expect(await screen.findByText('Version 1 published')).toBeTruthy();
    const publishRequest = requests.find(({ url }) => url.endsWith('/publish'));
    expect(publishRequest?.body).toEqual({
      candidateFingerprint: candidate.fingerprint,
      confirmedPaths: ['preview/index.html'],
      entrypoint: 'preview/index.html',
    });
    expect(requests.every(({ url }) => url.startsWith('/api/projects/local-project-1/collaboration'))).toBe(true);
  });

  it('projects selected owner feedback into the active Agent conversation', async () => {
    const onAttachReviewComments = vi.fn();
    const projected = {
      id: 'review_local_1',
      projectId: 'local-project-1',
      conversationId: 'conversation-1',
      filePath: 'index.html',
      elementId: 'hero-title',
      selector: '[data-od-id="hero-title"]',
      label: 'Hero title',
      text: 'Old title',
      position: { x: 10, y: 20, width: 200, height: 50 },
      htmlHint: '<h1>',
      note: 'Increase contrast',
      status: 'open',
      createdAt: 1,
      updatedAt: 1,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method && url.endsWith('/collaboration')) {
        return Response.json({
          localProjectId: 'local-project-1',
          binding: { ...binding, publishedVersionId: 'ver_1', lastPublishedVersionNumber: 1 },
        });
      }
      if (!init?.method && url.endsWith('/members')) return Response.json({ members: [] });
      if (!init?.method && url.endsWith('/invitations')) return Response.json({ invitations: [] });
      if (!init?.method && url.endsWith('/review-comments')) {
        return Response.json({
          version: {
            id: 'ver_1', projectId: 'prj_1', number: 1, mode: 'preview-only',
            entrypoint: 'preview/index.html', manifestSha256: 'c'.repeat(64),
            bundleSha256: 'd'.repeat(64), createdByUserId: 'owner-1',
            createdAt: '2026-09-06T00:00:00.000Z',
          },
          commentRevision: 1,
          comments: [{
            id: 'comment-1', projectId: 'prj_1', versionId: 'ver_1',
            target: {
              filePath: 'preview/index.html', selectionKind: 'element',
              elementId: 'hero-title', selector: '[data-od-id="hero-title"]',
              position: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
            },
            note: 'Increase contrast', source: 'human', attachments: [],
            authorUserId: 'reviewer-1', status: 'open', addressedInVersionId: null,
            revision: 1, createdAt: '2026-09-06T00:00:00.000Z',
            updatedAt: '2026-09-06T00:00:00.000Z',
          }],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/preview-comments')) {
        expect(JSON.parse(String(init.body))).toEqual({
          conversationId: 'conversation-1',
          versionId: 'ver_1',
          commentIds: ['comment-1'],
        });
        return Response.json({ comments: [projected] });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <ProjectCollaborationPublish
          projectId="local-project-1"
          conversationId="conversation-1"
          onOpenSettings={() => undefined}
          onAttachReviewComments={onAttachReviewComments}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish for team review' }));
    expect(await screen.findByText('prj_1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load feedback' }));
    const feedback = await screen.findByText('Increase contrast');
    fireEvent.click(feedback.closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1 to Agent' }));

    expect(await screen.findByText('1 review comments are ready in the composer.')).toBeTruthy();
    expect(onAttachReviewComments).toHaveBeenCalledWith([projected]);
  });

  it('creates a one-time reviewer invitation and can remove an existing reviewer', async () => {
    const clipboard = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const inviteLink = 'opendesign://collaboration/invite/continue?server=https%3A%2F%2Fdesign.example.test&invite_id=inv-1&nonce=abcdefghijklmnopqrstuvwxyz123456';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/collaboration') && method === 'GET') {
        return Response.json({ localProjectId: 'local-project-1', binding });
      }
      if (url.endsWith('/members') && method === 'GET') {
        return Response.json({ members: [
          { userId: 'owner-1', displayName: 'Owner', email: 'owner@example.test', role: 'owner', createdAt: '2026-09-06T00:00:00.000Z' },
          { userId: 'reviewer-1', displayName: 'Reviewer', email: 'reviewer@example.test', role: 'reviewer', createdAt: '2026-09-06T00:00:00.000Z' },
        ] });
      }
      if (url.endsWith('/invitations') && method === 'GET') return Response.json({ invitations: [] });
      if (url.endsWith('/invitations') && method === 'POST') {
        return Response.json({
          binding: { ...binding, remoteRevision: 2 },
          invitation: {
            id: 'inv-1', projectId: 'prj_1', email: 'next@example.test', role: 'reviewer',
            expiresAt: '2026-09-15T00:00:00.000Z', desktopDeepLink: inviteLink,
          },
        }, { status: 201 });
      }
      if (url.endsWith('/members/reviewer-1') && method === 'DELETE') {
        return Response.json({ localProjectId: 'local-project-1', binding: { ...binding, remoteRevision: 3 } });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <ProjectCollaborationPublish projectId="local-project-1" onOpenSettings={() => undefined} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish for team review' }));
    expect(await screen.findByText('reviewer@example.test')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reviewer email'), { target: { value: 'next@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy invitation link' }));
    expect(clipboard).toHaveBeenCalledWith(inviteLink);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('No reviewers yet.')).toBeTruthy();
  });
});
