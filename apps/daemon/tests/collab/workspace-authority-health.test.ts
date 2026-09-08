import { describe, expect, it } from 'vitest';

import { resolveWorkspaceAuthorityCacheMode } from '../../src/collab/workspace-authority-health.js';

describe('workspace authority cache mode', () => {
  it('defaults absent modes to adaptive while unknown values use the legacy kill switch', () => {
    expect(resolveWorkspaceAuthorityCacheMode(undefined)).toBe('adaptive');
    expect(resolveWorkspaceAuthorityCacheMode('  ')).toBe('adaptive');
    expect(resolveWorkspaceAuthorityCacheMode('unexpected')).toBe('legacy');
    expect(resolveWorkspaceAuthorityCacheMode(' OBSERVE ')).toBe('observe');
    expect(resolveWorkspaceAuthorityCacheMode('adaptive')).toBe('adaptive');
  });
});
