// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EntryNavRail,
  ProjectTopRightControls,
} from '../../src/components/EntryNavRail';
import { UpdaterPopup } from '../../src/components/UpdaterPopup';
import { I18nProvider } from '../../src/i18n';

function idleStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '0.16.2-beta.145',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
  };
}

function downloadedStatus(): OpenDesignHostUpdaterStatusSnapshot {
  return {
    ...idleStatus(),
    availableVersion: '0.16.2-beta.146',
    downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
    state: 'downloaded',
  };
}

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ stargazers_count: 40_000 })),
  );
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local top-right controls', () => {
  it('mounts project controls without a cloud identity or account menu', async () => {
    render(
      <I18nProvider initial="zh-CN">
        <ProjectTopRightControls
          updaterSlot={<span data-testid="project-updater-slot-content" />}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('entry-top-right-github')).toBeTruthy();
    expect(screen.getByTestId('project-updater-slot-content')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('entry-nav-updater-host')).toBeTruthy());
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
  });

  it('renders a downloaded updater in the entry top-right cluster', async () => {
    restoreHost = installMockOpenDesignHost({
      host: { updater: { status: vi.fn(async () => downloadedStatus()) } },
    });
    render(
      <I18nProvider initial="zh-CN">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          updaterSlot={<UpdaterPopup />}
        />
      </I18nProvider>,
    );

    const rocket = await screen.findByTestId('entry-nav-updater');
    expect(rocket.closest('.entry-top-right-cluster')).not.toBeNull();
    expect(rocket.closest('.entry-nav-rail__footer')).toBeNull();
    expect(screen.queryByTestId('entry-nav-account')).toBeNull();
  });

  it('keeps the GitHub control visible while the updater is idle', async () => {
    restoreHost = installMockOpenDesignHost({
      host: { updater: { status: vi.fn(async () => idleStatus()) } },
    });
    render(
      <I18nProvider initial="zh-CN">
        <EntryNavRail
          view="home"
          onViewChange={() => {}}
          onNewProject={() => {}}
          open
          updaterSlot={<UpdaterPopup />}
        />
      </I18nProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('entry-top-right-github')).toBeTruthy();
    expect(screen.queryByTestId('entry-nav-updater')).toBeNull();
    expect(screen.queryByTestId('entry-nav-updater-host')).toBeNull();
  });
});
