// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
}));

import { useBrandExtract } from '../src/runtime/useBrandExtract';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useBrandExtract local request', () => {
  it('starts extraction without retired Workspace identity headers', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'brand-1',
          projectId: 'brand-project-1',
          conversationId: 'conversation-1',
          sourceUrl: 'https://example.com',
          status: 'extracting',
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch);
    const { result } = renderHook(() => useBrandExtract());

    await act(async () => {
      await result.current.run('https://example.com');
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/brands');
    expect(calls[0]?.headers.get('x-od-workspace-id')).toBeNull();
    expect(calls[0]?.headers.get('x-od-workspace-member-id')).toBeNull();
  });
});
