import { describe, expect, it } from 'vitest';

import { createSwrCache } from '../src/collab/swr-cache.js';

// Legacy Team Project status reads are expensive because each uncached read
// spawns `vela team-projects list` and waits for a round trip to the API.
//
// Freshness does not depend on the TTL alone: the cache is explicitly
// invalidated on share, unshare, and workspace change, so an unshare is still
// visible immediately to the remaining status and synchronization callers.
//
// This spec pins the two properties the display path needs from that cache.
describe('team-projects display cache behaviour', () => {
  it('serves repeat display reads within the freshness window from one upstream call', async () => {
    let upstreamCalls = 0;
    const cache = createSwrCache(
      async () => {
        upstreamCalls += 1;
        return [{ projectId: 'p-1' }];
      },
      () => 'scope-a',
      3000,
    );

    await cache();
    await cache();
    await cache();

    // Without the cache this is 3 spawns of `vela team-projects list`, i.e.
    // ~3.3s of round trips for one screen.
    expect(upstreamCalls).toBe(1);
  });

  it('re-reads upstream after an explicit invalidation, so an unshare is not hidden', async () => {
    let upstreamCalls = 0;
    const cache = createSwrCache(
      async () => {
        upstreamCalls += 1;
        return [{ projectId: 'p-1' }];
      },
      () => 'scope-a',
      3000,
    );

    await cache();
    expect(upstreamCalls).toBe(1);

    // share / unshare / workspace-change all call this in server.ts.
    cache.invalidate();
    await cache();

    expect(upstreamCalls).toBe(2);
  });

  it('never shares an entry across scopes', async () => {
    // A workspace switch must not be served another workspace's catalog.
    const seen: string[] = [];
    let scope = 'scope-a';
    const cache = createSwrCache(
      async () => {
        seen.push(scope);
        return [{ projectId: scope }];
      },
      () => scope,
      3000,
    );

    await cache();
    scope = 'scope-b';
    await cache();

    expect(seen).toEqual(['scope-a', 'scope-b']);
  });
});
