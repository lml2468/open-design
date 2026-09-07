import { describe, expect, it, vi } from 'vitest';
import type { HubEventsSubscriber } from '../../src/collab/hub-events-subscriber.js';
import { createWorkspaceHubSubscriptionManager } from '../../src/collab/workspace-hub-subscriptions.js';

describe('WorkspaceHubSubscriptionManager', () => {
  it('keeps one upstream carrier for each referenced local event stream', () => {
    const stop = vi.fn();
    const manager = createWorkspaceHubSubscriptionManager({
      start: (): HubEventsSubscriber => ({
        connected: () => true,
        refreshEndpoint: vi.fn(),
        stop,
      }),
    });

    const releaseFirst = manager.retainEventInterest('workspace-a');
    const releaseSecond = manager.retainEventInterest('workspace-a');
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-a']);

    releaseFirst();
    releaseFirst();
    expect(stop).not.toHaveBeenCalled();
    releaseSecond();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.activeWorkspaceIds()).toEqual([]);
  });

  it('re-resolves every active stream when the account credential changes', () => {
    const refreshEndpoint = vi.fn();
    const manager = createWorkspaceHubSubscriptionManager({
      start: () => ({
        stop: vi.fn(),
        connected: () => true,
        refreshEndpoint,
      }),
    });
    manager.retainEventInterest('workspace-a');
    manager.retainEventInterest('workspace-b');

    manager.refreshEndpoints();

    expect(refreshEndpoint).toHaveBeenCalledTimes(2);
  });

  it('stops a workspace immediately after its final reason is revoked', () => {
    const stop = vi.fn();
    const manager = createWorkspaceHubSubscriptionManager({
      start: (): HubEventsSubscriber => ({
        connected: () => false,
        refreshEndpoint: vi.fn(),
        stop,
      }),
    });
    const release = manager.retainEventInterest('workspace-a');
    release();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.activeWorkspaceIds()).toEqual([]);
    manager.dispose();
  });

  it('caps live upstream SSE connections without consulting ambient selection', () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const manager = createWorkspaceHubSubscriptionManager({
      maxSubscribers: 2,
      start: (workspaceId): HubEventsSubscriber => {
        started.push(workspaceId);
        return {
          connected: () => true,
          refreshEndpoint: vi.fn(),
          stop: () => stopped.push(workspaceId),
        };
      },
    });

    manager.retainEventInterest('workspace-a');
    manager.retainEventInterest('workspace-b');
    manager.retainEventInterest('workspace-c');
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-a', 'workspace-b']);
    expect(started).toEqual(['workspace-a', 'workspace-b']);
    expect(stopped).toEqual([]);
    manager.dispose();
  });
});
