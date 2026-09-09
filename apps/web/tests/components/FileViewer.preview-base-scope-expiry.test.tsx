// @vitest-environment jsdom
//
// URL-loaded documents receive a short-lived preview scope from the daemon.
// Keep that capability alive without navigating the iframe or changing its
// document identity.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const START_TIME = new Date('2026-08-20T10:00:00Z').getTime();
// Daemon-side PROJECT_PREVIEW_SCOPE_TTL_MS (apps/daemon/src/server.ts).
const PREVIEW_SCOPE_TTL_MS = 60 * 60 * 1000;
const PREVIEW_SCOPE_RENEW_MARGIN_MS = 5 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(START_TIME);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function htmlFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'deck.html',
      renderer: 'html',
      exports: ['html'],
    },
    ...overrides,
  };
}

const PREVIEW_URL_ROUTE = '/api/projects/project-1/preview-url';

/**
 * Fetch stub that mints a fresh scope id per `/preview-url` call, so the test
 * can tell a re-mint (scope-2) apart from a reused stale base (scope-1).
 */
function stubFetch() {
  const state = { mintCount: 0, renewCount: 0, failRenewal: false };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    if (url.startsWith(PREVIEW_URL_ROUTE)) {
      state.mintCount += 1;
      return new Response(
        JSON.stringify({
          url: `/api/projects/project-1/preview/scope-000${state.mintCount}/deck.html`,
          file: 'deck.html',
          csp: '',
          iframeSandbox: 'allow-scripts allow-forms',
          opaqueOrigin: true,
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/preview\/scope-\d+\/renew$/u.test(url)) {
      state.renewCount += 1;
      if (state.failRenewal) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({ expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }));
  return state;
}

describe('FileViewer URL-load preview base expiry', () => {
  it('renews the daemon-injected URL-load scope without navigating the iframe', async () => {
    const fetchState = stubFetch();

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(0);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
  });

  it('replaces a lost URL-load scope by messaging the live document', async () => {
    const fetchState = stubFetch();

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });
    fetchState.failRenewal = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(1);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
    expect(postMessage.mock.calls.some(([message]) => {
      const data = message as { type?: unknown; href?: unknown };
      return data.type === 'od:preview-base-update'
        && data.href === 'http://localhost:3000/api/projects/project-1/preview/scope-0001/';
    })).toBe(true);
  });
});
