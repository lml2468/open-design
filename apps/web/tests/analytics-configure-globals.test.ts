// Regression coverage for the globally registered execution configuration.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveConfigureGlobals,
  type DeriveConfigureGlobalsInput,
} from '@open-design/contracts/analytics';
import {
  getConfigureGlobals,
  setConfigureGlobals,
} from '../src/analytics/client';

const BOOT_DEFAULTS = {
  has_available_configure_cli: false,
  configure_type: 'unknown' as const,
  configure_availability: 'unknown' as const,
  runtime_type: 'none' as const,
  cli_runnable: false,
  byok_runnable: false,
};

describe('deriveConfigureGlobals', () => {
  it('returns none and unknown when nothing is configured', () => {
    expect(deriveConfigureGlobals({})).toEqual({
      has_available_configure_cli: false,
      configure_type: 'none',
      configure_availability: 'unknown',
      runtime_type: 'none',
      cli_runnable: false,
      byok_runnable: false,
    });
  });

  it('reports the selected installed CLI in daemon mode', () => {
    const input: DeriveConfigureGlobalsInput = {
      mode: 'daemon',
      agentId: 'claude',
      agents: [
        { id: 'claude', available: true },
        { id: 'codex', available: false },
      ],
    };
    expect(deriveConfigureGlobals(input)).toEqual({
      has_available_configure_cli: true,
      configure_type: 'local_cli',
      configure_availability: 'available',
      runtime_type: 'local_cli',
      cli_runnable: true,
      byok_runnable: false,
    });
  });

  it('reports a missing selected CLI as unavailable even when a peer is installed', () => {
    expect(deriveConfigureGlobals({
      mode: 'daemon',
      agentId: 'codex',
      agents: [
        { id: 'claude', available: true },
        { id: 'codex', available: false },
      ],
    })).toEqual({
      has_available_configure_cli: true,
      configure_type: 'local_cli',
      configure_availability: 'unavailable',
      runtime_type: 'local_cli',
      cli_runnable: true,
      byok_runnable: false,
    });
  });

  it('reports BYOK and the independent runnable flag in api mode', () => {
    expect(deriveConfigureGlobals({
      mode: 'api',
      byokConfigured: true,
      agents: [],
    })).toEqual({
      has_available_configure_cli: false,
      configure_type: 'byok',
      configure_availability: 'available',
      runtime_type: 'byok',
      cli_runnable: false,
      byok_runnable: true,
    });
  });

  it('reports both capabilities while keeping the selected runtime singular', () => {
    expect(deriveConfigureGlobals({
      mode: 'daemon',
      agentId: 'claude',
      agents: [{ id: 'claude', available: true }],
      byokConfigured: true,
    })).toEqual({
      has_available_configure_cli: true,
      configure_type: 'both',
      configure_availability: 'available',
      runtime_type: 'local_cli',
      cli_runnable: true,
      byok_runnable: true,
    });
  });
});

describe('setConfigureGlobals', () => {
  beforeEach(() => setConfigureGlobals(BOOT_DEFAULTS));
  afterEach(() => setConfigureGlobals(BOOT_DEFAULTS));

  it('stores the latest configure state', () => {
    const next = {
      has_available_configure_cli: true,
      configure_type: 'both' as const,
      configure_availability: 'available' as const,
      runtime_type: 'local_cli' as const,
      cli_runnable: true,
      byok_runnable: true,
    };
    setConfigureGlobals(next);
    expect(getConfigureGlobals()).toEqual(next);
  });

  it('never throws before PostHog initializes', () => {
    expect(() => setConfigureGlobals(BOOT_DEFAULTS)).not.toThrow();
  });
});
