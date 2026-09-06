// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationReviewDialog } from '../../src/components/collaboration/CollaborationReviewDialog';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const project = {
  id: 'project-1',
  name: 'Launch Website',
  createdByUserId: 'owner-1',
  ownerUserId: 'owner-1',
  callerRole: 'reviewer' as const,
  authorityMode: 'local-authoritative' as const,
  sourceProjectId: 'local-project-1',
  status: 'active' as const,
  revision: 2,
  publishedVersionId: 'version-1',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:01:00.000Z',
};

const version = {
  id: 'version-1',
  projectId: 'project-1',
  number: 1,
  mode: 'preview-only' as const,
  entrypoint: 'preview/index.html',
  manifestSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
  createdByUserId: 'owner-1',
  createdAt: '2026-09-06T00:01:00.000Z',
};

describe('CollaborationReviewDialog', () => {
  it('opens a daemon-served immutable Snapshot and submits a visual human comment', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith('/versions')) return Response.json({ versions: [version] });
      if (url.endsWith('/review-snapshot')) {
        return Response.json({
          snapshotId: 'f'.repeat(64),
          project,
          version,
          manifest: {
            schemaVersion: 1,
            mode: 'preview-only',
            project: { sourceProjectId: 'local-project-1', name: project.name },
            createdAt: version.createdAt,
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
      if (url.includes('/review-comments?')) {
        return Response.json({ comments: [], commentRevision: 0 });
      }
      if (url.endsWith('/review-comments') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          id: 'comment-1',
          projectId: project.id,
          ...body,
          attachments: [],
          authorUserId: 'reviewer-1',
          status: 'open',
          addressedInVersionId: null,
          revision: 1,
          createdAt: '2026-09-06T00:03:00.000Z',
          updatedAt: '2026-09-06T00:03:00.000Z',
        }, { status: 201 });
      }
      return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
    }) as typeof fetch;

    render(
      <I18nProvider initial="en">
        <CollaborationReviewDialog
          project={project}
          session={{
            sessionId: 'session-1',
            user: { id: 'reviewer-1', email: 'reviewer@example.test', displayName: 'Reviewer' },
          }}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(await screen.findByTitle('Published Project preview')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Place comment' }));
    const placement = screen.getByRole('button', {
      name: 'Choose a point on the preview for this comment',
    });
    vi.spyOn(placement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
      top: 0,
      right: 1000,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent.click(placement, { clientX: 400, clientY: 150 });
    fireEvent.change(screen.getByPlaceholderText('Describe what should change…'), {
      target: { value: 'Increase contrast' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit comment' }));

    expect(await screen.findByText('Increase contrast')).toBeTruthy();
    const submitted = requests.find(({ url, method }) =>
      url.endsWith('/review-comments') && method === 'POST');
    expect(submitted?.body).toMatchObject({
      versionId: 'version-1',
      note: 'Increase contrast',
      source: 'human',
      target: {
        filePath: 'preview/index.html',
        selectionKind: 'visual',
        position: { x: 0.4, y: 0.25 },
      },
    });
    expect(requests.every(({ url }) => url.startsWith('/api/collaboration/'))).toBe(true);
  });
});
