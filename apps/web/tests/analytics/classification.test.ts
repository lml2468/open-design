import { describe, expect, it } from 'vitest';

import {
  countBucket,
  stableAnalyticsErrorCode,
  stableAnalyticsRequestErrorCode,
} from '../../src/analytics/classification';

describe('analytics helpers', () => {
  it('uses bounded buckets and stable error classes', () => {
    expect([0, 1, 2, 5, 6, 10, 11].map(countBucket)).toEqual([
      '0',
      '1',
      '2_5',
      '2_5',
      '6_10',
      '6_10',
      '11_plus',
    ]);
    expect(stableAnalyticsErrorCode(403)).toBe('forbidden');
    expect(stableAnalyticsErrorCode(503)).toBe('server_error');
    expect(stableAnalyticsErrorCode()).toBe('network_error');
    expect(stableAnalyticsRequestErrorCode({ code: 'network_error' })).toBe('network_error');
    expect(stableAnalyticsRequestErrorCode({ code: 'UPSTREAM_UNAVAILABLE', status: 503 }))
      .toBe('UPSTREAM_UNAVAILABLE');
    expect(stableAnalyticsRequestErrorCode({ status: 404 })).toBe('not_found');
    expect(stableAnalyticsRequestErrorCode({ code: 'bad code / project-name' }))
      .toBe('request_failed');
    expect(stableAnalyticsRequestErrorCode({ code: 'UPSTREAM_abc123', status: 503 }))
      .toBe('server_error');
  });
});
