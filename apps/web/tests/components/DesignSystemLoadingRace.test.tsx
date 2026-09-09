// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignSystemPreviewModal } from '../../src/components/DesignSystemPreviewModal';
import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import { I18nProvider } from '../../src/i18n';
import type { DesignSystemDetail, DesignSystemSummary } from '../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const registryMocks = vi.hoisted(() => ({
  fetchDesignSystem: vi.fn(),
  fetchDesignSystemPreview: vi.fn(),
  fetchDesignSystemShowcase: vi.fn(),
  fetchProjectFileText: vi.fn(),
  updateDesignSystemDraft: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystem: registryMocks.fetchDesignSystem,
    fetchDesignSystemPreview: registryMocks.fetchDesignSystemPreview,
    fetchDesignSystemShowcase: registryMocks.fetchDesignSystemShowcase,
    fetchProjectFileText: registryMocks.fetchProjectFileText,
    updateDesignSystemDraft: registryMocks.updateDesignSystemDraft,
    deleteDesignSystemDraft: vi.fn(async () => true),
    projectRawUrl: (projectId: string, filePath: string) => `/raw/${projectId}/${filePath}`,
  };
});

const SYSTEM_A: DesignSystemSummary = {
  id: 'user:system-a',
  title: 'System A',
  summary: 'First local system',
  category: 'Custom',
  source: 'user',
  status: 'draft',
  isEditable: true,
  projectId: 'project-a',
};

const SYSTEM_B: DesignSystemSummary = {
  ...SYSTEM_A,
  id: 'user:system-b',
  title: 'System B',
  summary: 'Second local system',
  projectId: 'project-b',
};

function renderModal(system: DesignSystemSummary, initialViewId: 'kit' | 'showcase' | 'tokens' = 'kit') {
  return render(
    <I18nProvider initial="en">
      <DesignSystemPreviewModal
        system={system}
        initialViewId={initialViewId}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  registryMocks.fetchDesignSystem.mockReset();
  registryMocks.fetchDesignSystemPreview.mockReset();
  registryMocks.fetchDesignSystemShowcase.mockReset();
  registryMocks.fetchProjectFileText.mockReset();
  registryMocks.updateDesignSystemDraft.mockReset();
  registryMocks.fetchProjectFileText.mockResolvedValue(null);
  registryMocks.updateDesignSystemDraft.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('design-system local loading races', () => {
  it('ignores a late detail response after the selected system changes', async () => {
    const pendingA = deferred<DesignSystemDetail | null>();
    registryMocks.fetchDesignSystem.mockImplementation((id: string) =>
      id === SYSTEM_A.id
        ? pendingA.promise
        : Promise.resolve({ ...SYSTEM_B, body: '# System B\n\nB detail won' }),
    );

    const view = renderModal(SYSTEM_A);
    await waitFor(() => expect(registryMocks.fetchDesignSystem).toHaveBeenCalledWith(SYSTEM_A.id));

    view.rerender(
      <I18nProvider initial="en">
        <DesignSystemPreviewModal system={SYSTEM_B} onClose={() => {}} />
      </I18nProvider>,
    );
    await screen.findByText('B detail won');

    await act(async () => {
      pendingA.resolve({ ...SYSTEM_A, body: '# System A\n\nA detail arrived late' });
      await pendingA.promise;
    });

    expect(screen.getAllByText('B detail won').length).toBeGreaterThan(0);
    expect(screen.queryByText('A detail arrived late')).toBeNull();
  });

  it.each([
    ['showcase', registryMocks.fetchDesignSystemShowcase],
    ['tokens', registryMocks.fetchDesignSystemPreview],
  ] as const)('ignores a late %s response from the previous system', async (viewId, fetchLazy) => {
    const pendingA = deferred<string | null>();
    registryMocks.fetchDesignSystem.mockImplementation((id: string) =>
      Promise.resolve({ ...(id === SYSTEM_A.id ? SYSTEM_A : SYSTEM_B), body: '# Stable detail' }),
    );
    fetchLazy.mockImplementation((id: string) =>
      id === SYSTEM_A.id
        ? pendingA.promise
        : Promise.resolve(`<!doctype html><p>${viewId} system B</p>`),
    );

    const view = renderModal(SYSTEM_A, viewId);
    await waitFor(() => expect(fetchLazy).toHaveBeenCalledWith(SYSTEM_A.id));

    view.rerender(
      <I18nProvider initial="en">
        <DesignSystemPreviewModal
          system={SYSTEM_B}
          initialViewId={viewId}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain(`${viewId} system B`);
    });

    await act(async () => {
      pendingA.resolve(`<!doctype html><p>${viewId} system A late</p>`);
      await pendingA.promise;
    });
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain(`${viewId} system B`);
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('system A late');
  });

  it('keeps design-system mutations and reads daemon-local', async () => {
    registryMocks.fetchDesignSystem.mockResolvedValue({ ...SYSTEM_A, body: '# Local detail' });

    render(
      <I18nProvider initial="en">
        <DesignSystemsTab
          systems={[SYSTEM_A]}
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenSystem={() => {}}
        />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));

    expect(registryMocks.updateDesignSystemDraft).toHaveBeenCalledWith(
      SYSTEM_A.id,
      { status: 'published' },
    );
    expect(registryMocks.fetchDesignSystem).toHaveBeenCalledWith(SYSTEM_A.id);
  });
});
