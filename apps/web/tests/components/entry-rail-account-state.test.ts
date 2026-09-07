import { describe, expect, it } from 'vitest';

import {
  resolveEntryRailAccountFooterState,
} from '../../src/components/entry-rail-account-state';
import type { WorkspaceContextState } from '../../src/collab/useWorkspaceContext';

const SIGNED_IN_CONTEXT = {
  workspaceId: 'workspace-1',
} as WorkspaceContextState['context'];

describe('resolveEntryRailAccountFooterState', () => {
  it('keeps the resolved account row when a workspace context exists', () => {
    expect(resolveEntryRailAccountFooterState({
      context: SIGNED_IN_CONTEXT,
      loading: false,
      failure: 'unavailable',
    })).toBe('hidden');
  });

  it('shows the neutral syncing state while the workspace identity is loading', () => {
    expect(resolveEntryRailAccountFooterState({
      context: null,
      loading: true,
    })).toBe('syncing');
  });

  it('shows automatic recovery while Workspace authority is unavailable', () => {
    expect(resolveEntryRailAccountFooterState({
      context: null,
      loading: false,
      failure: 'unavailable',
    })).toBe('recovering');
  });

  it('offers the existing sign-in card when authoritative auth has expired', () => {
    expect(resolveEntryRailAccountFooterState({
      context: null,
      loading: false,
      failure: 'reauth-required',
    })).toBe('sign-in');
  });

  it('does not keep a stale cached account row above the sign-in card after auth expires', () => {
    expect(resolveEntryRailAccountFooterState({
      context: SIGNED_IN_CONTEXT,
      loading: false,
      failure: 'reauth-required',
    })).toBe('sign-in');
  });

  it('accepts the next successful null response as authoritative sign-out', () => {
    expect(resolveEntryRailAccountFooterState({
      context: null,
      loading: false,
    })).toBe('sign-in');
  });

  it('preserves the legacy unsupported-daemon behavior', () => {
    expect(resolveEntryRailAccountFooterState({
      context: null,
      loading: false,
      failure: 'unsupported',
    })).toBe('sign-in');
  });
});
