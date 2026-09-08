// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/state/projects')>()),
  listPlugins: vi.fn(),
  applyPlugin: vi.fn(),
}));

import { InlinePluginsRail } from '../../src/components/InlinePluginsRail';
import { applyPlugin, listPlugins } from '../../src/state/projects';

function plugin(title: string): InstalledPluginRecord {
  return {
    id: 'same-plugin',
    title,
    version: '1.0.0',
    trust: 'restricted',
    sourceKind: 'local',
    source: `/tmp/${title}`,
    capabilitiesGranted: [],
    manifest: { name: 'same-plugin', title, version: '1.0.0', description: title },
    fsPath: `/tmp/${title}`,
    installedAt: 0,
    updatedAt: 0,
  } as InstalledPluginRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('InlinePluginsRail daemon-local catalog', () => {
  beforeEach(() => {
    vi.mocked(listPlugins).mockResolvedValue([]);
    vi.mocked(applyPlugin).mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps a late catalog response from replacing a newer filtered read', async () => {
    const older = deferred<InstalledPluginRecord[]>();
    const newer = deferred<InstalledPluginRecord[]>();
    vi.mocked(listPlugins)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const view = render(<InlinePluginsRail filter={{ mode: 'deck' }} onApplied={vi.fn()} />);
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(1));

    view.rerender(<InlinePluginsRail filter={{ mode: 'prototype' }} onApplied={vi.fn()} />);
    await waitFor(() => expect(listPlugins).toHaveBeenCalledTimes(2));

    const newerPlugin = plugin('Newer');
    newerPlugin.manifest.od = { mode: 'prototype' };
    await act(async () => newer.resolve([newerPlugin]));
    expect(await screen.findByTitle('Newer')).toBeTruthy();
    const olderPlugin = plugin('Older');
    olderPlugin.manifest.od = { mode: 'deck' };
    await act(async () => older.resolve([olderPlugin]));
    expect(screen.queryByTitle('Older')).toBeNull();
  });

  it('applies a local plugin without Workspace authority', async () => {
    vi.mocked(listPlugins).mockResolvedValue([plugin('Plugin A')]);
    vi.mocked(applyPlugin).mockResolvedValue({ ok: true } as never);
    const onApplied = vi.fn();
    render(<InlinePluginsRail projectId="project-1" onApplied={onApplied} />);

    fireEvent.click(await screen.findByTitle('Plugin A'));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(applyPlugin).toHaveBeenCalledWith('same-plugin', {
      projectId: 'project-1',
      locale: 'en',
    });
  });
});
