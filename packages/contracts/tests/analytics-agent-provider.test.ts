import { describe, expect, it } from 'vitest';

import {
  agentIdToTracking,
  feedbackAgentProviderIdToTracking,
} from '../src/analytics/events.js';

describe('agentIdToTracking', () => {
  it('keeps mapping known CLI agents and falls back to other for unknowns', () => {
    expect(agentIdToTracking('claude')).toBe('claude_code');
    expect(agentIdToTracking('opencode')).toBe('opencode');
    expect(agentIdToTracking('totally-unknown-agent')).toBe('other');
    expect(agentIdToTracking(null)).toBe('other');
    expect(agentIdToTracking(undefined)).toBe('other');
  });

  it('routes unknown feedback providers through the generic bucket', () => {
    expect(feedbackAgentProviderIdToTracking('unknown-agent')).toBe('other');
  });
});
