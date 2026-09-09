// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';

import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/analytics/provider')>()),
  useAnalytics: () => ({ track: vi.fn() }),
}));

const USER_PLUGIN: InstalledPluginRecord = {
  id: 'user-plugin',
  title: 'User Plugin',
  version: '1.0.0',
  sourceKind: 'github',
  source: 'github:example/user-plugin',
  trust: 'restricted',
  capabilitiesGranted: [],
  manifest: {
    name: 'user-plugin',
    version: '1.0.0',
    title: 'User Plugin',
    od: { kind: 'scenario', mode: 'prototype' },
  },
  fsPath: '/tmp/user-plugin',
  installedAt: 1,
  updatedAt: 1,
};

const MARKETPLACE = {
  id: 'official',
  url: 'https://example.test/marketplace.json',
  trust: 'official',
  manifest: {
    name: 'Official',
    plugins: [
      {
        name: 'available-plugin',
        title: 'Available Plugin',
        source: 'github:example/available-plugin',
        version: '1.0.0',
      },
    ],
  },
};

let mutationRequests: Array<{ url: string; headers: Headers }>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installSuccess(): Response {
  const payload = `event: success\ndata: ${JSON.stringify({
    kind: 'success',
    plugin: { ...USER_PLUGIN, id: 'available-plugin', title: 'Available Plugin' },
  })}\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  mutationRequests = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/plugins/install') {
      mutationRequests.push({ url, headers: new Headers(init?.headers) });
      return installSuccess();
    }
    if (url === '/api/plugins/user-plugin/uninstall') {
      mutationRequests.push({ url, headers: new Headers(init?.headers) });
      return jsonResponse({ ok: true });
    }
    if (url === '/api/plugins') return jsonResponse({ plugins: [USER_PLUGIN] });
    if (url === '/api/skills') return jsonResponse({ skills: [] });
    if (url === '/api/marketplaces') return jsonResponse({ marketplaces: [MARKETPLACE] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderMarketplace() {
  return render(
    <I18nProvider initial="en">
      <ExtensionsMarketplace onUsePlugin={vi.fn()} />
    </I18nProvider>,
  );
}

function expectNoWorkspaceHeaders(actual: Headers): void {
  expect(actual.has('x-od-workspace-id')).toBe(false);
  expect(actual.has('x-od-workspace-member-id')).toBe(false);
}

describe('ExtensionsMarketplace daemon-local plugin mutations', () => {
  it('does not send Workspace headers when installing', async () => {
    renderMarketplace();

    const install = await screen.findByRole('button', { name: 'Install' });
    fireEvent.click(install);

    await waitFor(() => expect(mutationRequests).toHaveLength(1));
    expect(mutationRequests[0]?.url).toBe('/api/plugins/install');
    expectNoWorkspaceHeaders(mutationRequests[0]!.headers);
  });

  it('does not send Workspace headers when uninstalling', async () => {
    renderMarketplace();

    fireEvent.click(await screen.findByTestId('plugins-tab-installed'));
    fireEvent.click(await screen.findByTestId('plugins-card-more-user-plugin'));
    const uninstall = await screen.findByTestId('plugins-card-uninstall-user-plugin');
    fireEvent.click(uninstall);
    fireEvent.click(uninstall);

    await waitFor(() => expect(mutationRequests).toHaveLength(1));
    expect(mutationRequests[0]?.url).toBe('/api/plugins/user-plugin/uninstall');
    expectNoWorkspaceHeaders(mutationRequests[0]!.headers);
  });

  it('keeps visible plugin install and uninstall actions enabled', async () => {
    renderMarketplace();
    const install = await screen.findByRole('button', { name: 'Install' }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
    fireEvent.click(await screen.findByTestId('plugins-tab-installed'));
    fireEvent.click(await screen.findByTestId('plugins-card-more-user-plugin'));
    const uninstall = await screen.findByTestId(
      'plugins-card-uninstall-user-plugin',
    ) as HTMLButtonElement;

    expect(uninstall.disabled).toBe(false);
    expect(mutationRequests).toEqual([]);
  });
});
