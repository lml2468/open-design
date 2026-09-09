import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _listMcpResources,
  _readMcpResource,
  createMcpDaemonTarget,
  OPEN_DESIGN_BRIEF_APP_RESOURCE,
} from '../src/mcp.js';

const originalFetch = globalThis.fetch;
const BASE = 'http://127.0.0.1:19001';

function target() {
  return createMcpDaemonTarget({ daemonUrl: BASE });
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('MCP resource catalog scope', () => {
  it('keeps Skills and Design Systems daemon-local', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/skills')) {
        return new Response(
          JSON.stringify({ skills: [{ id: 'deck', name: 'Deck', description: 'Build a deck.' }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/design-systems')) {
        return new Response(
          JSON.stringify({
            designSystems: [
              {
                id: 'brand-1',
                title: 'Personal Brand',
                summary: 'Owned by the personal workspace.',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _listMcpResources(target());

    expect(calls.some((c) => c.url.endsWith('/api/workspace/directory'))).toBe(false);
    const skillCall = calls.find((c) => c.url.endsWith('/api/skills'));
    const dsCall = calls.find((c) => c.url.endsWith('/api/design-systems'));
    expect(skillCall).toBeTruthy();
    expect(dsCall).toBeTruthy();
    expect(skillCall?.init?.headers).toBeUndefined();
    expect(dsCall?.init?.headers).toBeUndefined();

    // the personal design system actually shows up
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('od://skills/deck/SKILL.md');
    expect(uris).toContain('od://design-systems/brand-1/DESIGN.md');
  });

  it('list_resources does not consult Workspace context', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/skills')) {
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      if (url.endsWith('/api/design-systems')) {
        return new Response(JSON.stringify({ designSystems: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _listMcpResources(target());

    const skillCall = calls.find((c) => c.url.endsWith('/api/skills'));
    const dsCall = calls.find((c) => c.url.endsWith('/api/design-systems'));
    expect(calls.some((c) => c.url.endsWith('/api/workspace/directory'))).toBe(false);
    expect(skillCall?.init?.headers).toBeUndefined();
    expect(dsCall?.init?.headers).toBeUndefined();
    // Built-in resources still listed.
    expect(result.resources.some((r) => r.uri === OPEN_DESIGN_BRIEF_APP_RESOURCE)).toBe(true);
    expect(result.resources.some((r) => r.uri === 'od://focus/active')).toBe(true);
  });

  it('read_resource reads Design Systems without Workspace headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.match(/\/api\/design-systems\/[^/]+$/u)) {
        return new Response(
          JSON.stringify({
            designSystem: {
              id: 'brand-1',
              body: 'palette: indigo/violet\nfonts: Inter\nvoice: crisp',
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await _readMcpResource(target(), 'od://design-systems/brand-1/DESIGN.md');

    const read = calls.find((c) => c.url.endsWith('/api/design-systems/brand-1'));
    expect(read).toBeTruthy();
    expect(read?.init?.headers).toBeUndefined();
    expect(calls.some((c) => c.url.endsWith('/api/workspace/directory'))).toBe(false);

    expect(result.contents[0]?.mimeType).toBe('text/markdown');
    expect(result.contents[0]?.text).toContain('palette: indigo/violet');
  });

  it('read_resource still serves the brief app resource without touching the daemon', async () => {
    const fetchMock = vi.fn(async () => new Response('should-not-be-called', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await _readMcpResource(target(), OPEN_DESIGN_BRIEF_APP_RESOURCE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('read_resource rejects unsupported URIs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    await expect(
      _readMcpResource(target(), 'od://unknown/foo/bar'),
    ).rejects.toThrow(/unsupported resource URI/u);
  });
});
