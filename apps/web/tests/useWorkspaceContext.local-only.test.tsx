// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyWorkspaceContextRefresh,
  resetWorkspaceContextCache,
  useWorkspaceContext,
} from '../src/collab/useWorkspaceContext';

describe('useWorkspaceContext local-only compatibility', () => {
  afterEach(() => {
    resetWorkspaceContextCache();
    vi.unstubAllGlobals();
  });

  it('settles to local Project mode without requesting retired Workspace APIs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hook = renderHook(() => useWorkspaceContext());

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current).toMatchObject({
      context: null,
      resourceReadIdentity: null,
      identityChangePending: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps sign-in refreshes local and network-free', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hook = renderHook(() => useWorkspaceContext());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => notifyWorkspaceContextRefresh());

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.context).toBeNull();
    expect(hook.result.current.resourceReadIdentity).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
