import { describe, expect, it, vi } from 'vitest';
import { createCollabRuntime } from '../src/collab/runtime.js';

describe('collab runtime — member pull materialized version', () => {
  it('returns the version reported by the pull instead of a newer post-pull head', async () => {
    const syncLatest = vi.fn(async () => ({ version: 2 }));
    const runtime = createCollabRuntime({
      adapter: {
        publish: async () => null,
        pull: async () => ({ version: 1, versionId: 'v1' }),
        syncLatest,
      },
    });

    try {
      await expect(runtime.pullLatest('shared-project')).resolves.toEqual({ version: 1 });
      expect(syncLatest).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });
});
