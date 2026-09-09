// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenUIInbox } from '../../src/components/GenUIInbox';

const SURFACE = {
  id: 'row-1',
  surfaceId: 'approval-1',
  projectId: 'project-1',
  kind: 'confirmation',
  persist: 'project',
  status: 'resolved',
  requestedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenUIInbox local Project transport', () => {
  it('does not send retired Workspace authority for list and revoke', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/revoke')) return Response.json({ ok: true });
      return Response.json({ surfaces: [SURFACE] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GenUIInbox projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has('x-od-workspace-id')).toBe(false);
      expect(headers.has('x-od-workspace-member-id')).toBe(false);
      expect(headers.has('x-od-workspace-can-write-synced-files')).toBe(false);
    }
  });

  it('keeps legacy unbound requests headerless', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ surfaces: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<GenUIInbox projectId="legacy-project" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('x-od-workspace-id')).toBe(false);
  });
});
