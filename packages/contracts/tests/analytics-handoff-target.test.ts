import { describe, expect, it } from 'vitest';

import {
  TRACKING_HANDOFF_TARGET_IDS,
  handoffTargetIdToTracking,
} from '../src/analytics/events/ui-click.js';

describe('handoff target tracking', () => {
  it('keeps shipped handoff targets bounded without the retired AMR runtime', () => {
    expect(TRACKING_HANDOFF_TARGET_IDS).not.toContain('amr');
    expect(handoffTargetIdToTracking('amr')).toBe('other');
    expect(handoffTargetIdToTracking('codex')).toBe('codex');
  });
});
