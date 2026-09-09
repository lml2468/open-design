// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DesignSystemSummary, WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  syncComposioConfigToDaemon,
  syncConfigToDaemon,
} from '../../src/state/config';
import { listProjects, listTemplates } from '../../src/state/projects';
import type { AppConfig } from '../../src/types';
import {
  notifyWorkspaceContextRefresh,
  resetWorkspaceContextCache,
} from '../../src/collab/useWorkspaceContext';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';
import { workspaceDirectoryFixture } from '../helpers/workspace-context';

vi.mock('../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/router')>()),
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'design-systems' as const }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    designSystems,
    designSystemsLoading,
  }: {
    designSystems: DesignSystemSummary[];
    designSystemsLoading?: boolean;
  }) => (
    <div
      data-testid="design-systems-state"
      data-loading={designSystemsLoading ? 'true' : 'false'}
    >
      {designSystems.map((system) => (
        <span key={system.id}>{system.title}</span>
      ))}
    </div>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn(),
    syncConfigToDaemon: vi.fn(),
  };
});

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  privacyDecisionAt: 1778244000000,
  mediaProviders: {},
  composio: {},
  agentModels: {},
  agentCliEnv: {},
};

const readySystem: DesignSystemSummary = {
  id: 'user:ready',
  title: 'Ready design system',
  category: 'Custom',
  summary: 'Loaded from the successful workspace-scoped request.',
  surface: 'web',
  source: 'user',
  status: 'published',
  isEditable: true,
};

function workspaceContext(workspaceId: string): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceType: 'team',
    workspaceMemberId: `member-${workspaceId}`,
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: false,
      canManageSharedResources: false,
    },
    displayName: workspaceId,
  };
}

function designSystem(id: string): DesignSystemSummary {
  return {
    ...readySystem,
    id,
    title: id,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetWorkspaceContextCache();
  resetCoalescedGet();
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgentsStream).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listTemplates).mockResolvedValue([]);
  vi.mocked(fetchDaemonConfig).mockResolvedValue({});
  vi.mocked(fetchComposioConfigFromDaemon).mockResolvedValue(null);
  vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
  vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  vi.mocked(syncConfigToDaemon).mockResolvedValue(undefined);
  vi.mocked(syncComposioConfigToDaemon).mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetWorkspaceContextCache();
  resetCoalescedGet();
});

describe('App design-system catalog loading race', () => {
  it('waits for the newest concurrent initial catalog request and ignores an older success', async () => {
    const newest = deferred<DesignSystemSummary[]>();
    vi.mocked(fetchDesignSystems)
      // The first request is stale once bootstrap starts its same-identity
      // successor, so its result must not flash before the newest read lands.
      .mockResolvedValueOnce([readySystem])
      .mockReturnValue(newest.promise);

    render(<App />);

    await waitFor(() => {
      expect(vi.mocked(fetchDesignSystems).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText('Ready design system')).toBeNull();
    expect(screen.getByTestId('design-systems-state').dataset.loading).toBe('true');

    await act(async () => {
      newest.resolve([designSystem('newest-design-system')]);
      await newest.promise;
    });
    await waitFor(() => expect(screen.getByText('newest-design-system')).toBeTruthy());
    expect(screen.getByTestId('design-systems-state').dataset.loading).toBe('false');
  });

  it('keeps the daemon-local catalog visible across Workspace identity changes', async () => {
    let activeContext = workspaceContext('ws-a');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input), 'http://d.local').pathname;
        return {
          ok: true,
          json: async () => pathname.endsWith('/workspace/context')
            ? { context: activeContext }
            : {},
        } as Response;
      }),
    );
    vi.mocked(fetchDesignSystems).mockResolvedValue([
      designSystem('daemon-local-system'),
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('daemon-local-system')).toBeTruthy());
    const readsBeforeSwitch = vi.mocked(fetchDesignSystems).mock.calls.length;

    activeContext = workspaceContext('ws-b');
    await act(async () => {
      notifyWorkspaceContextRefresh({ context: activeContext });
      await Promise.resolve();
    });

    expect(screen.getByText('daemon-local-system')).toBeTruthy();
    expect(screen.getByTestId('design-systems-state').dataset.loading).toBe('false');
    expect(vi.mocked(fetchDesignSystems)).toHaveBeenCalledTimes(readsBeforeSwitch);
  });

});
