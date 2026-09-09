import { describe, expect, it } from 'vitest';

import {
  TRACKING_HANDOFF_TARGET_IDS,
  handoffTargetIdToTracking,
} from '../src/analytics/events/ui-click.js';

describe('handoff target tracking', () => {
  it('keeps shipped handoff targets bounded and maps unknown runtimes to other', () => {
    expect(handoffTargetIdToTracking('unsupported-runtime')).toBe('other');
    expect(handoffTargetIdToTracking('codex')).toBe('codex');
  });
});
