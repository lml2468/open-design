// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@open-design/host', () => ({
  isOpenDesignHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
}));

import { pickAndImportHostProject } from '@open-design/host';
import { useOpenFolderImport } from '../../src/components/useOpenFolderImport';

afterEach(() => {
  cleanup();
  vi.mocked(pickAndImportHostProject).mockReset();
});

describe('useOpenFolderImport', () => {
  it('imports through the host without subscribing to Workspace authority', async () => {
    const response = {
      conversationId: 'conversation-host',
      entryFile: 'index.html',
      ok: true,
      projectId: 'project-host',
    } as const;
    vi.mocked(pickAndImportHostProject).mockResolvedValue(response);
    const onImportFolderResponse = vi.fn();
    const hook = renderHook(() => useOpenFolderImport({
      skillId: 'prototype-skill',
      onImportFolderResponse,
    }));

    await act(async () => {
      await hook.result.current.openFolder();
    });

    expect(pickAndImportHostProject).toHaveBeenCalledWith({
      skillId: 'prototype-skill',
    });
    expect(onImportFolderResponse).toHaveBeenCalledWith(response);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.importing).toBe(false);
  });
});
